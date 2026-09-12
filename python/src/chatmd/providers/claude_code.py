"""Claude Agent SDK provider using the local Claude Code subscription login."""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator, Sequence
from pathlib import Path
from typing import Any

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeSDKClient,
    ResultMessage,
    ServerToolResultBlock,
    ServerToolUseBlock,
    TextBlock,
    ThinkingBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)
from claude_agent_sdk import (
    StreamEvent as ClaudeStreamEvent,
)

from ..config.model import ResolvedConfig
from ..executable import find_chatmd_command
from ..mcp.sdk_bridge import SdkMcpBridge
from ..paths import config_path
from ..types import (
    MessageParam,
    StreamEvent,
    TextDelta,
    ThinkingDelta,
    ToolResultDelta,
    ToolUseDelta,
    Usage,
    UsageDelta,
)
from .agent_context import build_agent_prompt
from .native_tools import NativeToolDefinition
from .prompt import chatmd_agent_section
from .sdk_config import claude_agent_options

logger = logging.getLogger(__name__)


def _json_text(value: object) -> str:
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, indent=2, default=str)


def _mcp_name(name: str, server_names: Sequence[str]) -> str | None:
    for server_name in sorted(server_names, key=len, reverse=True):
        prefix = f"mcp__{server_name}__"
        if name.startswith(prefix):
            return f"{server_name}.{name[len(prefix):]}"
    return None


def _usage(value: dict[str, Any] | None) -> Usage | None:
    if value is None:
        return None
    return Usage(
        input_tokens=value.get("input_tokens"),
        output_tokens=value.get("output_tokens"),
        cache_read_tokens=value.get("cache_read_input_tokens"),
        cache_write_tokens=value.get("cache_creation_input_tokens"),
    )


class ClaudeCodeClient:
    """Runs one fresh Claude Code session for every editable ChatMD turn."""

    manages_tools = True

    def __init__(
        self, config: ResolvedConfig, chat_path: Path, mcp_bridge: SdkMcpBridge | None
    ) -> None:
        self.config = config
        self.chat_path = chat_path.resolve()
        self.last_usage: Usage | None = None
        self._active_client: ClaudeSDKClient | None = None
        self._mcp_bridge = mcp_bridge

    def cancel(self) -> None:
        client = self._active_client
        if client is not None:
            asyncio.get_running_loop().create_task(client.interrupt())

    def set_mcp_bridge(self, mcp_bridge: SdkMcpBridge | None) -> None:
        self._mcp_bridge = mcp_bridge

    async def stream(
        self,
        messages: list[MessageParam],
        system_prompt: str,
        tools: Sequence[NativeToolDefinition],
        *,
        base_dir: str | Path | None,
    ) -> AsyncIterator[StreamEvent]:
        del tools, base_dir
        self.last_usage = None
        prompt = build_agent_prompt(
            messages,
            self.chat_path,
            str(config_path()),
            system_prompt,
            chatmd_agent_section(find_chatmd_command()),
        )
        lease = await self._mcp_bridge.acquire() if self._mcp_bridge is not None else None
        options = claude_agent_options(
            self.config,
            str(self.chat_path.parent),
            lease.urls if lease is not None else {},
            lease.claude_allowed_tools if lease is not None else [],
        )
        emitted_tools: set[str] = set()
        emitted_results: set[str] = set()
        tool_names: dict[str, tuple[str, bool]] = {}
        saw_partial_text = False
        saw_partial_thinking = False

        async with ClaudeSDKClient(options) as client:
            self._active_client = client
            try:
                await client.query(prompt)
                async for message in client.receive_response():
                    if isinstance(message, ClaudeStreamEvent):
                        event = message.event
                        if event.get("type") != "content_block_delta":
                            continue
                        delta = event.get("delta")
                        if not isinstance(delta, dict):
                            continue
                        if delta.get("type") == "text_delta":
                            text = delta.get("text")
                            if isinstance(text, str) and text:
                                saw_partial_text = True
                                yield TextDelta(text)
                        elif delta.get("type") == "thinking_delta":
                            thinking = delta.get("thinking")
                            if isinstance(thinking, str) and thinking:
                                saw_partial_thinking = True
                                yield ThinkingDelta(thinking)
                        continue

                    if isinstance(message, AssistantMessage):
                        for block in message.content:
                            if isinstance(block, TextBlock):
                                if not saw_partial_text and block.text:
                                    yield TextDelta(block.text)
                            elif isinstance(block, ThinkingBlock):
                                if not saw_partial_thinking and block.thinking:
                                    yield ThinkingDelta(block.thinking)
                            elif isinstance(block, (ToolUseBlock, ServerToolUseBlock)):
                                if block.id in emitted_tools:
                                    continue
                                emitted_tools.add(block.id)
                                native_name = _mcp_name(
                                    block.name, tuple(self.config.mcp_servers)
                                )
                                name = native_name or block.name
                                server_tool = native_name is None
                                tool_names[block.id] = (name, server_tool)
                                yield ToolUseDelta(
                                    id=block.id,
                                    name=name,
                                    input=block.input,
                                    server_tool=server_tool,
                                )
                            elif isinstance(
                                block, (ToolResultBlock, ServerToolResultBlock)
                            ):
                                if block.tool_use_id in emitted_results:
                                    continue
                                emitted_results.add(block.tool_use_id)
                                name, server_tool = tool_names.get(
                                    block.tool_use_id, ("tool", True)
                                )
                                yield ToolResultDelta(
                                    tool_use_id=block.tool_use_id,
                                    name=name,
                                    content=_json_text(block.content),
                                    is_error=bool(getattr(block, "is_error", False)),
                                    server_tool=server_tool,
                                )
                        current_usage = _usage(message.usage)
                        if current_usage is not None:
                            self.last_usage = current_usage
                        saw_partial_text = False
                        saw_partial_thinking = False
                        continue

                    if isinstance(message, UserMessage) and isinstance(message.content, list):
                        for block in message.content:
                            if not isinstance(
                                block, (ToolResultBlock, ServerToolResultBlock)
                            ):
                                continue
                            if block.tool_use_id in emitted_results:
                                continue
                            emitted_results.add(block.tool_use_id)
                            name, server_tool = tool_names.get(
                                block.tool_use_id, ("tool", True)
                            )
                            yield ToolResultDelta(
                                tool_use_id=block.tool_use_id,
                                name=name,
                                content=_json_text(
                                    message.tool_use_result
                                    if message.tool_use_result is not None
                                    else block.content
                                ),
                                is_error=bool(getattr(block, "is_error", False)),
                                server_tool=server_tool,
                            )
                        continue

                    if isinstance(message, ResultMessage):
                        current_usage = _usage(message.usage)
                        if current_usage is not None:
                            self.last_usage = current_usage
                            yield UsageDelta(current_usage)
                        if message.is_error:
                            detail = message.result or "; ".join(message.errors or [])
                            raise RuntimeError(
                                detail or f"Claude Code ended with {message.subtype}"
                            )
            finally:
                self._active_client = None
                if lease is not None:
                    lease.release()
