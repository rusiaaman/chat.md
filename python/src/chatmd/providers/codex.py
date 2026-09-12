"""Codex SDK provider using the local ChatGPT subscription login."""

from __future__ import annotations

import asyncio
import json
import re
from collections.abc import AsyncIterator, Sequence
from pathlib import Path
from typing import Any

from openai_codex import ApprovalMode, AsyncCodex, CodexConfig, Sandbox
from openai_codex.generated.v2_all import (
    AgentMessageDeltaNotification,
    ItemCompletedNotification,
    ItemStartedNotification,
    McpToolCallThreadItem,
    ReasoningSummaryTextDeltaNotification,
    ThreadTokenUsageUpdatedNotification,
)
from openai_codex.types import ReasoningEffort as CodexReasoningEffort

from ..config.model import ResolvedConfig
from ..executable import find_chatmd_command
from ..mcp.sdk_bridge import SdkMcpBridge, SdkMcpBridgeLease
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
from .sdk_config import (
    allow_all_codex_mcp_tools,
    codex_mcp_servers,
    codex_profile_parts,
    isolated_codex_environment,
    subscription_env,
)

_TOOL_NAMES = {
    "commandExecution": "command_execution",
    "fileChange": "apply_patch",
    "plan": "update_plan",
    "collabAgentToolCall": "collaboration",
    "dynamicToolCall": "dynamic_tool",
    "imageView": "view_image",
    "sleep": "sleep",
    "imageGeneration": "image_generation",
    "webSearch": "web_search",
    "contextCompaction": "compact",
}
_MCP_OVERRIDE = re.compile(r"^\s*mcp_servers(?:\.|=)")


def _json_text(value: object) -> str:
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, indent=2, default=str)


def _sandbox(value: object) -> Sandbox | None:
    if not isinstance(value, str):
        return None
    return {
        "read-only": Sandbox.read_only,
        "workspace-write": Sandbox.workspace_write,
        "danger-full-access": Sandbox.full_access,
        "full-access": Sandbox.full_access,
    }.get(value)


def _approval(value: object) -> ApprovalMode:
    return ApprovalMode.deny_all if value == "never" else ApprovalMode.auto_review


def _reasoning_effort(value: object) -> CodexReasoningEffort | None:
    if not isinstance(value, str):
        return None
    return next((effort for effort in CodexReasoningEffort if effort.value == value), None)


def _item_data(item: object) -> dict[str, Any]:
    dump = getattr(item, "model_dump", None)
    if callable(dump):
        value = dump(mode="json", by_alias=True, exclude_none=True)
        return value if isinstance(value, dict) else {"value": value}
    return {"value": str(item)}


def _tool_input(item: object) -> dict[str, Any]:
    data = _item_data(item)
    for key in (
        "aggregatedOutput",
        "durationMs",
        "exitCode",
        "result",
        "error",
        "status",
        "id",
        "type",
    ):
        data.pop(key, None)
    return data


def _tool_result(item: object) -> str:
    data = _item_data(item)
    for key in ("id", "type"):
        data.pop(key, None)
    return _json_text(data)


class CodexSdkClient:
    """Runs one fresh ephemeral Codex thread for every ChatMD turn."""

    manages_tools = True

    def __init__(
        self, config: ResolvedConfig, chat_path: Path, mcp_bridge: SdkMcpBridge | None
    ) -> None:
        self.config = config
        self.chat_path = chat_path.resolve()
        self.last_usage: Usage | None = None
        self._active_handle: Any | None = None
        self._mcp_bridge = mcp_bridge

    def cancel(self) -> None:
        handle = self._active_handle
        if handle is not None:
            asyncio.get_running_loop().create_task(handle.interrupt())

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
        options, thread_options, turn_options = codex_profile_parts(self.config)
        configured_env = options.get("env")
        environment_overrides = subscription_env(
            configured_env if isinstance(configured_env, dict) else {}, "codex"
        )
        working_directory = thread_options.get("workingDirectory")
        cwd = (
            working_directory if isinstance(working_directory, str) else str(self.chat_path.parent)
        )
        with isolated_codex_environment(environment_overrides) as isolated_environment:
            lease = await self._mcp_bridge.acquire() if self._mcp_bridge is not None else None
            try:
                async for event in self._stream_with_lease(
                    prompt,
                    options,
                    thread_options,
                    turn_options,
                    isolated_environment,
                    cwd,
                    lease,
                ):
                    yield event
            finally:
                if lease is not None:
                    lease.release()

    async def _stream_with_lease(
        self,
        prompt: str,
        options: dict[str, Any],
        thread_options: dict[str, Any],
        turn_options: dict[str, Any],
        isolated_environment: dict[str, str],
        cwd: str,
        lease: SdkMcpBridgeLease | None,
    ) -> AsyncIterator[StreamEvent]:
        config_values = options.get("config")
        thread_config = dict(config_values) if isinstance(config_values, dict) else {}
        thread_config.pop("model_provider", None)
        thread_config.pop("model_providers", None)
        thread_config["forced_login_method"] = "chatgpt"
        thread_config.setdefault("approvals_reviewer", "auto_review")
        thread_config["mcp_servers"] = allow_all_codex_mcp_tools(
            codex_mcp_servers(lease.codex_urls if lease is not None else {})
        )
        if "webSearchMode" in thread_options:
            thread_config["web_search"] = thread_options["webSearchMode"]
        if "networkAccessEnabled" in thread_options:
            thread_config.setdefault("sandbox_workspace_write", {})
            sandbox_config = thread_config["sandbox_workspace_write"]
            if isinstance(sandbox_config, dict):
                sandbox_config["network_access"] = thread_options["networkAccessEnabled"]
        additional_directories = thread_options.get("additionalDirectories")
        if isinstance(additional_directories, list):
            thread_config.setdefault("sandbox_workspace_write", {})
            sandbox_config = thread_config["sandbox_workspace_write"]
            if isinstance(sandbox_config, dict):
                sandbox_config["writable_roots"] = additional_directories

        overrides = options.get("configOverrides")
        configured_overrides = (
            tuple(
                value
                for value in overrides
                if isinstance(value, str) and not _MCP_OVERRIDE.match(value)
            )
            if isinstance(overrides, list)
            else ()
        )
        codex_bin = options.get("codexPathOverride")
        codex_config = CodexConfig(
            codex_bin=codex_bin if isinstance(codex_bin, str) else None,
            config_overrides=configured_overrides,
            cwd=cwd,
            env=isolated_environment,
        )
        sandbox = _sandbox(thread_options.get("sandboxMode") or "danger-full-access")
        approval = _approval(thread_options.get("approvalPolicy") or "never")
        effort_value = (
            turn_options.get("effort")
            or thread_options.get("modelReasoningEffort")
            or self.config.reasoning_effort
        )
        effort = _reasoning_effort(effort_value)
        summary = turn_options.get("summary")
        tool_names: dict[str, tuple[str, bool]] = {}

        async with AsyncCodex(codex_config) as codex:
            thread = await codex.thread_start(
                approval_mode=approval,
                base_instructions=thread_options.get("baseInstructions"),
                config=thread_config,
                cwd=cwd,
                developer_instructions=thread_options.get("developerInstructions"),
                ephemeral=True,
                model=thread_options.get("model") or self.config.model_name,
                model_provider=None,
                personality=thread_options.get("personality"),
                sandbox=sandbox,
                service_name=thread_options.get("serviceName"),
                service_tier=thread_options.get("serviceTier"),
            )
            handle = await thread.turn(
                prompt,
                approval_mode=approval,
                cwd=cwd,
                effort=effort,
                model=turn_options.get("model"),
                output_schema=turn_options.get("outputSchema"),
                personality=turn_options.get("personality"),
                sandbox=_sandbox(turn_options.get("sandboxMode")),
                service_tier=turn_options.get("serviceTier"),
                source="chatmd",
                summary=summary,
                turn_service_tier=turn_options.get("turnServiceTier"),
            )
            self._active_handle = handle
            try:
                async for notification in handle.stream():
                    payload = notification.payload
                    if isinstance(payload, AgentMessageDeltaNotification):
                        if payload.delta:
                            yield TextDelta(payload.delta)
                        continue
                    if isinstance(payload, ReasoningSummaryTextDeltaNotification):
                        if payload.delta:
                            yield ThinkingDelta(payload.delta)
                        continue
                    if isinstance(payload, ThreadTokenUsageUpdatedNotification):
                        total = payload.token_usage.total
                        usage = Usage(
                            input_tokens=total.input_tokens,
                            output_tokens=total.output_tokens,
                            cache_read_tokens=total.cached_input_tokens,
                            cache_write_tokens=total.cache_write_input_tokens,
                        )
                        self.last_usage = usage
                        yield UsageDelta(usage)
                        continue
                    if isinstance(payload, ItemStartedNotification):
                        item = payload.item.root
                        if isinstance(item, McpToolCallThreadItem):
                            server_name = (
                                lease.codex_server_names.get(item.server, item.server)
                                if lease is not None
                                else item.server
                            )
                            name = f"{server_name}.{item.tool}"
                            tool_names[item.id] = (name, False)
                            arguments = item.arguments
                            yield ToolUseDelta(
                                id=item.id,
                                name=name,
                                input=arguments
                                if isinstance(arguments, dict)
                                else {"value": arguments},
                                server_tool=False,
                            )
                            continue
                        item_type = getattr(item, "type", "")
                        builtin_name = _TOOL_NAMES.get(item_type)
                        if builtin_name is not None:
                            tool_names[item.id] = (builtin_name, True)
                            yield ToolUseDelta(
                                id=item.id,
                                name=builtin_name,
                                input=_tool_input(item),
                                server_tool=True,
                            )
                        continue
                    if isinstance(payload, ItemCompletedNotification):
                        item = payload.item.root
                        identity = tool_names.get(getattr(item, "id", ""))
                        if identity is None:
                            continue
                        name, server_tool = identity
                        if isinstance(item, McpToolCallThreadItem):
                            result: object = (
                                item.result.model_dump(by_alias=True, exclude_none=True)
                                if item.result is not None
                                else {"error": item.error.message if item.error else "No result"}
                            )
                            is_error = item.error is not None
                        else:
                            result = _tool_result(item)
                            status = str(getattr(item, "status", ""))
                            is_error = "fail" in status.lower()
                        yield ToolResultDelta(
                            tool_use_id=item.id,
                            name=name,
                            content=_json_text(result),
                            is_error=is_error,
                            server_tool=server_tool,
                        )
            finally:
                self._active_handle = None
