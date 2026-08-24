"""The shared MCP client pool: `McpPool`.

Port of the tool-execution and bookkeeping half of `src/mcpClient.ts`
(`McpClientManager`), with one deliberate lifecycle change from the TS (see
PLAN.md's "MCP lifecycle" decision):

    Lazy connect, then keep alive. `start()` connects to every configured
    server once, lists its tools/prompts/resources/resource templates, and
    disconnects -- so the system prompt is complete without leaving every
    server's process running for a chat that never calls one of its tools. The
    first real tool call for a server reconnects it and that session is then
    kept alive for the rest of the pool's lifetime, reconnecting with capped,
    backed-off retries if it drops.

Left out on purpose, because keep-alive replaces the need for them:

    - The TS's 5-second background `refreshInterval` that re-lists tools for
      every *connected* server on a timer (`startBackgroundRefresh`,
      `refreshAllToolLists`, the `isRefreshing` re-entrancy guard). A session we
      hold open does not need to be polled for its own tool list; the SDK's
      `notifications/tools_list_changed` handling would be the right place to
      pick up a server-initiated change, but that is not implemented here
      either -- out of scope for this pass.
    - `disconnectServerKeepingToolInfo` / the lazy "connect, list, disconnect
      but remember the tools" dance for a server that is *already* connected --
      here a connected server simply stays connected.
    - Per-call teardown. The TS does not tear a connection down after each
      call either, so this is not a divergence, just noting it stays gone.

Tool naming, error-as-string conventions, and the schema-aware parameter
coercion (`coerce_tool_params` et al., ported from `_parseFinalValue` /
`_convertWithPrecedence` / `_schemaAllows` / `_isJsonSchemaType`) are kept
faithful to the TS -- see each function's docstring for exact correspondence.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from collections.abc import Awaitable, Callable, Mapping
from contextlib import AbstractAsyncContextManager, suppress
from dataclasses import dataclass, field
from typing import Any, Protocol

from ..config.model import McpServerConfig
from ..tools.system_tools import execute_system_tool, is_system_tool
from ..types import (
    McpAudioContent,
    McpEmbeddedResource,
    McpImageContent,
    McpPromptMessage,
    McpPromptResult,
    McpReadResourceResult,
    McpRenderableContent,
    McpResource,
    McpResourceContents,
    McpResourceLink,
    McpResourceTemplate,
    McpServerState,
    McpServerStatus,
    McpTextContent,
    McpToolDefinition,
    McpToolExecutionResult,
)
from .transport import connect_session

logger = logging.getLogger(__name__)

#: The TS caps background reconnect retries at 5 so a permanently broken server
#: stops respawning processes forever; we apply the same cap to every reconnect
#: (background or on-demand), since we have no background loop to distinguish them.
DEFAULT_MAX_RECONNECT_ATTEMPTS = 5

#: Backoff between reconnect attempts for one server, capped so a flapping
#: server does not stall a burst of tool calls for too long.
_MAX_BACKOFF_SECONDS = 30.0


class SessionLike(Protocol):
    """The subset of `mcp.ClientSession` the pool actually uses.

    Structural, not nominal: a test can inject any object with these methods
    (see `McpPool`'s `session_connector` constructor parameter) without
    inheriting from this class or from `mcp.ClientSession`.
    """

    async def list_tools(self) -> Any: ...
    async def list_prompts(self) -> Any: ...
    async def list_resources(self) -> Any: ...
    async def list_resource_templates(self) -> Any: ...
    async def call_tool(self, name: str, arguments: dict[str, Any] | None = None) -> Any: ...
    async def read_resource(self, uri: str) -> Any: ...
    async def get_prompt(self, name: str, arguments: dict[str, str] | None = None) -> Any: ...


#: Opens one connection for a server. The pool never constructs `connect_session`
#: directly -- it goes through this hook so tests can substitute a fake session
#: without a real transport. See `McpPool.__init__`.
SessionConnector = Callable[[str, McpServerConfig], AbstractAsyncContextManager[SessionLike]]


@dataclass
class _ServerRuntime:
    """Everything the pool tracks for one configured server."""

    config: McpServerConfig
    state: McpServerState = "not-started"
    #: The live session, only set while `state == "connected"`.
    session: SessionLike | None = None
    #: The open context manager backing `session`, kept so it can be exited later.
    session_cm: AbstractAsyncContextManager[SessionLike] | None = None
    tools: dict[str, McpToolDefinition] = field(default_factory=dict)
    prompt_names: set[str] = field(default_factory=set)
    resources: dict[str, McpResource] = field(default_factory=dict)
    resource_templates: dict[str, McpResourceTemplate] = field(default_factory=dict)
    last_error: str | None = None
    connected_since: float | None = None
    reconnect_attempts: int = 0
    #: Serializes concurrent connect attempts so a burst of tool calls for one
    #: server spawns at most one child process / one session, mirroring the TS
    #: `pendingConnections` map.
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


class McpPool:
    """One shared pool of MCP server connections for the whole process."""

    def __init__(
        self,
        servers: Mapping[str, McpServerConfig],
        *,
        connect_timeout: float = 30.0,
        max_reconnect_attempts: int = DEFAULT_MAX_RECONNECT_ATTEMPTS,
        session_connector: SessionConnector | None = None,
    ) -> None:
        self._max_reconnect_attempts = max_reconnect_attempts
        self._runtime: dict[str, _ServerRuntime] = {
            server_id: _ServerRuntime(config=config) for server_id, config in servers.items()
        }
        # Default connector opens a real transport; tests override this hook to
        # inject a fake `SessionLike` instead of spawning/dialing anything.
        self._connect: SessionConnector = session_connector or (
            lambda server_id, config: connect_session(
                config, connect_timeout=connect_timeout, server_id=server_id
            )
        )

    # -- lifecycle ----------------------------------------------------------- #

    async def start(self) -> None:
        """Connect to every configured server once to list its tools, prompts,
        resources and resource templates, then disconnect.

        One server's failure never aborts another's discovery or `start()`
        itself -- it is recorded as `errored` and retried on its first real use.
        """
        await asyncio.gather(*(self._discover(server_id) for server_id in self._runtime))

    async def aclose(self) -> None:
        """Disconnect every server currently kept alive. Idempotent."""
        for runtime in self._runtime.values():
            await self._close_runtime_session(runtime, next_state="not-started")

    async def _discover(self, server_id: str) -> None:
        runtime = self._runtime[server_id]
        runtime.state = "connecting"
        try:
            async with self._connect(server_id, runtime.config) as session:
                await self._absorb_listing(runtime, session)
        except Exception as exc:  # noqa: BLE001 - one bad server must not abort start()
            runtime.state = "errored"
            runtime.last_error = str(exc)
            logger.warning("MCP server %r failed to initialize: %s", server_id, exc)
            return
        # Listed successfully, then disconnected: ready for a lazy connect on
        # the first real tool call.
        runtime.state = "not-started"
        runtime.last_error = None

    async def _absorb_listing(self, runtime: _ServerRuntime, session: SessionLike) -> None:
        tools_result = await session.list_tools()
        runtime.tools = {
            tool.name: McpToolDefinition(
                name=tool.name,
                description=tool.description,
                input_schema=dict(tool.input_schema or {}),
            )
            for tool in tools_result.tools
        }

        try:
            prompts_result = await session.list_prompts()
            runtime.prompt_names = {prompt.name for prompt in prompts_result.prompts}
        except Exception as exc:  # noqa: BLE001 - prompts are optional per server
            logger.debug("Server does not support prompts: %s", exc)
            runtime.prompt_names = set()

        try:
            resources_result = await session.list_resources()
            runtime.resources = {
                resource.uri: McpResource(
                    uri=resource.uri,
                    name=resource.name,
                    title=resource.title,
                    description=resource.description,
                    mime_type=resource.mime_type,
                    size=resource.size,
                    annotations=resource.annotations,
                )
                for resource in resources_result.resources
            }
        except Exception as exc:  # noqa: BLE001 - resources are optional per server
            logger.debug("Server does not support resources: %s", exc)
            runtime.resources = {}

        try:
            templates_result = await session.list_resource_templates()
            runtime.resource_templates = {
                template.uri_template: McpResourceTemplate(
                    uri_template=template.uri_template,
                    name=template.name,
                    title=template.title,
                    description=template.description,
                    mime_type=template.mime_type,
                    annotations=template.annotations,
                )
                for template in templates_result.resource_templates
            }
        except Exception as exc:  # noqa: BLE001 - resource templates are optional too
            logger.debug("Server does not support resource templates: %s", exc)
            runtime.resource_templates = {}

    # -- connection management ------------------------------------------------ #

    async def _ensure_connected(self, server_id: str) -> SessionLike:
        runtime = self._runtime.get(server_id)
        if runtime is None:
            raise RuntimeError(f'MCP server "{server_id}" is not configured.')

        if runtime.state == "connected" and runtime.session is not None:
            return runtime.session

        async with runtime.lock:
            # Re-check: another caller may have connected while we waited for the lock.
            if runtime.state == "connected" and runtime.session is not None:
                return runtime.session

            if runtime.reconnect_attempts >= self._max_reconnect_attempts:
                raise RuntimeError(
                    f'MCP server "{server_id}" exceeded {self._max_reconnect_attempts} '
                    "connection attempts and will not be retried automatically."
                )

            if runtime.reconnect_attempts > 0:
                backoff = min(2.0**runtime.reconnect_attempts, _MAX_BACKOFF_SECONDS)
                logger.info(
                    "Backing off %.1fs before reconnecting to %r (attempt %d)",
                    backoff,
                    server_id,
                    runtime.reconnect_attempts + 1,
                )
                await asyncio.sleep(backoff)

            runtime.state = "connecting"
            try:
                cm = self._connect(server_id, runtime.config)
                session = await cm.__aenter__()
                await self._absorb_listing(runtime, session)
            except Exception as exc:
                runtime.reconnect_attempts += 1
                runtime.state = "errored"
                runtime.last_error = str(exc)
                raise

            runtime.session = session
            runtime.session_cm = cm
            runtime.state = "connected"
            runtime.connected_since = time.time()
            runtime.last_error = None
            runtime.reconnect_attempts = 0
            return session

    async def _close_runtime_session(
        self, runtime: _ServerRuntime, *, next_state: McpServerState
    ) -> None:
        cm, runtime.session_cm = runtime.session_cm, None
        runtime.session = None
        runtime.state = next_state
        if cm is not None:
            with suppress(Exception):
                await cm.__aexit__(None, None, None)

    async def _rpc(self, server_id: str, runtime: _ServerRuntime, call: Awaitable[Any]) -> Any:
        """Run one request on a kept-alive session, dropping it on failure.

        `CallToolResult.is_error` carries genuine tool-level errors without
        raising, so anything that *does* raise here is a transport failure, not
        a tool failure -- the session is discarded so the next call reconnects
        (with backoff) instead of reusing a session that is probably dead.
        """
        try:
            return await call
        except Exception:
            logger.warning("MCP session for %r failed; will reconnect on next use", server_id)
            await self._close_runtime_session(runtime, next_state="errored")
            raise

    # -- tool execution -------------------------------------------------------- #

    async def call(
        self, full_name: str, params: Mapping[str, str]
    ) -> McpToolExecutionResult | str:
        """Execute one tool call, splitting `full_name` on the FIRST dot.

        Errors are returned as strings for the cases the TS returns strings for
        (unknown server, unknown tool, connection failure); a genuine tool error
        comes back as an `McpToolExecutionResult` with `is_error=True`. Nothing
        here raises, so a failure can never crash the caller's agentic loop.
        """
        if is_system_tool(full_name):
            return await execute_system_tool(full_name, dict(params), self.read_resource)

        dot = full_name.find(".")
        if dot <= 0 or dot >= len(full_name) - 1:
            # No (usable) dot: fall back to searching every server's tool map
            # for this exact name, as the TS `executeToolCallLegacyFallback` does.
            return await self._call_legacy_fallback(full_name, params)

        server_id, tool_name = full_name[:dot], full_name[dot + 1 :]
        runtime = self._runtime.get(server_id)
        if runtime is None:
            return f'Error: MCP server "{server_id}" not found or not connected.'

        try:
            session = await self._ensure_connected(server_id)
        except Exception as exc:  # noqa: BLE001 - reported to the model, not raised
            return f'Error: Failed to connect to MCP server "{server_id}": {exc}'

        tool = runtime.tools.get(tool_name)
        if tool is None:
            return f'Error: Tool "{tool_name}" not found on server "{server_id}".'

        try:
            return await self._call_tool(server_id, runtime, session, tool, tool_name, params)
        except Exception as exc:  # noqa: BLE001 - reported to the model, not raised
            logger.warning("Error executing tool %r on server %r: %s", tool_name, server_id, exc)
            return f"Error executing tool {tool_name}: {exc}"

    async def _call_legacy_fallback(
        self, name: str, params: Mapping[str, str]
    ) -> McpToolExecutionResult | str:
        for server_id, runtime in self._runtime.items():
            tool = runtime.tools.get(name)
            if tool is None:
                continue

            try:
                session = await self._ensure_connected(server_id)
            except Exception as exc:  # noqa: BLE001 - try the next server instead
                logger.info("Failed to connect %r for tool %r: %s", server_id, name, exc)
                continue

            try:
                return await self._call_tool(server_id, runtime, session, tool, name, params)
            except Exception as exc:  # noqa: BLE001 - reported to the model, not raised
                logger.warning("Error executing tool %r on server %r (fallback): %s", name, server_id, exc)
                return f"Error executing tool {name}: {exc}"

        return f'Error: Tool "{name}" not found on any server.'

    async def _call_tool(
        self,
        server_id: str,
        runtime: _ServerRuntime,
        session: SessionLike,
        tool: McpToolDefinition,
        tool_name: str,
        params: Mapping[str, str],
    ) -> McpToolExecutionResult:
        arguments = coerce_tool_params(tool.input_schema, params)
        result = await self._rpc(server_id, runtime, session.call_tool(tool_name, arguments))
        return McpToolExecutionResult(
            server_id=server_id,
            tool_name=tool_name,
            is_error=bool(result.is_error),
            content=[_map_content(item) for item in result.content or []],
            structured_content=result.structured_content,
        )

    # -- resources & prompts ---------------------------------------------------- #

    async def read_resource(self, server_id: str, uri: str) -> McpReadResourceResult:
        """Read one MCP resource. Raises on failure; callers that must never
        raise (e.g. `system.fetch_mcp_resource`) catch around this themselves."""
        runtime = self._runtime.get(server_id)
        if runtime is None:
            raise RuntimeError(f'MCP server "{server_id}" is not configured.')
        session = await self._ensure_connected(server_id)
        result = await self._rpc(server_id, runtime, session.read_resource(uri))
        return McpReadResourceResult(contents=[_map_resource_contents(c) for c in result.contents])

    async def get_prompt(
        self, server_id: str, name: str, args: Mapping[str, str] | None = None
    ) -> McpPromptResult:
        """Fetch one MCP prompt, rendered onto our renderable content dataclasses."""
        runtime = self._runtime.get(server_id)
        if runtime is None:
            raise RuntimeError(f'MCP server "{server_id}" is not configured.')
        session = await self._ensure_connected(server_id)
        result = await self._rpc(
            server_id, runtime, session.get_prompt(name, dict(args) if args else None)
        )
        return McpPromptResult(
            description=result.description,
            messages=[
                McpPromptMessage(
                    role=message.role,
                    content=[_map_content(item) for item in _as_list(message.content)],
                )
                for message in result.messages
            ],
        )

    # -- introspection ----------------------------------------------------------- #

    def grouped_tools(self) -> dict[str, dict[str, McpToolDefinition]]:
        """Tools per configured MCP server. Does not include `system.*` tools --
        merge in `chatmd.tools.system_tools.get_grouped_system_tools()` for that."""
        return {server_id: dict(runtime.tools) for server_id, runtime in self._runtime.items()}

    def grouped_resources(self) -> dict[str, dict[str, McpResource]]:
        return {server_id: dict(runtime.resources) for server_id, runtime in self._runtime.items()}

    def grouped_resource_templates(self) -> dict[str, dict[str, McpResourceTemplate]]:
        return {
            server_id: dict(runtime.resource_templates)
            for server_id, runtime in self._runtime.items()
        }

    def status(self) -> list[McpServerStatus]:
        """Per-server snapshot for `chatmd mcp status`."""
        return [
            McpServerStatus(
                server_id=server_id,
                state=runtime.state,
                tool_count=len(runtime.tools),
                prompt_count=len(runtime.prompt_names),
                resource_count=len(runtime.resources),
                last_error=runtime.last_error,
                connected_since=runtime.connected_since,
            )
            for server_id, runtime in self._runtime.items()
        ]


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else [value]


# --------------------------------------------------------------------------- #
# Content mapping: SDK content blocks -> our McpRenderableContent dataclasses
# --------------------------------------------------------------------------- #


def _map_resource_contents(contents: Any) -> McpResourceContents:
    return McpResourceContents(
        uri=contents.uri,
        mime_type=getattr(contents, "mime_type", None),
        text=getattr(contents, "text", None),
        blob=getattr(contents, "blob", None),
        annotations=getattr(contents, "annotations", None),
    )


def _map_content(item: Any) -> McpRenderableContent:
    """Map one SDK `ContentBlock` onto our `McpRenderableContent` dataclasses."""
    kind = getattr(item, "type", None)
    if kind == "text":
        return McpTextContent(text=item.text, annotations=item.annotations)
    if kind == "image":
        return McpImageContent(data=item.data, mime_type=item.mime_type, annotations=item.annotations)
    if kind == "audio":
        return McpAudioContent(data=item.data, mime_type=item.mime_type, annotations=item.annotations)
    if kind == "resource_link":
        return McpResourceLink(
            uri=item.uri,
            name=item.name,
            title=item.title,
            description=item.description,
            mime_type=item.mime_type,
            annotations=item.annotations,
        )
    if kind == "resource":
        return McpEmbeddedResource(resource=_map_resource_contents(item.resource))
    # Unknown/future content type: degrade to text rather than dropping it.
    return McpTextContent(text=str(item))


# --------------------------------------------------------------------------- #
# Schema-aware parameter coercion
#
# Port of `_parseFinalValue` / `_convertWithPrecedence` / `_schemaAllows` /
# `_isJsonSchemaType` from the end of mcpClient.ts. Tool-call parameters arrive
# as strings from the XML-ish `<cmd:tool_call>` syntax; this coerces each one to
# whatever type its JSON Schema property allows, trying null, then boolean, then
# integer, then number, then finally string -- the same precedence order as the
# TS.
#
# One deliberate simplification: the TS keeps a *second*, cruder fallback path
# in `_parseFinalValue` for a tool name it does not recognise (wrap the raw
# value directly and `JSON.parse` it, no type-precedence at all). Here, a
# missing schema already makes `_isJsonSchemaType` return `True` for every
# type -- "allows everything" -- so running an unknown tool's params through
# the very same precedence chain below produces the same practical result for
# every value except pathologically number-looking garbage (e.g. "42abc",
# which JS's `parseFloat` would silently accept as `42`). We use strict,
# whole-string numeric parsing instead, so we do not carry that quirk forward;
# unifying the two paths keeps this simpler with no behavioural loss.
# --------------------------------------------------------------------------- #

SchemaType = str  # one of "string" | "number" | "integer" | "boolean" | "null"

#: Whether a schema's own `enum`/`const` *value* (already a native JSON value,
#: not a string) matches one of the five JSON Schema primitive types.
_TYPE_CHECKERS: dict[SchemaType, Callable[[Any], bool]] = {
    "string": lambda v: isinstance(v, str),
    "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "number": lambda v: isinstance(v, int | float) and not isinstance(v, bool),
    "boolean": lambda v: isinstance(v, bool),
    "null": lambda v: v is None,
}

_INTEGER_RE = re.compile(r"^[+-]?\d+$")
_NUMBER_RE = re.compile(r"^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$")


def _is_integer_string(value: str) -> bool:
    """Whether `value` is the canonical decimal text of some integer.

    Rejects non-canonical forms (leading zeros, surrounding whitespace) the
    same way the TS's `num.toString() === x` round-trip does.
    """
    if not _INTEGER_RE.match(value):
        return False
    return str(int(value)) == value


def _is_number_string(value: str) -> bool:
    return bool(_NUMBER_RE.match(value))


def _is_boolean_string(value: str) -> bool:
    return value in ("true", "false") or not value


def _is_null_string(value: str) -> bool:
    return value == "null" or not value


def _schema_allows(schema: Any, schema_type: SchemaType) -> bool:
    """Whether a JSON Schema (sub-)node admits `schema_type`.

    A missing/falsy schema allows everything. Handles a plain `type`, a list of
    types, `enum`, `const`, and the `anyOf`/`oneOf`/`allOf` composites
    (recursively).
    """
    if not schema:
        return True

    t = schema.get("type")
    if (isinstance(t, str) and t == schema_type) or (isinstance(t, list) and schema_type in t):
        return True

    enum = schema.get("enum")
    if enum and any(_TYPE_CHECKERS[schema_type](v) for v in enum):
        return True

    if "const" in schema and _TYPE_CHECKERS[schema_type](schema["const"]):
        return True

    for key in ("anyOf", "oneOf", "allOf"):
        sub_schemas = schema.get(key)
        if isinstance(sub_schemas, list) and any(_schema_allows(sub, schema_type) for sub in sub_schemas):
            return True

    return False


def _is_json_schema_type(param_name: str, schema: Mapping[str, Any] | None, schema_type: SchemaType) -> bool:
    """Whether the tool schema's `properties[param_name]` admits `schema_type`.

    A missing schema, or a schema with no `properties`, or a property the
    schema does not mention, all allow everything.
    """
    if not schema or not schema.get("properties"):
        return True
    prop_schema = schema["properties"].get(param_name)
    if not prop_schema:
        return True
    return _schema_allows(prop_schema, schema_type)


def _convert_with_precedence(value: str, param_name: str, schema: Mapping[str, Any] | None) -> Any:
    """Coerce one string parameter, trying null, boolean, integer, number, then string."""
    if _is_null_string(value) and _is_json_schema_type(param_name, schema, "null"):
        return None

    if _is_boolean_string(value) and _is_json_schema_type(param_name, schema, "boolean"):
        if not value:
            return False
        return value == "true"

    if _is_integer_string(value) and _is_json_schema_type(param_name, schema, "integer"):
        return int(value)

    if _is_number_string(value) and _is_json_schema_type(param_name, schema, "number"):
        return float(value)

    if _is_json_schema_type(param_name, schema, "string"):
        # A JSON-encoded string literal (quotes and all), unwrapped again below --
        # this is just how the TS round-trips an ordinary string through JSON.parse.
        return json.dumps(value)

    return value


def coerce_tool_params(
    schema: Mapping[str, Any] | None, params: Mapping[str, str]
) -> dict[str, Any]:
    """Coerce a tool call's string parameters to what its JSON Schema expects.

    `schema` is the tool's `inputSchema` (or `None`/`{}` when the tool, or its
    schema, is unknown -- every property is then unconstrained). Each value is
    converted per `_convert_with_precedence`, then wrapped as `{"key": <value>}`
    and JSON-parsed; a value that fails to parse there (typically a malformed
    object/array literal) falls back to the raw converted value unchanged. This
    final step is what lets object and array parameters arrive as JSON text: a
    property schema that disallows `string` skips the `json.dumps` re-quoting
    above, so its raw text reaches the parse step unquoted.
    """
    output: dict[str, Any] = {}
    for name, value in params.items():
        converted = _convert_with_precedence(value, name, schema)
        text = converted if isinstance(converted, str) else json.dumps(converted)
        try:
            output[name] = json.loads(f'{{"key": {text}}}')["key"]
        except (json.JSONDecodeError, ValueError):
            logger.debug("Parameter %r is malformed JSON; using it as a raw string", name)
            output[name] = converted
    return output
