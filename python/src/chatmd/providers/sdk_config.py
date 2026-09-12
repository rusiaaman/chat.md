"""Configuration adapters shared by the subscription-backed agent SDKs."""

from __future__ import annotations

import os
import re
import shutil
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import fields
from pathlib import Path
from typing import Any, Literal

from claude_agent_sdk import ClaudeAgentOptions
from claude_agent_sdk.types import AgentDefinition

from ..config.model import ResolvedConfig

_CAMEL_BOUNDARY = re.compile(r"(?<!^)(?=[A-Z])")
_CLAUDE_RESERVED = {
    "continue_conversation",
    "resume",
    "session_id",
    "fork_session",
    "resume_session_at",
    "resume_drops_turn",
    "mcp_servers",
    "include_partial_messages",
    "cwd",
    "model",
    "max_thinking_tokens",
    "effort",
    "env",
    "can_use_tool",
    "hooks",
    "session_store",
    "permission_mode",
    "strict_mcp_config",
}
_CLAUDE_NON_SUBSCRIPTION_ENV = {
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_PROFILE",
    "ANTHROPIC_FEDERATION_RULE_ID",
    "ANTHROPIC_ORGANIZATION_ID",
    "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
    "CLAUDE_CODE_USE_ANTHROPIC_AWS",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_MANTLE",
    "CLAUDE_CODE_USE_VERTEX",
}
_CODEX_NON_SUBSCRIPTION_ENV = {
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "CODEX_API_KEY",
}
_CLAUDE_ALIASES = {
    "additionalDirectories": "add_dirs",
    "pathToClaudeCodeExecutable": "cli_path",
}


def _snake_case(name: str) -> str:
    return _CAMEL_BOUNDARY.sub("_", name).lower()


def subscription_env(
    configured: dict[str, Any], provider: Literal["claude-code", "codex"]
) -> dict[str, str]:
    """Return subprocess environment overrides with usage-billed keys disabled."""
    forbidden = (
        _CLAUDE_NON_SUBSCRIPTION_ENV if provider == "claude-code" else _CODEX_NON_SUBSCRIPTION_ENV
    )
    env = {key: str(value) for key, value in configured.items() if key not in forbidden}
    for key in forbidden:
        if key in os.environ:
            env[key] = ""
    return env


def _share_auth_file(source: Path, destination: Path) -> None:
    try:
        os.link(source, destination)
        return
    except OSError:
        try:
            destination.symlink_to(source)
            return
        except OSError:
            shutil.copyfile(source, destination)
            destination.chmod(0o600)


@contextmanager
def isolated_codex_environment(
    environment: dict[str, str],
) -> Iterator[dict[str, str]]:
    """Reuse subscription auth while excluding the user's Codex config layers."""
    source_home = Path(
        environment.get("CODEX_HOME") or os.environ.get("CODEX_HOME") or Path.home() / ".codex"
    )
    with tempfile.TemporaryDirectory(prefix="chatmd-codex-") as temporary:
        temporary_home = Path(temporary)
        temporary_home.chmod(0o700)
        source_auth = source_home / "auth.json"
        if source_auth.is_file():
            _share_auth_file(source_auth, temporary_home / "auth.json")
        yield {
            **environment,
            "CODEX_HOME": temporary,
            "CODEX_SQLITE_HOME": temporary,
        }


def claude_mcp_servers(
    urls: dict[str, str],
) -> dict[str, dict[str, Any]]:
    return {name: {"type": "http", "url": url} for name, url in urls.items()}


def codex_mcp_servers(
    urls: dict[str, str],
) -> dict[str, dict[str, Any]]:
    return {
        name: {"url": url, "default_tools_approval_mode": "approve"} for name, url in urls.items()
    }


def allow_all_codex_mcp_tools(
    servers: dict[str, Any],
) -> dict[str, dict[str, Any]]:
    """Approve every tool exposed by each serializable Codex MCP server."""
    return {
        name: {**server, "default_tools_approval_mode": "approve"}
        for name, server in servers.items()
        if isinstance(server, dict)
    }


def claude_agent_options(
    config: ResolvedConfig,
    chat_path: str,
    mcp_urls: dict[str, str],
    allowed_mcp_tools: list[str],
) -> ClaudeAgentOptions:
    """Translate serializable profile options and enforce a fresh ChatMD turn."""
    valid = {item.name for item in fields(ClaudeAgentOptions)}
    values = {
        _CLAUDE_ALIASES.get(key, _snake_case(key)): value
        for key, value in config.claude_code.items()
        if _CLAUDE_ALIASES.get(key, _snake_case(key)) in valid
        and _CLAUDE_ALIASES.get(key, _snake_case(key)) not in _CLAUDE_RESERVED
    }
    agents = values.get("agents")
    if isinstance(agents, dict):
        values["agents"] = {
            name: AgentDefinition(**definition)
            for name, definition in agents.items()
            if isinstance(definition, dict)
        }

    configured_env = config.claude_code.get("env")
    configured_model = config.claude_code.get("model")
    configured_tokens = config.claude_code.get("maxThinkingTokens")
    configured_effort = config.claude_code.get("effort")
    configured_permission_mode = config.claude_code.get("permissionMode")
    permission_mode = (
        configured_permission_mode
        if isinstance(configured_permission_mode, str)
        else "bypassPermissions"
    )
    configured_allowed_tools = values.get("allowed_tools")
    allowed_tools = (
        [tool for tool in configured_allowed_tools if isinstance(tool, str)]
        if isinstance(configured_allowed_tools, list)
        else []
    )
    allowed_tools.extend(tool for tool in allowed_mcp_tools if tool not in allowed_tools)
    values.update(
        {
            "continue_conversation": False,
            "resume": None,
            "session_id": None,
            "fork_session": False,
            "include_partial_messages": True,
            "cwd": config.claude_code.get("cwd") or chat_path,
            "model": configured_model if isinstance(configured_model, str) else config.model_name,
            "max_thinking_tokens": configured_tokens
            if isinstance(configured_tokens, int)
            else config.max_thinking_tokens,
            "effort": configured_effort
            if configured_effort in ("low", "medium", "high", "xhigh", "max")
            else config.reasoning_effort
            if config.reasoning_effort in ("low", "medium", "high", "max")
            else None,
            "permission_mode": permission_mode,
            "strict_mcp_config": True,
            "env": subscription_env(
                configured_env if isinstance(configured_env, dict) else {},
                "claude-code",
            ),
            "mcp_servers": claude_mcp_servers(mcp_urls),
            "allowed_tools": allowed_tools,
        }
    )
    if permission_mode == "bypassPermissions":
        extra_args = values.get("extra_args")
        values["extra_args"] = {
            **(extra_args if isinstance(extra_args, dict) else {}),
            "dangerously-skip-permissions": None,
        }
    if "thinking" in config.claude_code:
        values["thinking"] = config.claude_code["thinking"]
    elif config.reasoning_effort == "none":
        values["thinking"] = {"type": "disabled"}
    return ClaudeAgentOptions(**values)


def codex_profile_parts(
    config: ResolvedConfig,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    options = config.codex.get("options")
    thread = config.codex.get("thread")
    turn = config.codex.get("turn")
    return (
        dict(options) if isinstance(options, dict) else {},
        dict(thread) if isinstance(thread, dict) else {},
        dict(turn) if isinstance(turn, dict) else {},
    )
