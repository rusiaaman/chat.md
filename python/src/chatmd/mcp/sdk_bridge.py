"""Loopback MCP bridge from subscription SDKs to ChatMD's shared MCP pool."""

from __future__ import annotations

import asyncio
import contextvars
import hashlib
import json
import secrets
import socket
from collections.abc import Awaitable, Callable, MutableMapping
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any
from urllib.parse import quote, unquote

import uvicorn
from mcp import types as mcp_types
from mcp.server.lowlevel import Server
from mcp.server.lowlevel.server import ServerRequestContext
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from mcp.server.transport_security import TransportSecuritySettings

from ..types import (
    McpAudioContent,
    McpEmbeddedResource,
    McpImageContent,
    McpRenderableContent,
    McpResourceLink,
    McpTextContent,
    McpToolExecutionResult,
)

if TYPE_CHECKING:
    from .manager import McpPool

Scope = MutableMapping[str, Any]
Receive = Callable[[], Awaitable[MutableMapping[str, Any]]]
Send = Callable[[MutableMapping[str, Any]], Awaitable[None]]


@dataclass(frozen=True)
class SdkMcpBridgeLease:
    urls: dict[str, str]
    codex_urls: dict[str, str]
    codex_server_names: dict[str, str]
    claude_allowed_tools: list[str]
    _bridge: SdkMcpBridge
    _token: str

    def release(self) -> None:
        self._bridge.release(self._token)


def _string_params(arguments: dict[str, Any]) -> dict[str, str]:
    return {
        name: value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
        for name, value in arguments.items()
    }


def _mcp_content(item: McpRenderableContent) -> mcp_types.ContentBlock:
    if isinstance(item, McpTextContent):
        return mcp_types.TextContent(text=item.text, annotations=item.annotations)
    if isinstance(item, McpImageContent):
        return mcp_types.ImageContent(
            data=item.data, mime_type=item.mime_type, annotations=item.annotations
        )
    if isinstance(item, McpAudioContent):
        return mcp_types.AudioContent(
            data=item.data, mime_type=item.mime_type, annotations=item.annotations
        )
    if isinstance(item, McpResourceLink):
        return mcp_types.ResourceLink(
            uri=item.uri,
            name=item.name,
            title=item.title,
            description=item.description,
            mime_type=item.mime_type,
            annotations=item.annotations,
        )
    if isinstance(item, McpEmbeddedResource):
        resource = item.resource
        embedded: mcp_types.TextResourceContents | mcp_types.BlobResourceContents
        if resource.text is not None:
            embedded = mcp_types.TextResourceContents(
                uri=resource.uri, mime_type=resource.mime_type, text=resource.text
            )
        else:
            embedded = mcp_types.BlobResourceContents(
                uri=resource.uri, mime_type=resource.mime_type, blob=resource.blob or ""
            )
        return mcp_types.EmbeddedResource(resource=embedded, annotations=resource.annotations)
    raise TypeError(f"Unsupported MCP content: {type(item).__name__}")


def _call_result(result: McpToolExecutionResult | str) -> mcp_types.CallToolResult:
    if isinstance(result, str):
        return mcp_types.CallToolResult(
            content=[mcp_types.TextContent(text=result)],
            is_error=result.startswith(("Error:", "CANCELLED:")),
        )
    return mcp_types.CallToolResult(
        content=[_mcp_content(item) for item in result.content],
        structured_content=result.structured_content,
        is_error=result.is_error,
    )


async def _http_error(send: Send, status: int, message: str) -> None:
    body = message.encode()
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [
                (b"content-type", b"text/plain; charset=utf-8"),
                (b"content-length", str(len(body)).encode()),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})


class SdkMcpBridge:
    """Exposes the pool on loopback while leaving upstream sessions pool-owned."""

    def __init__(self, pool: McpPool) -> None:
        self._pool = pool
        self._leases: set[str] = set()
        self._route = contextvars.ContextVar[tuple[str, str] | None](
            "chatmd_sdk_mcp_route", default=None
        )
        self._mcp = Server(
            "chatmd-mcp-bridge",
            version="0.7.0",
            on_list_tools=self._list_tools,
            on_call_tool=self._call_tool,
        )
        self._sessions = StreamableHTTPSessionManager(
            self._mcp,
            event_store=None,
            json_response=True,
            stateless=True,
            security_settings=TransportSecuritySettings(
                enable_dns_rebinding_protection=True,
                allowed_hosts=["127.0.0.1:*"],
                allowed_origins=["http://127.0.0.1:*"],
            ),
        )
        self._server: uvicorn.Server | None = None
        self._server_task: asyncio.Task[None] | None = None
        self._session_task: asyncio.Task[None] | None = None
        self._session_stop: asyncio.Event | None = None
        self._address: str | None = None
        self._start_lock = asyncio.Lock()

    async def acquire(self) -> SdkMcpBridgeLease:
        address = await self._start()
        token = secrets.token_urlsafe(32)
        self._leases.add(token)
        grouped_tools = self._pool.grouped_tools()
        urls = {
            server_id: f"{address}/{token}/{quote(server_id, safe='')}"
            for server_id in grouped_tools
        }
        allowed_tools = [
            f"mcp__{server_id}__{tool_name}"
            for server_id, tools in grouped_tools.items()
            for tool_name in tools
        ]
        codex_server_names = {
            "chatmd_" + hashlib.sha256(f"{token}:{server_id}".encode()).hexdigest()[:16]: server_id
            for server_id in grouped_tools
        }
        codex_urls = {
            internal_name: urls[server_id]
            for internal_name, server_id in codex_server_names.items()
        }
        return SdkMcpBridgeLease(
            urls=urls,
            codex_urls=codex_urls,
            codex_server_names=codex_server_names,
            claude_allowed_tools=allowed_tools,
            _bridge=self,
            _token=token,
        )

    def release(self, token: str) -> None:
        self._leases.discard(token)

    async def aclose(self) -> None:
        self._leases.clear()
        server, task = self._server, self._server_task
        session_task, session_stop = self._session_task, self._session_stop
        self._server = None
        self._server_task = None
        self._session_task = None
        self._session_stop = None
        self._address = None
        if server is not None and task is not None:
            server.should_exit = True
            await task
        if session_stop is not None and session_task is not None:
            session_stop.set()
            await session_task

    async def _run_session_manager(self, ready: asyncio.Future[None], stop: asyncio.Event) -> None:
        try:
            async with self._sessions.run():
                ready.set_result(None)
                await stop.wait()
        except BaseException as error:
            if not ready.done():
                ready.set_exception(error)
                return
            raise

    async def _start(self) -> str:
        if self._address is not None:
            return self._address
        async with self._start_lock:
            if self._address is not None:
                return self._address
            listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind(("127.0.0.1", 0))
            listener.listen(2048)
            listener.setblocking(False)
            port = listener.getsockname()[1]
            ready: asyncio.Future[None] = asyncio.get_running_loop().create_future()
            session_stop = asyncio.Event()
            session_task = asyncio.create_task(self._run_session_manager(ready, session_stop))
            await ready
            config = uvicorn.Config(
                self,
                host="127.0.0.1",
                port=port,
                lifespan="off",
                log_config=None,
                access_log=False,
                server_header=False,
                date_header=False,
            )
            server = uvicorn.Server(config)
            task = asyncio.create_task(server.serve(sockets=[listener]))
            try:
                while not server.started:
                    if task.done():
                        await task
                    await asyncio.sleep(0)
            except BaseException:
                listener.close()
                session_stop.set()
                await session_task
                raise
            self._session_task = session_task
            self._session_stop = session_stop
            self._server = server
            self._server_task = task
            self._address = f"http://127.0.0.1:{port}/mcp"
            return self._address

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await _http_error(send, 404, "Unknown MCP bridge endpoint.")
            return
        parts = [part for part in scope["path"].split("/") if part]
        if len(parts) != 3 or parts[0] != "mcp" or parts[1] not in self._leases:
            await _http_error(send, 404, "Unknown MCP bridge endpoint.")
            return
        server_id = unquote(parts[2])
        if server_id not in self._pool.grouped_tools():
            await _http_error(send, 404, "Unknown MCP server.")
            return
        route = self._route.set((parts[1], server_id))
        try:
            await self._sessions.handle_request(scope, receive, send)
        finally:
            self._route.reset(route)

    async def _list_tools(
        self,
        context: ServerRequestContext[Any],
        params: mcp_types.PaginatedRequestParams | None,
    ) -> mcp_types.ListToolsResult:
        del context, params
        route = self._route.get()
        if route is None or route[0] not in self._leases:
            return mcp_types.ListToolsResult(tools=[])
        tools = self._pool.grouped_tools().get(route[1], {})
        return mcp_types.ListToolsResult(
            tools=[
                mcp_types.Tool(
                    name=tool.name,
                    description=tool.description,
                    input_schema=tool.input_schema,
                )
                for tool in tools.values()
            ]
        )

    async def _call_tool(
        self,
        context: ServerRequestContext[Any],
        params: mcp_types.CallToolRequestParams,
    ) -> mcp_types.CallToolResult:
        del context
        route = self._route.get()
        if route is None or route[0] not in self._leases:
            return mcp_types.CallToolResult(
                content=[mcp_types.TextContent(text="MCP bridge lease expired.")],
                is_error=True,
            )
        result = await self._pool.call(
            f"{route[1]}.{params.name}", _string_params(params.arguments or {})
        )
        return _call_result(result)
