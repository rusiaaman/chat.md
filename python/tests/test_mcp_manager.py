"""Tests for the MCP client pool (`chatmd.mcp.manager`).

No real servers and no network: session-dependent behaviour is exercised
through `FakeSession` / `FakeConnector`, injected via `McpPool`'s
`session_connector` constructor hook instead of a real transport.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any

import pytest

from chatmd.config.model import McpServerConfig
from chatmd.mcp import manager as manager_module
from chatmd.mcp.manager import McpPool, _schema_allows, coerce_tool_params
from chatmd.types import (
    McpAudioContent,
    McpEmbeddedResource,
    McpImageContent,
    McpResourceLink,
    McpTextContent,
    McpToolExecutionResult,
)

# --------------------------------------------------------------------------- #
# Schema-aware parameter coercion
# --------------------------------------------------------------------------- #

_COERCION_CASES: list[Any] = [
    # -- missing / empty schema: every type is allowed, so precedence alone decides -- #
    pytest.param(None, "hello", "hello", id="missing-schema-string"),
    pytest.param(None, "42", 42, id="missing-schema-integer"),
    pytest.param(None, "3.14", 3.14, id="missing-schema-number"),
    pytest.param(None, "true", True, id="missing-schema-boolean-true"),
    pytest.param(None, "false", False, id="missing-schema-boolean-false"),
    pytest.param(None, "null", None, id="missing-schema-null"),
    pytest.param({}, "x", "x", id="empty-schema-treated-like-missing"),
    pytest.param(
        {"type": "object", "properties": {"other": {"type": "integer"}}},
        "42",
        42,
        id="missing-property-allows-everything",
    ),
    # -- a plain `type` forces coercion even against the "obvious" reading -- #
    pytest.param(
        {"type": "object", "properties": {"x": {"type": "string"}}},
        "42",
        "42",
        id="explicit-string-forces-string-even-if-numeric-looking",
    ),
    pytest.param(
        {"type": "object", "properties": {"x": {"type": "integer"}}},
        "42",
        42,
        id="explicit-integer",
    ),
    pytest.param(
        {"type": "object", "properties": {"x": {"type": "boolean"}}},
        "true",
        True,
        id="explicit-boolean-true",
    ),
    pytest.param(
        {"type": "object", "properties": {"x": {"type": "boolean"}}},
        "",
        False,
        id="explicit-boolean-empty-string-is-false",
    ),
    pytest.param(
        {"type": "object", "properties": {"x": {"type": "null"}}},
        "null",
        None,
        id="explicit-null",
    ),
    # -- a list of types -- #
    pytest.param(
        {"type": "object", "properties": {"x": {"type": ["string", "null"]}}},
        "",
        None,
        id="type-list-allows-null",
    ),
    pytest.param(
        {"type": "object", "properties": {"x": {"type": ["string", "null"]}}},
        "abc",
        "abc",
        id="type-list-allows-string",
    ),
    pytest.param(
        {"type": "object", "properties": {"x": {"type": ["string", "integer"]}}},
        "",
        "",
        id="type-list-without-null-empty-string-stays-a-string",
    ),
    # -- enum / const -- #
    pytest.param(
        {"type": "object", "properties": {"x": {"enum": [1, 2, 3]}}},
        "2",
        2,
        id="enum-of-integers",
    ),
    pytest.param(
        {"type": "object", "properties": {"x": {"enum": ["red", "green"]}}},
        "red",
        "red",
        id="enum-of-strings",
    ),
    pytest.param(
        {"type": "object", "properties": {"x": {"const": 42}}},
        "42",
        42,
        id="const-integer",
    ),
    # -- anyOf / oneOf / allOf composites -- #
    pytest.param(
        {
            "type": "object",
            "properties": {"x": {"anyOf": [{"type": "integer"}, {"type": "string"}]}},
        },
        "42",
        42,
        id="anyOf-picks-integer",
    ),
    pytest.param(
        {
            "type": "object",
            "properties": {"x": {"anyOf": [{"type": "integer"}, {"type": "string"}]}},
        },
        "hello",
        "hello",
        id="anyOf-falls-back-to-string",
    ),
    pytest.param(
        {"type": "object", "properties": {"x": {"oneOf": [{"type": "boolean"}]}}},
        "true",
        True,
        id="oneOf-composite",
    ),
    pytest.param(
        {"type": "object", "properties": {"x": {"allOf": [{"type": "integer"}]}}},
        "7",
        7,
        id="allOf-composite",
    ),
    # -- object/array parameters arrive as JSON text -- #
    pytest.param(
        {"type": "object", "properties": {"x": {"type": "object"}}},
        '{"a": 1, "b": [1, 2, 3]}',
        {"a": 1, "b": [1, 2, 3]},
        id="nested-object-json",
    ),
    pytest.param(
        {"type": "object", "properties": {"x": {"type": "array"}}},
        '[1, 2, "three"]',
        [1, 2, "three"],
        id="nested-array-json",
    ),
    # -- malformed JSON for an object/array-only property falls back to the raw string -- #
    pytest.param(
        {"type": "object", "properties": {"x": {"type": "object"}}},
        "{not valid json",
        "{not valid json",
        id="malformed-json-falls-back-to-raw-string",
    ),
]


@pytest.mark.parametrize("schema, value, expected", _COERCION_CASES)
def test_coerce_tool_params_table(schema: dict[str, Any] | None, value: str, expected: Any) -> None:
    assert coerce_tool_params(schema, {"x": value}) == {"x": expected}


def test_coerce_tool_params_handles_multiple_parameters_independently() -> None:
    schema = {
        "type": "object",
        "properties": {"count": {"type": "integer"}, "label": {"type": "string"}},
    }
    result = coerce_tool_params(schema, {"count": "3", "label": "5"})
    assert result == {"count": 3, "label": "5"}


def test_schema_allows_missing_or_empty_schema_allows_every_type() -> None:
    for schema_type in ("string", "number", "integer", "boolean", "null"):
        assert _schema_allows(None, schema_type)
        assert _schema_allows({}, schema_type)


def test_schema_allows_type_list() -> None:
    schema = {"type": ["integer", "boolean"]}
    assert _schema_allows(schema, "integer")
    assert _schema_allows(schema, "boolean")
    assert not _schema_allows(schema, "string")


def test_schema_allows_composites_recurse() -> None:
    schema = {"oneOf": [{"type": "string"}, {"const": 5}]}
    assert _schema_allows(schema, "string")
    assert _schema_allows(schema, "integer")  # via the `const: 5` branch
    assert not _schema_allows(schema, "boolean")


# --------------------------------------------------------------------------- #
# Fakes: a session and a connector, standing in for a real transport
# --------------------------------------------------------------------------- #


def _tool(name: str, schema: dict[str, Any] | None = None) -> SimpleNamespace:
    return SimpleNamespace(name=name, description=None, input_schema=schema or {})


def _resource(uri: str, name: str = "res") -> SimpleNamespace:
    return SimpleNamespace(
        uri=uri,
        name=name,
        title=None,
        description=None,
        mime_type=None,
        size=None,
        annotations=None,
    )


def _template(uri_template: str, name: str = "tmpl") -> SimpleNamespace:
    return SimpleNamespace(
        uri_template=uri_template,
        name=name,
        title=None,
        description=None,
        mime_type=None,
        annotations=None,
    )


def _content(kind: str, **kwargs: Any) -> SimpleNamespace:
    return SimpleNamespace(type=kind, **kwargs)


def _call_result(
    content: list[Any], *, is_error: bool = False, structured_content: Any = None
) -> SimpleNamespace:
    return SimpleNamespace(
        content=content, is_error=is_error, structured_content=structured_content
    )


class FakeSession:
    """Stub standing in for `mcp.ClientSession` -- see `SessionLike` in manager.py."""

    def __init__(
        self,
        *,
        tools: list[Any] | None = None,
        prompts: list[Any] | None = None,
        resources: list[Any] | None = None,
        templates: list[Any] | None = None,
        list_tools_error: Exception | None = None,
        list_prompts_error: Exception | None = None,
        list_resources_error: Exception | None = None,
        list_templates_error: Exception | None = None,
    ) -> None:
        self.tools = tools or []
        self.prompts = prompts or []
        self.resources = resources or []
        self.templates = templates or []
        self.list_tools_error = list_tools_error
        self.list_prompts_error = list_prompts_error
        self.list_resources_error = list_resources_error
        self.list_templates_error = list_templates_error
        #: Popped one-per-call; an `Exception` instance is raised instead of returned.
        self.call_tool_results: list[Any] = []
        self.call_tool_calls: list[tuple[str, dict[str, Any]]] = []
        self.read_resource_result: Any = None
        self.get_prompt_result: Any = None

    async def list_tools(self) -> Any:
        if self.list_tools_error:
            raise self.list_tools_error
        return SimpleNamespace(tools=self.tools)

    async def list_prompts(self) -> Any:
        if self.list_prompts_error:
            raise self.list_prompts_error
        return SimpleNamespace(prompts=self.prompts)

    async def list_resources(self) -> Any:
        if self.list_resources_error:
            raise self.list_resources_error
        return SimpleNamespace(resources=self.resources)

    async def list_resource_templates(self) -> Any:
        if self.list_templates_error:
            raise self.list_templates_error
        return SimpleNamespace(resource_templates=self.templates)

    async def call_tool(self, name: str, arguments: dict[str, Any] | None = None) -> Any:
        self.call_tool_calls.append((name, arguments or {}))
        if self.call_tool_results:
            result = self.call_tool_results.pop(0)
            if isinstance(result, Exception):
                raise result
            return result
        return _call_result([])

    async def read_resource(self, uri: str) -> Any:
        return self.read_resource_result

    async def get_prompt(self, name: str, arguments: dict[str, str] | None = None) -> Any:
        return self.get_prompt_result


class FakeConnector:
    """`session_connector` stub: hands back a canned `FakeSession` per server id.

    Tracks how many times each server was "dialed" and how many connections were
    open at once, so tests can assert on the pool's connect-dedup and
    keep-alive behaviour without a real transport. `fail_next[server_id]` is a
    queue of exceptions to raise instead of connecting, one per attempt.
    """

    def __init__(self, sessions: dict[str, FakeSession]) -> None:
        self.sessions = sessions
        self.connect_counts: dict[str, int] = {}
        self.concurrent_opens: dict[str, int] = {}
        self.max_concurrent_opens: dict[str, int] = {}
        self.fail_next: dict[str, list[Exception]] = {}

    def __call__(self, server_id: str, config: McpServerConfig) -> Any:
        return self._connect(server_id)

    @asynccontextmanager
    async def _connect(self, server_id: str) -> AsyncIterator[FakeSession]:
        self.connect_counts[server_id] = self.connect_counts.get(server_id, 0) + 1
        # A real suspension point, so two concurrent callers can actually
        # interleave here instead of one running the whole connect to
        # completion before the other is ever scheduled.
        await asyncio.sleep(0)
        queue = self.fail_next.get(server_id)
        if queue:
            raise queue.pop(0)
        depth = self.concurrent_opens.get(server_id, 0) + 1
        self.concurrent_opens[server_id] = depth
        self.max_concurrent_opens[server_id] = max(
            self.max_concurrent_opens.get(server_id, 0), depth
        )
        try:
            yield self.sessions[server_id]
        finally:
            self.concurrent_opens[server_id] -= 1


def make_pool(
    sessions: dict[str, FakeSession], *, max_reconnect_attempts: int = 5
) -> tuple[McpPool, FakeConnector]:
    servers = {server_id: McpServerConfig(command="fake") for server_id in sessions}
    connector = FakeConnector(sessions)
    pool = McpPool(
        servers, session_connector=connector, max_reconnect_attempts=max_reconnect_attempts
    )
    return pool, connector


async def _no_sleep(_seconds: float) -> None:
    return None


# --------------------------------------------------------------------------- #
# start(): lazy connect, list, disconnect
# --------------------------------------------------------------------------- #


async def test_start_lists_tools_then_disconnects() -> None:
    session = FakeSession(tools=[_tool("foo", {"type": "object"})])
    pool, connector = make_pool({"srv": session})

    await pool.start()

    status = pool.status()[0]
    assert status.state == "not-started"
    assert status.tool_count == 1
    assert connector.max_concurrent_opens["srv"] == 1
    assert connector.concurrent_opens["srv"] == 0  # disconnected again


async def test_start_records_per_server_errors_without_aborting_others() -> None:
    good = FakeSession(tools=[_tool("foo")])
    bad = FakeSession(list_tools_error=RuntimeError("boom"))
    pool, _ = make_pool({"good": good, "bad": bad})

    await pool.start()

    statuses = {s.server_id: s for s in pool.status()}
    assert statuses["good"].state == "not-started"
    assert statuses["good"].tool_count == 1
    assert statuses["bad"].state == "errored"
    assert "boom" in (statuses["bad"].last_error or "")


async def test_optional_listings_failing_does_not_fail_discovery() -> None:
    session = FakeSession(
        tools=[_tool("foo")],
        list_prompts_error=RuntimeError("no prompts"),
        list_resources_error=RuntimeError("no resources"),
        list_templates_error=RuntimeError("no templates"),
    )
    pool, _ = make_pool({"srv": session})

    await pool.start()

    status = pool.status()[0]
    assert status.state == "not-started"
    assert status.tool_count == 1
    assert status.prompt_count == 0
    assert status.resource_count == 0


async def test_grouped_tools_excludes_system_tools() -> None:
    pool, _ = make_pool({"srv": FakeSession(tools=[_tool("foo")])})
    await pool.start()

    grouped = pool.grouped_tools()
    assert set(grouped) == {"srv"}
    assert "system" not in grouped


async def test_grouped_resources_and_templates() -> None:
    session = FakeSession(resources=[_resource("file:///a")], templates=[_template("file:///{id}")])
    pool, _ = make_pool({"srv": session})
    await pool.start()

    assert set(pool.grouped_resources()["srv"]) == {"file:///a"}
    assert set(pool.grouped_resource_templates()["srv"]) == {"file:///{id}"}


# --------------------------------------------------------------------------- #
# call(): naming, splitting, routing, error strings
# --------------------------------------------------------------------------- #


async def test_dotted_call_executes_the_named_tool_with_coerced_params() -> None:
    schema = {"type": "object", "properties": {"n": {"type": "integer"}}}
    session = FakeSession(tools=[_tool("foo", schema)])
    session.call_tool_results.append(_call_result([_content("text", text="hi", annotations=None)]))
    pool, connector = make_pool({"srv": session})
    await pool.start()

    result = await pool.call("srv.foo", {"n": "5"})

    assert isinstance(result, McpToolExecutionResult)
    assert result.server_id == "srv"
    assert result.tool_name == "foo"
    assert not result.is_error
    assert result.content == [McpTextContent(text="hi", annotations=None)]
    assert session.call_tool_calls == [("foo", {"n": 5})]
    assert connector.connect_counts["srv"] == 2  # start()'s discovery + the real connect


async def test_bare_tool_name_falls_back_to_searching_every_server() -> None:
    a = FakeSession(tools=[])
    b = FakeSession(tools=[_tool("shared")])
    b.call_tool_results.append(_call_result([_content("text", text="ok", annotations=None)]))
    pool, _ = make_pool({"a": a, "b": b})
    await pool.start()

    result = await pool.call("shared", {})

    assert isinstance(result, McpToolExecutionResult)
    assert result.server_id == "b"


async def test_legacy_fallback_reports_not_found_on_any_server() -> None:
    pool, _ = make_pool({"a": FakeSession(tools=[]), "b": FakeSession(tools=[])})
    await pool.start()

    result = await pool.call("nowhere", {})

    assert result == 'Error: Tool "nowhere" not found on any server.'


@pytest.mark.parametrize("name", [".foo", "foo."])
async def test_leading_or_trailing_dot_is_not_a_usable_split(name: str) -> None:
    pool, _ = make_pool({"srv": FakeSession(tools=[])})
    await pool.start()

    result = await pool.call(name, {})

    assert result == f'Error: Tool "{name}" not found on any server.'


async def test_unknown_server_returns_error_string() -> None:
    pool, _ = make_pool({"srv": FakeSession()})
    await pool.start()

    result = await pool.call("other.tool", {})

    assert result == 'Error: MCP server "other" not found or not connected.'


async def test_unknown_tool_on_known_server_returns_error_string() -> None:
    pool, _ = make_pool({"srv": FakeSession(tools=[])})
    await pool.start()

    result = await pool.call("srv.missing", {})

    assert result == 'Error: Tool "missing" not found on server "srv".'


async def test_connect_failure_is_reported_as_a_string_not_raised() -> None:
    session = FakeSession(tools=[_tool("foo")])
    pool, connector = make_pool({"srv": session})
    await pool.start()
    connector.fail_next["srv"] = [RuntimeError("no route to host")]

    result = await pool.call("srv.foo", {})

    assert isinstance(result, str)
    assert "Failed to connect" in result
    assert "no route to host" in result


async def test_system_tool_calls_route_to_execute_system_tool() -> None:
    session = FakeSession()
    session.read_resource_result = SimpleNamespace(
        contents=[
            SimpleNamespace(
                uri="file:///a.md",
                mime_type="text/markdown",
                text="hi",
                blob=None,
                annotations=None,
            )
        ]
    )
    pool, _ = make_pool({"docs": session})
    await pool.start()

    result = await pool.call("system.fetch_mcp_resource", {"serverId": "docs", "uri": "file:///a.md"})

    assert isinstance(result, McpToolExecutionResult)
    assert result.server_id == "system"
    item = result.content[0]
    assert isinstance(item, McpEmbeddedResource)
    assert item.resource.text == "hi"


# --------------------------------------------------------------------------- #
# Content mapping and tool-level errors
# --------------------------------------------------------------------------- #


async def test_content_mapping_covers_every_renderable_kind() -> None:
    session = FakeSession(tools=[_tool("foo")])
    session.call_tool_results.append(
        _call_result(
            [
                _content("text", text="hello", annotations=None),
                _content("image", data="YQ==", mime_type="image/png", annotations=None),
                _content("audio", data="YQ==", mime_type="audio/wav", annotations=None),
                _content(
                    "resource_link",
                    uri="file:///x",
                    name="x",
                    title=None,
                    description=None,
                    mime_type=None,
                    annotations=None,
                ),
                _content(
                    "resource",
                    resource=SimpleNamespace(
                        uri="file:///y",
                        mime_type="text/plain",
                        text="body",
                        blob=None,
                        annotations=None,
                    ),
                ),
            ],
            structured_content={"ok": True},
        )
    )
    pool, _ = make_pool({"srv": session})
    await pool.start()

    result = await pool.call("srv.foo", {})

    assert isinstance(result, McpToolExecutionResult)
    assert result.structured_content == {"ok": True}
    kinds = [type(item) for item in result.content]
    assert kinds == [
        McpTextContent,
        McpImageContent,
        McpAudioContent,
        McpResourceLink,
        McpEmbeddedResource,
    ]
    assert result.content[4].resource.text == "body"


async def test_tool_level_error_is_is_error_not_raised() -> None:
    session = FakeSession(tools=[_tool("foo")])
    session.call_tool_results.append(
        _call_result([_content("text", text="bad input", annotations=None)], is_error=True)
    )
    pool, _ = make_pool({"srv": session})
    await pool.start()

    result = await pool.call("srv.foo", {})

    assert isinstance(result, McpToolExecutionResult)
    assert result.is_error


# --------------------------------------------------------------------------- #
# status(), keep-alive, reconnect with backoff, and the reconnect cap
# --------------------------------------------------------------------------- #


async def test_status_reports_connected_state_after_a_real_call() -> None:
    session = FakeSession(tools=[_tool("foo")])
    session.call_tool_results.append(_call_result([]))
    pool, _ = make_pool({"srv": session})
    await pool.start()

    await pool.call("srv.foo", {})

    status = pool.status()[0]
    assert status.state == "connected"
    assert status.connected_since is not None


async def test_concurrent_calls_do_not_spawn_two_connections() -> None:
    session = FakeSession(tools=[_tool("foo")])
    session.call_tool_results.extend([_call_result([]), _call_result([])])
    pool, connector = make_pool({"srv": session})
    await pool.start()

    results = await asyncio.gather(pool.call("srv.foo", {}), pool.call("srv.foo", {}))

    assert all(isinstance(r, McpToolExecutionResult) for r in results)
    assert connector.connect_counts["srv"] == 2  # start()'s discovery + exactly one real connect
    assert connector.max_concurrent_opens["srv"] == 1


async def test_a_dropped_session_reconnects_on_the_next_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(manager_module.asyncio, "sleep", _no_sleep)
    session = FakeSession(tools=[_tool("foo")])
    session.call_tool_results.append(RuntimeError("connection reset"))
    session.call_tool_results.append(
        _call_result([_content("text", text="back", annotations=None)])
    )
    pool, connector = make_pool({"srv": session})
    await pool.start()

    first = await pool.call("srv.foo", {})
    assert isinstance(first, str)
    assert "Error executing tool foo" in first
    assert pool.status()[0].state == "errored"

    second = await pool.call("srv.foo", {})

    assert isinstance(second, McpToolExecutionResult)
    assert pool.status()[0].state == "connected"
    # discovery + first connect + reconnect after the drop
    assert connector.connect_counts["srv"] == 3


async def test_reconnect_attempts_are_capped(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(manager_module.asyncio, "sleep", _no_sleep)
    session = FakeSession(tools=[_tool("foo")])
    pool, connector = make_pool({"srv": session}, max_reconnect_attempts=2)
    await pool.start()
    connector.fail_next["srv"] = [RuntimeError("down")] * 5

    first = await pool.call("srv.foo", {})
    second = await pool.call("srv.foo", {})
    third = await pool.call("srv.foo", {})

    assert "Failed to connect" in first
    assert "Failed to connect" in second
    assert "exceeded" in third
    # The third call never touches the connector again once the cap is hit.
    assert connector.connect_counts["srv"] == 1 + 2
    assert pool.status()[0].state == "errored"


async def test_aclose_disconnects_kept_alive_sessions() -> None:
    session = FakeSession(tools=[_tool("foo")])
    session.call_tool_results.append(_call_result([]))
    pool, connector = make_pool({"srv": session})
    await pool.start()
    await pool.call("srv.foo", {})
    assert connector.concurrent_opens["srv"] == 1

    await pool.aclose()

    assert connector.concurrent_opens["srv"] == 0
    assert pool.status()[0].state == "not-started"


# --------------------------------------------------------------------------- #
# read_resource() / get_prompt()
# --------------------------------------------------------------------------- #


async def test_read_resource_returns_typed_result() -> None:
    session = FakeSession()
    session.read_resource_result = SimpleNamespace(
        contents=[
            SimpleNamespace(
                uri="u", mime_type="text/plain", text="body", blob=None, annotations=None
            )
        ]
    )
    pool, _ = make_pool({"srv": session})
    await pool.start()

    result = await pool.read_resource("srv", "u")

    assert result.contents[0].text == "body"


async def test_read_resource_raises_for_unknown_server() -> None:
    pool, _ = make_pool({"srv": FakeSession()})
    await pool.start()

    with pytest.raises(RuntimeError):
        await pool.read_resource("nope", "u")


async def test_get_prompt_maps_messages_and_handles_a_single_content_block() -> None:
    session = FakeSession()
    session.get_prompt_result = SimpleNamespace(
        description="d",
        messages=[
            SimpleNamespace(role="user", content=_content("text", text="hi", annotations=None)),
            SimpleNamespace(
                role="assistant",
                content=[
                    _content("text", text="a", annotations=None),
                    _content("text", text="b", annotations=None),
                ],
            ),
        ],
    )
    pool, _ = make_pool({"srv": session})
    await pool.start()

    result = await pool.get_prompt("srv", "greeting", {"name": "Amy"})

    assert result.description == "d"
    assert result.messages[0].role == "user"
    assert result.messages[0].content == [McpTextContent(text="hi", annotations=None)]
    assert len(result.messages[1].content) == 2
