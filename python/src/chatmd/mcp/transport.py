"""Build a connected `mcp.ClientSession` from an `McpServerConfig`.

Port of the transport-selection half of `src/mcpClient.ts` (`connectServer`,
`createStreamableHttpTransport`, `createSseTransport`). Everything about *keeping*
a session alive, retrying, and routing tool calls lives in `chatmd.mcp.manager`;
this module only knows how to open one connection and hand back a session that is
already past the `initialize()` handshake.

Not ported here (left to `manager.py`, or dropped -- see its module docstring):
notification handlers (`ToolListChangedNotificationSchema` etc.), SSE-specific
auto-reconnect timers, and the "test-connect then reconnect for real" dance the TS
uses for auto-mode Streamable HTTP -- we just keep the working connection instead
of throwing it away and reconnecting.
"""

from __future__ import annotations

import asyncio
import logging
import os
from collections.abc import AsyncGenerator, AsyncIterator
from contextlib import AbstractAsyncContextManager, AsyncExitStack, asynccontextmanager
from typing import Any

from mcp import ClientSession, Implementation, StdioServerParameters, stdio_client
from mcp.client.sse import sse_client
from mcp.client.streamable_http import streamable_http_client

# `create_mcp_http_client` lives under a "private" (`_`-prefixed) module, but it is
# exactly what `mcp.client.session_group.ClientSessionGroup` itself imports to attach
# custom headers to a Streamable HTTP connection -- there is no public re-export, so
# we follow the SDK's own precedent rather than reimplementing its SSE-friendly
# timeout defaults.
from mcp.shared._httpx_utils import create_mcp_http_client

from ..config.model import McpServerConfig

logger = logging.getLogger(__name__)

#: Identifies this client to servers, mirroring the TS extension's `{name, version}`.
_CLIENT_INFO = Implementation(name="chatmd", version="0.1.0")

#: A transport's raw (read, write) stream pair. Left as `Any`/`Any`: this module
#: never touches the streams itself, only forwards them into `ClientSession`.
TransportStreams = tuple[Any, Any]
TransportCM = AbstractAsyncContextManager[TransportStreams]


def _stdio_params(config: McpServerConfig) -> StdioServerParameters:
    assert config.command is not None
    # The child's environment is the PARENT environment with the config's `env`
    # layered on top, not `config.env` alone: a server started with only a
    # hand-picked handful of variables usually cannot even find its own
    # interpreter (no PATH, no HOME). This mirrors the TS `combinedEnv`.
    env = {**os.environ, **config.env}
    return StdioServerParameters(command=config.command, args=list(config.args), env=env)


def _streamable_http_transport(config: McpServerConfig) -> TransportCM:
    """Streamable HTTP transport, attaching custom headers when configured."""
    assert config.url is not None
    if not config.headers:
        # No headers to attach: let the transport build its own client, which
        # already carries the SDK's recommended long-read timeout for the
        # server->client event stream.
        return streamable_http_client(url=config.url)

    @asynccontextmanager
    async def _with_headers() -> AsyncGenerator[TransportStreams, None]:
        async with create_mcp_http_client(headers=dict(config.headers)) as http_client:
            async with streamable_http_client(url=config.url, http_client=http_client) as streams:  # type: ignore[arg-type]
                yield streams

    return _with_headers()


def _sse_transport(config: McpServerConfig) -> TransportCM:
    assert config.url is not None
    headers = dict(config.headers) if config.headers else None
    return sse_client(url=config.url, headers=headers)


async def _open_and_initialize(
    transport_cm: TransportCM,
    stack: AsyncExitStack,
    connect_timeout: float,
) -> ClientSession:
    """Enter a transport + session onto `stack` and complete the handshake.

    On any failure the caller's `stack` unwinds whatever this pushed (including a
    stdio transport's already-spawned child process), so a half-open connection
    never leaks.
    """
    async with asyncio.timeout(connect_timeout):
        read, write = await stack.enter_async_context(transport_cm)
        session_cm = ClientSession(read, write, client_info=_CLIENT_INFO)
        session = await stack.enter_async_context(session_cm)
        await session.initialize()
    return session


@asynccontextmanager
async def connect_session(
    config: McpServerConfig,
    *,
    connect_timeout: float = 30.0,
    server_id: str = "",
) -> AsyncIterator[ClientSession]:
    """Connect to one MCP server and yield an initialized `ClientSession`.

    Stdio when `config.command` is set. Otherwise a URL server: `transport ==
    "streamable-http"` or `"sse"` picks that transport explicitly; the default,
    `"auto"`, tries Streamable HTTP first and falls back to SSE if that whole
    handshake (connect + `initialize()`) fails.
    """
    label = server_id or "<mcp server>"
    async with AsyncExitStack() as stack:
        if config.is_stdio:
            session = await _open_and_initialize(
                stdio_client(_stdio_params(config)), stack, connect_timeout
            )
        elif config.url:
            mode = config.transport or "auto"
            if mode == "streamable-http":
                session = await _open_and_initialize(
                    _streamable_http_transport(config), stack, connect_timeout
                )
            elif mode == "sse":
                session = await _open_and_initialize(_sse_transport(config), stack, connect_timeout)
            else:
                # "auto": try Streamable HTTP first in its own sub-stack, so a
                # failed attempt's half-open resources are fully closed before
                # falling back. An SSE failure here is the real, final error.
                try:
                    async with AsyncExitStack() as trial:
                        session = await _open_and_initialize(
                            _streamable_http_transport(config), trial, connect_timeout
                        )
                        # Success: move the trial resources onto the outer stack
                        # so they outlive this `try` block instead of being
                        # closed when it exits.
                        stack.push_async_callback(trial.pop_all().aclose)
                except Exception as exc:  # noqa: BLE001 - deliberate fallback, not a swallow
                    logger.info(
                        "Streamable HTTP failed for %r (%s); falling back to SSE", label, exc
                    )
                    session = await _open_and_initialize(
                        _sse_transport(config), stack, connect_timeout
                    )
        else:
            raise ValueError(f"MCP server {label!r} configuration has neither 'command' nor 'url'.")

        yield session
