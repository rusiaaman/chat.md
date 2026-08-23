"""Built-in tools that chat.md itself implements, not an MCP server.

Port of ``src/systemTools.ts``. These are advertised to the model alongside the
MCP tools and are addressed with the same ``serverId.toolName`` scheme, using the
reserved server id ``system``.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable

from ..types import (
    McpEmbeddedResource,
    McpReadResourceResult,
    McpRenderableContent,
    McpTextContent,
    McpToolDefinition,
    McpToolExecutionResult,
)

SYSTEM_TOOL_SERVER_ID = "system"
FETCH_MCP_RESOURCE_TOOL_NAME = "fetch_mcp_resource"
FETCH_MCP_RESOURCE_FULL_NAME = f"{SYSTEM_TOOL_SERVER_ID}.{FETCH_MCP_RESOURCE_TOOL_NAME}"

#: Reads an advertised MCP resource. Resources are only listed in the system
#: prompt, so without this the model can see that one exists but never read it.
_FETCH_MCP_RESOURCE_TOOL = McpToolDefinition(
    name=FETCH_MCP_RESOURCE_FULL_NAME,
    description=(
        "Read an MCP resource by server ID and exact resource URI. Use this when you "
        "need the actual contents of an advertised MCP resource."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "serverId": {
                "type": "string",
                "description": "Configured MCP server ID that advertised the resource.",
            },
            "uri": {
                "type": "string",
                "description": "Exact MCP resource URI to read from that server.",
            },
        },
        "required": ["serverId", "uri"],
        "additionalProperties": False,
    },
)

ReadResource = Callable[[str, str], Awaitable[McpReadResourceResult]]


def get_system_tool_definitions() -> list[McpToolDefinition]:
    """Every built-in tool, in the order they appear in the system prompt."""
    return [_FETCH_MCP_RESOURCE_TOOL]


def get_grouped_system_tools() -> dict[str, dict[str, McpToolDefinition]]:
    """Built-in tools in the same ``{server: {name: tool}}`` shape as MCP tools."""
    return {
        SYSTEM_TOOL_SERVER_ID: {tool.name: tool for tool in get_system_tool_definitions()}
    }


def is_system_tool(full_name: str) -> bool:
    return any(tool.name == full_name for tool in get_system_tool_definitions())


async def execute_system_tool(
    full_name: str,
    params: dict[str, str],
    read_resource: ReadResource,
) -> McpToolExecutionResult | str:
    """Run a built-in tool.

    ``read_resource`` is injected rather than imported so this module stays free of
    any dependency on the MCP pool.
    """
    if full_name != FETCH_MCP_RESOURCE_FULL_NAME:
        return f'Error: Unknown system tool "{full_name}".'

    server_id = params.get("serverId")
    uri = params.get("uri")
    if not server_id or not uri:
        return "Error: system.fetch_mcp_resource requires both serverId and uri parameters."

    try:
        result = await read_resource(server_id, uri)
    except Exception as error:  # noqa: BLE001 - a failed read is a tool error, not a crash
        return McpToolExecutionResult(
            server_id=SYSTEM_TOOL_SERVER_ID,
            tool_name=FETCH_MCP_RESOURCE_FULL_NAME,
            is_error=True,
            content=[
                McpTextContent(
                    text=(
                        f'Failed to read MCP resource "{uri}" from server '
                        f'"{server_id}": {error}'
                    )
                )
            ],
        )

    return McpToolExecutionResult(
        server_id=SYSTEM_TOOL_SERVER_ID,
        tool_name=FETCH_MCP_RESOURCE_FULL_NAME,
        is_error=False,
        content=_to_renderable_content(result, server_id, uri),
    )


def _to_renderable_content(
    result: McpReadResourceResult,
    server_id: str,
    uri: str,
) -> list[McpRenderableContent]:
    if not result.contents:
        return [
            McpTextContent(
                text=(
                    f'MCP resource "{uri}" from server "{server_id}" returned no contents.'
                )
            )
        ]
    return [McpEmbeddedResource(resource=item) for item in result.contents]
