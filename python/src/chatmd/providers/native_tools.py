"""Provider-native tool schemas and the persistent chat representation."""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any
from xml.sax.saxutils import escape, unescape

from ..tools.system_tools import get_system_tool_definitions
from ..types import McpToolDefinition, ToolCall

_VALID_NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_INVALID_NAME_RE = re.compile(r"[^A-Za-z0-9_-]")


@dataclass(frozen=True)
class NativeToolDefinition:
    """One MCP tool plus the API-safe name exposed to a model provider."""

    api_name: str
    name: str
    description: str | None
    input_schema: dict[str, Any]


def uses_native_tools(model_name: str) -> bool:
    return not model_name.lower().startswith("google")


def native_tool_name(name: str) -> str:
    """Return a stable OpenAI/Anthropic-compatible alias for an MCP tool name."""
    if _VALID_NAME_RE.fullmatch(name):
        return name
    readable = _INVALID_NAME_RE.sub("_", name).strip("_") or "tool"
    digest = hashlib.sha256(name.encode("utf-8")).hexdigest()[:10]
    return f"{readable[:53]}_{digest}"


def build_native_tools(
    grouped_tools: Mapping[str, Mapping[str, McpToolDefinition]],
) -> list[NativeToolDefinition]:
    definitions = [*get_system_tool_definitions()]
    definitions.extend(
        tool for tools in grouped_tools.values() for tool in tools.values()
    )
    return [
        NativeToolDefinition(
            api_name=native_tool_name(tool.name),
            name=tool.name,
            description=tool.description,
            input_schema=tool.input_schema,
        )
        for tool in definitions
    ]


def canonical_tool_name(api_name: str, tools: Sequence[NativeToolDefinition]) -> str:
    return next((tool.name for tool in tools if tool.api_name == api_name), api_name)


def api_tool_name(name: str, tools: Sequence[NativeToolDefinition]) -> str:
    return next((tool.api_name for tool in tools if tool.name == name), native_tool_name(name))


def anthropic_tool_schemas(tools: Sequence[NativeToolDefinition]) -> list[dict[str, Any]]:
    return [
        {
            "name": tool.api_name,
            "description": tool.description or "",
            "input_schema": tool.input_schema,
        }
        for tool in tools
    ]


def openai_chat_tool_schemas(tools: Sequence[NativeToolDefinition]) -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": tool.api_name,
                "description": tool.description or "",
                "parameters": tool.input_schema,
            },
        }
        for tool in tools
    ]


def openai_responses_tool_schemas(
    tools: Sequence[NativeToolDefinition],
) -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "name": tool.api_name,
            "description": tool.description or "",
            "parameters": tool.input_schema,
        }
        for tool in tools
    ]


def render_tool_call_start(call_id: str, name: str) -> str:
    return (
        "\n<cmd:tool_call>\n"
        f"<cmd:tool_id>{escape(call_id)}</cmd:tool_id>\n"
        f"<cmd:tool_name>{escape(name)}</cmd:tool_name>\n"
        "<cmd:arguments>"
    )


def render_tool_arguments_delta(delta: str) -> str:
    return escape(delta)


def render_tool_call_end() -> str:
    return "</cmd:arguments>\n</cmd:tool_call>"


def decode_tool_arguments(value: str) -> dict[str, Any] | None:
    try:
        parsed = json.loads(unescape(value))
    except (json.JSONDecodeError, TypeError):
        return None
    return parsed if isinstance(parsed, dict) else None


def params_from_input(value: Mapping[str, Any]) -> dict[str, str]:
    return {
        key: item if isinstance(item, str) else json.dumps(item, separators=(",", ":"))
        for key, item in value.items()
    }


def input_from_params(value: Mapping[str, str]) -> dict[str, Any]:
    output: dict[str, Any] = {}
    for key, item in value.items():
        try:
            output[key] = json.loads(item)
        except json.JSONDecodeError:
            output[key] = item
    return output


def tool_call_input(call: ToolCall) -> dict[str, Any]:
    return call.input if call.input is not None else input_from_params(call.params)
