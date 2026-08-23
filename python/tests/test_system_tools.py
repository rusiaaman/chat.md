"""Tests for the built-in ``system.*`` tools."""

from __future__ import annotations

import pytest

from chatmd.tools.system_tools import (
    FETCH_MCP_RESOURCE_FULL_NAME,
    execute_system_tool,
    get_grouped_system_tools,
    get_system_tool_definitions,
    is_system_tool,
)
from chatmd.types import (
    McpEmbeddedResource,
    McpReadResourceResult,
    McpResourceContents,
    McpTextContent,
    McpToolExecutionResult,
)


def test_fetch_resource_tool_is_namespaced_under_system() -> None:
    names = [tool.name for tool in get_system_tool_definitions()]
    assert names == ["system.fetch_mcp_resource"]
    assert is_system_tool("system.fetch_mcp_resource")
    assert not is_system_tool("wcgw.BashCommand")


def test_grouped_shape_matches_mcp_tools() -> None:
    grouped = get_grouped_system_tools()
    assert set(grouped) == {"system"}
    assert FETCH_MCP_RESOURCE_FULL_NAME in grouped["system"]


def test_schema_requires_both_arguments() -> None:
    schema = get_system_tool_definitions()[0].input_schema
    assert schema["required"] == ["serverId", "uri"]
    assert schema["additionalProperties"] is False


async def test_unknown_system_tool_returns_an_error_string() -> None:
    result = await execute_system_tool("system.nope", {}, _never_called)
    assert isinstance(result, str)
    assert "Unknown system tool" in result


@pytest.mark.parametrize(
    "params",
    [{}, {"serverId": "s"}, {"uri": "u"}, {"serverId": "", "uri": "u"}],
)
async def test_missing_arguments_are_reported(params: dict[str, str]) -> None:
    result = await execute_system_tool(FETCH_MCP_RESOURCE_FULL_NAME, params, _never_called)
    assert isinstance(result, str)
    assert "requires both serverId and uri" in result


async def test_contents_become_embedded_resources() -> None:
    async def read(server_id: str, uri: str) -> McpReadResourceResult:
        assert (server_id, uri) == ("docs", "file:///a.md")
        return McpReadResourceResult(
            contents=[McpResourceContents(uri=uri, mime_type="text/markdown", text="hi")]
        )

    result = await execute_system_tool(
        FETCH_MCP_RESOURCE_FULL_NAME, {"serverId": "docs", "uri": "file:///a.md"}, read
    )
    assert isinstance(result, McpToolExecutionResult)
    assert not result.is_error
    assert result.server_id == "system"
    item = result.content[0]
    assert isinstance(item, McpEmbeddedResource)
    assert item.resource.text == "hi"


async def test_empty_contents_are_explained_rather_than_returned_blank() -> None:
    async def read(server_id: str, uri: str) -> McpReadResourceResult:
        return McpReadResourceResult(contents=[])

    result = await execute_system_tool(
        FETCH_MCP_RESOURCE_FULL_NAME, {"serverId": "s", "uri": "u"}, read
    )
    assert isinstance(result, McpToolExecutionResult)
    item = result.content[0]
    assert isinstance(item, McpTextContent)
    assert "returned no contents" in item.text


async def test_a_failing_read_becomes_a_tool_error_not_an_exception() -> None:
    async def read(server_id: str, uri: str) -> McpReadResourceResult:
        raise RuntimeError("server went away")

    result = await execute_system_tool(
        FETCH_MCP_RESOURCE_FULL_NAME, {"serverId": "s", "uri": "u"}, read
    )
    assert isinstance(result, McpToolExecutionResult)
    assert result.is_error
    item = result.content[0]
    assert isinstance(item, McpTextContent)
    assert "server went away" in item.text


async def _never_called(server_id: str, uri: str) -> McpReadResourceResult:
    raise AssertionError("read_resource should not be reached")
