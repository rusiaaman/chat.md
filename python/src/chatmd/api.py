"""The file-free library API.

Everything else in this package works on a ``.chat.md`` file. This module is the
same engine driven from memory: give it a message list, get a completed turn back,
run whatever tools it asked for, and get the new history entries to append. No
file, no lock, no listener.

The shapes are the same ones the parser produces and the streamer writes, so a
conversation can move between a file and memory without translation.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator, Sequence
from pathlib import Path

from .config.model import ChatmdConfig, ResolvedConfig
from .executable import find_chatmd_command
from .mcp.manager import McpPool
from .mcp.sdk_bridge import SdkMcpBridge
from .parser.assistant_content import parse_assistant_content
from .parser.tool_result import parse_tool_result_content
from .providers.client import attach_mcp_bridge, create_client
from .providers.native_tools import (
    NativeToolDefinition,
    build_native_tools,
    render_tool_call,
    uses_native_tools,
)
from .providers.prompt import build_system_prompt
from .render import strip_thinking_sections
from .tools.call_parser import (
    CMD_WAIT_TOOL_RESULT_TAG,
    find_all_tool_calls,
    find_wait_marker,
    parse_tool_call,
)
from .tools.result_format import format_mcp_result, format_tool_result
from .types import (
    Content,
    McpToolExecutionResult,
    MessageParam,
    StreamEvent,
    TextContent,
    TextDelta,
    ThinkingContent,
    ThinkingDelta,
    ThinkingPayloadDelta,
    ToolCall,
    ToolResultContent,
    ToolResultDelta,
    ToolUseContent,
    ToolUseDelta,
    TurnResult,
    Usage,
    UsageDelta,
)

logger = logging.getLogger(__name__)


def stream_turn(
    config: ResolvedConfig,
    messages: Sequence[MessageParam],
    system_prompt: str,
    tools: Sequence[NativeToolDefinition],
    *,
    base_dir: str | Path | None = None,
) -> AsyncIterator[StreamEvent]:
    """Raw event stream for one turn, for callers that want to render it themselves."""
    chat_path = Path(base_dir or Path.cwd()) / "in-memory.chat.md"
    return create_client(config, chat_path).stream(
        list(messages), system_prompt, tools, base_dir=base_dir
    )


async def complete_turn(
    config: ResolvedConfig,
    messages: Sequence[MessageParam],
    system_prompt: str,
    tools: Sequence[NativeToolDefinition],
    *,
    base_dir: str | Path | None = None,
) -> TurnResult:
    return await _complete_turn(
        config, messages, system_prompt, tools, base_dir, None
    )


async def _complete_turn(
    config: ResolvedConfig,
    messages: Sequence[MessageParam],
    system_prompt: str,
    tools: Sequence[NativeToolDefinition],
    base_dir: str | Path | None,
    mcp_bridge: SdkMcpBridge | None,
) -> TurnResult:
    """Run one turn to completion and collect it.

    The end-of-batch marker is stripped from the text: it is a stream-control
    signal the model is asked to emit, never content. Tool calls are collected from
    the assistant text only, so a call written inside reasoning is not a call.
    """
    chat_path = Path(base_dir or Path.cwd()) / "in-memory.chat.md"
    client = attach_mcp_bridge(create_client(config, chat_path), mcp_bridge)
    managed_tools = client.manages_tools
    text_parts: list[str] = []
    managed_text: list[str] = []
    managed_content: list[Content] = []
    thinking_text: list[str] = []
    thinking_blocks: list[ThinkingContent] = []
    usage: Usage | None = None

    def close_managed_text() -> None:
        value = "".join(managed_text)
        managed_text.clear()
        if value:
            managed_content.append(TextContent(value=value))

    def close_thinking(model: str | None, payload: object) -> None:
        joined = "".join(thinking_text)
        thinking_text.clear()
        if not joined and payload is None:
            return
        block = ThinkingContent(
            value=joined,
            model=model,
            payload=payload,  # type: ignore[arg-type]
        )
        thinking_blocks.append(block)
        if managed_tools:
            managed_content.append(block)

    async for event in client.stream(
        list(messages), system_prompt, tools, base_dir=base_dir
    ):
        if isinstance(event, TextDelta):
            text_parts.append(event.text)
            if managed_tools:
                close_thinking(None, None)
                managed_text.append(event.text)
        elif isinstance(event, ThinkingDelta):
            if managed_tools:
                close_managed_text()
            thinking_text.append(event.text)
        elif isinstance(event, ThinkingPayloadDelta):
            if managed_tools:
                close_managed_text()
            close_thinking(event.model, event.payload)
        elif isinstance(event, ToolUseDelta):
            close_managed_text()
            close_thinking(None, None)
            managed_content.append(
                ToolUseContent(
                    id=event.id,
                    name=event.name,
                    input=event.input,
                    raw_xml=render_tool_call(event.id, event.name, event.input),
                    server_tool=event.server_tool,
                )
            )
        elif isinstance(event, ToolResultDelta):
            close_managed_text()
            close_thinking(None, None)
            body = event.content
            if event.is_error and not body.lstrip().startswith("Error:"):
                body = "Error: " + body
            raw_text = format_tool_result(body.strip())
            native_content, raw_text = parse_tool_result_content(
                raw_text,
                Path(base_dir) if base_dir is not None else None,
            )
            managed_content.append(
                ToolResultContent(
                    tool_use_id=event.tool_use_id,
                    name=event.name,
                    content=native_content,
                    raw_text=raw_text,
                    is_error=event.is_error,
                    server_tool=event.server_tool,
                )
            )
        elif isinstance(event, UsageDelta):
            usage = (
                event.usage
                if managed_tools or usage is None
                else usage.merge(event.usage)
            )

    # Reasoning that never got a payload is still worth keeping as raw text.
    close_managed_text()
    close_thinking(None, None)

    raw = "".join(text_parts)
    marker_at = find_wait_marker(raw)
    ended_on_marker = marker_at != -1
    text = raw[:marker_at] if ended_on_marker else raw

    if managed_tools:
        calls: list[ToolCall] = []
        content = managed_content
    else:
        calls = [
            call
            for call in (parse_tool_call(found) for found in find_all_tool_calls(text))
            if call is not None
        ]

        parsed_content = parse_assistant_content(text, None)
        structured_uses = [
            item for item in parsed_content if isinstance(item, ToolUseContent)
        ]
        calls = [
            ToolCall(
                name=call.name,
                params=call.params,
                id=call.id or structured_uses[index].id,
                input=call.input or structured_uses[index].input,
                raw_xml=call.raw_xml,
            )
            for index, call in enumerate(calls)
        ]
        content = [*thinking_blocks, *parsed_content]

    return TurnResult(
        text=text,
        thinking=thinking_blocks,
        tool_calls=calls,
        content=content,
        usage=usage or getattr(client, "last_usage", None),
        ended_on_wait_marker=ended_on_marker,
    )


async def run_tool_calls(
    calls: Sequence[ToolCall],
    pool: McpPool,
    *,
    doc_dir: str | Path | None = None,
    assets_path: str = "cmdassets",
) -> list[MessageParam]:
    """Execute tool calls and return the history entries carrying their results.

    One user message per call, matching how a document records them: the model sees
    each result as its own turn, in the order it asked for them. A failing tool
    yields a message describing the failure rather than raising, because the model
    recovering from a tool error is normal and losing the conversation is not.
    """
    directory = Path(doc_dir) if doc_dir is not None else Path.cwd()
    results: list[MessageParam] = []

    for call in calls:
        outcome = await pool.call(call.name, call.params)
        if isinstance(outcome, McpToolExecutionResult):
            body = format_mcp_result(outcome, directory, assets_path)
        else:
            body = outcome
        raw_text = format_tool_result(body.strip())
        native_content, raw_text = parse_tool_result_content(raw_text, directory)
        results.append(
            MessageParam(
                role="user",
                content=[
                    ToolResultContent(
                        tool_use_id=call.id or f"chatmd_call_{len(results)}",
                        name=call.name,
                        content=native_content,
                        raw_text=raw_text,
                        is_error=(
                            outcome.is_error
                            if isinstance(outcome, McpToolExecutionResult)
                            else body.lstrip().startswith("Error:")
                        ),
                    )
                ],
            )
        )
    return results


class ChatSession:
    """An in-memory conversation, tools included.

    Holds the configuration and the MCP pool so a caller can keep taking turns
    without reassembling either. The message list stays the caller's: every method
    returns new entries rather than mutating what was passed in.
    """

    def __init__(
        self,
        config: ChatmdConfig,
        pool: McpPool,
        *,
        config_name: str | None = None,
        overrides: dict[str, object] | None = None,
    ) -> None:
        self.config = config
        self.pool = pool
        self.resolved = config.resolve(
            config_name=config_name,
            overrides=dict(overrides) if overrides else None,
        )

    def system_prompt(self, custom: str = "") -> str:
        """The full system prompt, including the tools the pool advertises."""
        if self.resolved.provider in ("claude-code", "codex"):
            return custom
        return build_system_prompt(
            custom,
            self.pool.grouped_tools(),
            self.pool.grouped_resources(),
            cli_command=find_chatmd_command(),
            native_tools=uses_native_tools(self.resolved.model_name or ""),
        )

    async def turn(
        self,
        messages: Sequence[MessageParam],
        *,
        custom_system_prompt: str = "",
        doc_dir: str | Path | None = None,
    ) -> list[MessageParam]:
        """One assistant turn plus any tool results, as new history entries."""
        native_tools = build_native_tools(self.pool.grouped_tools())
        result = await _complete_turn(
            self.resolved,
            messages,
            self.system_prompt(custom_system_prompt),
            native_tools,
            doc_dir,
            self.pool.sdk_bridge if isinstance(self.pool, McpPool) else None,
        )

        new_entries: list[MessageParam] = []
        assistant_content: list[Content] = []
        for item in result.content:
            if isinstance(item, ToolResultContent):
                if assistant_content:
                    new_entries.append(
                        MessageParam(role="assistant", content=assistant_content)
                    )
                    assistant_content = []
                new_entries.append(MessageParam(role="user", content=[item]))
            else:
                assistant_content.append(item)
        if assistant_content:
            new_entries.append(MessageParam(role="assistant", content=assistant_content))
        if result.tool_calls:
            new_entries.extend(
                await run_tool_calls(
                    result.tool_calls,
                    self.pool,
                    doc_dir=doc_dir,
                    assets_path=self.resolved.assets_path,
                )
            )
        return new_entries

    async def run(
        self,
        messages: Sequence[MessageParam],
        *,
        custom_system_prompt: str = "",
        doc_dir: str | Path | None = None,
        max_rounds: int | None = None,
    ) -> list[MessageParam]:
        """Take turns until the model stops calling tools.

        Returns the whole conversation, the messages passed in included, so the
        result can be handed straight back in for another round.
        """
        history = list(messages)
        rounds = 0
        while max_rounds is None or rounds < max_rounds:
            added = await self.turn(
                history, custom_system_prompt=custom_system_prompt, doc_dir=doc_dir
            )
            if not added:
                break
            history.extend(added)
            if self.resolved.provider in ("claude-code", "codex"):
                break
            # A turn that ran no tools has nothing left to feed back.
            if not any(entry.role == "user" for entry in added):
                break
            rounds += 1
        return history


def assistant_text(messages: Sequence[MessageParam]) -> str:
    """The last assistant turn's text, with any tool calls stripped out.

    A convenience for callers that just want the answer.
    """
    for message in reversed(messages):
        if message.role != "assistant":
            continue
        parts = [
            block.value for block in message.content if isinstance(block, TextContent)
        ]
        text = "\n\n".join(parts)
        for call in find_all_tool_calls(strip_thinking_sections(text)):
            text = text.replace(call, "")
        return text.replace(CMD_WAIT_TOOL_RESULT_TAG, "").strip()
    return ""
