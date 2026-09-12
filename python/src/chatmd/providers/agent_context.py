"""Prompt context for subscription-backed coding-agent SDKs."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

from chatmd.types import MessageParam, TextContent, ToolResultContent, ToolUseContent

RECENT_TOOL_PAIRS = 5
TOOL_PREVIEW_CHARACTERS = 100


@dataclass(frozen=True)
class ToolActivity:
    ordinal: int
    call: ToolUseContent
    result: ToolResultContent | None


def chatmd_format_instructions(config_location: str) -> str:
    return f"""## ChatMD document format

The editable `.chat.md` file is the source of truth. Top-level blocks use `# %% system`,
`# %% user`, `# %% assistant`, `# %% tool_execute`, and `# %% settings`. Assistant
reasoning may appear under `## %% thinking`; visible answers use `## %% text`. Tool
calls are stored as `<cmd:tool_call>` blocks and results are stored in corresponding
`# %% tool_execute` blocks; an SDK-written result may start with `<cmd:tool_id>` to
preserve its call association. SDK built-in activity is recorded inside inert
`## %% server_tool` and `## %% server_tool_results` assistant sections. MCP activity
from an SDK still uses ordinary tool-call and tool-execute blocks. When history is sent
to any provider, both forms become the same native tool-use/tool-result message structure.

Markdown attachments use paths relative to the directory containing the chat file.
Read the chat file or a referenced attachment when a detail omitted from the pruned
transcript is relevant enough to check.

ChatMD configuration lives at {config_location}. Provider profiles are named entries in
`apiConfigs`; select one globally with `selectedConfig` or per chat in the preamble.
Add, edit, or remove shared MCP servers through `mcpServers`."""


def _message_text(message: MessageParam) -> str:
    return "\n\n".join(
        item.value.strip()
        for item in message.content
        if isinstance(item, TextContent) and item.value.strip()
    )


def _tool_activities(messages: list[MessageParam]) -> list[ToolActivity]:
    results = {
        item.tool_use_id: item
        for message in messages
        for item in message.content
        if isinstance(item, ToolResultContent)
    }
    calls = [
        item
        for message in messages
        for item in message.content
        if isinstance(item, ToolUseContent)
    ]
    return [
        ToolActivity(ordinal=index, call=call, result=results.get(call.id))
        for index, call in enumerate(calls, start=1)
    ]


def _preview(value: str) -> str:
    compact = re.sub(r"\s+", " ", value).strip()
    if len(compact) <= TOOL_PREVIEW_CHARACTERS:
        return compact
    return compact[:TOOL_PREVIEW_CHARACTERS] + "…"


def _compact_tool_index(activities: list[ToolActivity]) -> str:
    if not activities:
        return "No tool activity has been recorded."
    lines = []
    for activity in activities:
        arguments = json.dumps(activity.call.input, separators=(",", ":"), ensure_ascii=False)
        result = activity.result.raw_text if activity.result is not None else "[result missing]"
        lines.append(
            f"{activity.ordinal}. {activity.call.name} | "
            f"arguments={_preview(arguments)} | result={_preview(result)}"
        )
    return "\n".join(lines)


def _recent_tool_activity(activities: list[ToolActivity]) -> str:
    recent = activities[-RECENT_TOOL_PAIRS:]
    if not recent:
        return "No recent tool activity."
    parts = []
    for activity in recent:
        result = (
            activity.result.raw_text
            if activity.result is not None
            else "[Tool result is missing; the turn may have been interrupted.]"
        )
        parts.append(
            f"Tool #{activity.ordinal}: {activity.call.name}\n"
            f"{activity.call.raw_xml}\n\n"
            f"# %% tool_execute\n{result}"
        )
    return "\n\n".join(parts)


def _pruned_messages(messages: list[MessageParam]) -> str:
    blocks = []
    for message in messages:
        content = _message_text(message)
        if content:
            blocks.append(f"# %% {message.role}\n{content}")
    return "\n\n".join(blocks) or "[No visible user or assistant text.]"


def build_agent_prompt(
    messages: list[MessageParam],
    chat_path: Path,
    config_location: str,
    custom_system_prompt: str,
    agent_section: str,
) -> str:
    """Build one stateless SDK turn from the editable document."""
    activities = _tool_activities(messages)
    custom = (
        f"## Chat-specific system instructions\n{custom_system_prompt.strip()}"
        if custom_system_prompt.strip()
        else ""
    )
    sections = [
        "You are responding to the latest user turn in an editable ChatMD transcript.",
        f"Current chat file: {chat_path}",
        chatmd_format_instructions(config_location),
        custom,
        agent_section,
        "## Pruned visible transcript\n" + _pruned_messages(messages),
        "## Complete tool activity index\n" + _compact_tool_index(activities),
        "## Most recent tool calls and results in full\n" + _recent_tool_activity(activities),
        "Continue the latest request. Use the current chat file when omitted details matter.",
    ]
    return "\n\n".join(section for section in sections if section.strip())
