"""Provider-native tool schemas and the persistent chat representation."""

from __future__ import annotations

import hashlib
import json
import re
from collections import deque
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from typing import Any
from xml.sax.saxutils import escape, unescape

from ..tools.system_tools import get_system_tool_definitions
from ..types import (
    Content,
    ImageContent,
    McpToolDefinition,
    MessageParam,
    TextContent,
    ToolCall,
    ToolResultContent,
    ToolUseContent,
)

_VALID_NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_INVALID_NAME_RE = re.compile(r"[^A-Za-z0-9_-]")
_SERVER_RESULT_ID_RE = re.compile(r"^\s*<cmd:tool_id>([^<]*)</cmd:tool_id>[ \t]*(?:\r?\n)?")
MAX_TOOL_RESULT_TEXT_CHARACTERS = 100_000
TOOL_RESULT_TRUNCATION_MARKER = "\n...truncated"


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
    definitions.extend(tool for tools in grouped_tools.values() for tool in tools.values())
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


def render_tool_call_start(name: str) -> str:
    return f"\n<cmd:tool_call>\n<cmd:tool_name>{escape(name)}</cmd:tool_name>\n<cmd:arguments>"


def render_tool_arguments_delta(delta: str) -> str:
    return escape(delta)


def render_tool_call_end() -> str:
    return "</cmd:arguments>\n</cmd:tool_call>"


def render_tool_call(name: str, input_: Mapping[str, Any]) -> str:
    arguments = json.dumps(input_, separators=(",", ":"), ensure_ascii=False)
    return (
        render_tool_call_start(name)
        + render_tool_arguments_delta(arguments)
        + render_tool_call_end()
    )


def render_server_tool_result(result: str) -> str:
    return result


def tool_result_text(value: object) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "\n".join(filter(None, (tool_result_text(item) for item in value)))
    if isinstance(value, dict):
        for key in (
            "output",
            "aggregatedOutput",
            "stdout",
            "text",
            "content",
            "message",
            "error",
            "structuredContent",
            "structured_content",
        ):
            if key not in value:
                continue
            text = tool_result_text(value[key])
            if text:
                return text
        return ""
    dump = getattr(value, "model_dump", None)
    if callable(dump):
        return tool_result_text(dump(mode="json", by_alias=True, exclude_none=True))
    return "" if value is None else str(value)


def _truncated_tool_result_raw_text(
    raw_text: str, content: Sequence[TextContent | ImageContent]
) -> str:
    body = "\n\n".join(
        part.value if isinstance(part, TextContent) else f"![Tool result image]({part.path})"
        for part in content
    )
    if re.search(r"<tool_result>[\s\S]*?</tool_result>", raw_text):
        return f"<tool_result>\n{body}\n</tool_result>"
    return body


def _truncate_tool_result(result: ToolResultContent) -> ToolResultContent:
    text_characters = sum(
        len(part.value) for part in result.content if isinstance(part, TextContent)
    )
    if text_characters <= MAX_TOOL_RESULT_TEXT_CHARACTERS:
        return result

    remaining = MAX_TOOL_RESULT_TEXT_CHARACTERS - len(TOOL_RESULT_TRUNCATION_MARKER)
    content: list[TextContent | ImageContent] = []
    for part in result.content:
        if isinstance(part, ImageContent):
            content.append(part)
            continue
        if remaining <= 0:
            continue
        value = part.value[:remaining]
        remaining -= len(value)
        if value:
            content.append(TextContent(value=value))
    content.append(TextContent(value=TOOL_RESULT_TRUNCATION_MARKER))

    return replace(
        result,
        content=content,
        raw_text=_truncated_tool_result_raw_text(result.raw_text, content),
    )


def truncate_tool_results_for_api(
    messages: Sequence[MessageParam],
) -> list[MessageParam]:
    return [
        MessageParam(
            role=message.role,
            content=[
                _truncate_tool_result(item) if isinstance(item, ToolResultContent) else item
                for item in message.content
            ],
        )
        for message in messages
    ]


def assign_deterministic_tool_ids(
    messages: Sequence[MessageParam],
) -> list[MessageParam]:
    pending_ids: deque[str] = deque()
    call_index = 0
    orphan_result_index = 0
    normalized: list[MessageParam] = []

    for message in messages:
        if message.role == "user" and not any(
            isinstance(item, ToolResultContent) for item in message.content
        ):
            pending_ids.clear()
        content: list[Content] = []
        for item in message.content:
            if isinstance(item, ToolUseContent):
                call_id = f"chatmd_call_{call_index}"
                call_index += 1
                pending_ids.append(call_id)
                content.append(replace(item, id=call_id))
            elif isinstance(item, ToolResultContent):
                if pending_ids:
                    call_id = pending_ids.popleft()
                else:
                    call_id = f"chatmd_orphan_result_{orphan_result_index}"
                    orphan_result_index += 1
                content.append(replace(item, tool_use_id=call_id))
            else:
                content.append(item)
        normalized.append(MessageParam(role=message.role, content=content))
    return normalized


def parse_server_tool_result(value: str) -> tuple[str | None, str]:
    """Strip the legacy ID prefix while accepting current ID-free content."""
    matched = _SERVER_RESULT_ID_RE.match(value)
    if matched is None:
        return None, value
    return unescape(matched.group(1)), value[matched.end() :]


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
