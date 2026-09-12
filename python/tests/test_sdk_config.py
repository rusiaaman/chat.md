"""Configuration translation for subscription-backed agent SDKs."""

from __future__ import annotations

from pathlib import Path

import pytest

from chatmd.config.model import ResolvedConfig
from chatmd.providers.sdk_config import (
    allow_all_codex_mcp_tools,
    claude_agent_options,
    codex_mcp_servers,
    isolated_codex_environment,
    subscription_env,
)


def test_claude_profile_options_override_common_values_and_inject_shared_mcp(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "remove-this")
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "remove-this-too")
    monkeypatch.setenv("CLAUDE_CODE_USE_BEDROCK", "1")
    config = ResolvedConfig(
        provider="claude-code",
        api_key=None,
        model_name="common-model",
        max_thinking_tokens=100,
        reasoning_effort="medium",
        claude_code={
            "model": "profile-model",
            "effort": "xhigh",
            "maxThinkingTokens": 200,
            "pathToClaudeCodeExecutable": "/bin/claude",
            "env": {
                "CLAUDE_CODE_OAUTH_TOKEN": "oauth-token",
                "ANTHROPIC_API_KEY": "also-remove-this",
            },
        },
    )

    options = claude_agent_options(
        config,
        str(tmp_path),
        {"files": "http://127.0.0.1:1234/mcp/lease/files"},
        ["mcp__files__read"],
    )

    assert options.model == "profile-model"
    assert options.effort == "xhigh"
    assert options.max_thinking_tokens == 200
    assert options.cli_path == "/bin/claude"
    assert options.continue_conversation is False
    assert options.resume is None
    assert options.include_partial_messages is True
    assert options.permission_mode == "bypassPermissions"
    assert options.extra_args["dangerously-skip-permissions"] is None
    assert options.strict_mcp_config is True
    assert options.env["CLAUDE_CODE_OAUTH_TOKEN"] == "oauth-token"
    assert options.env["ANTHROPIC_API_KEY"] == ""
    assert options.env["ANTHROPIC_AUTH_TOKEN"] == ""
    assert options.env["CLAUDE_CODE_USE_BEDROCK"] == ""
    assert options.mcp_servers["files"] == {
        "type": "http",
        "url": "http://127.0.0.1:1234/mcp/lease/files",
    }
    assert options.allowed_tools == ["mcp__files__read"]


def test_codex_environment_and_mcp_mapping_exclude_usage_billing_keys(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "remove-this")
    monkeypatch.setenv("CODEX_API_KEY", "remove-this-too")

    environment = subscription_env(
        {
            "OPENAI_API_KEY": "configured-key",
            "CODEX_API_KEY": "configured-codex-key",
            "CUSTOM_SETTING": "kept",
        },
        "codex",
    )
    servers = codex_mcp_servers({"remote": "http://127.0.0.1:1234/mcp/lease/remote"})

    assert environment == {
        "CUSTOM_SETTING": "kept",
        "OPENAI_API_KEY": "",
        "CODEX_API_KEY": "",
    }
    assert servers == {
        "remote": {
            "url": "http://127.0.0.1:1234/mcp/lease/remote",
            "default_tools_approval_mode": "approve",
        }
    }


def test_all_codex_mcp_tools_override_profile_approval_modes() -> None:
    servers = allow_all_codex_mcp_tools(
        {
            "profile-server": {
                "command": "profile-mcp",
                "default_tools_approval_mode": "prompt",
            }
        }
    )

    assert servers == {
        "profile-server": {
            "command": "profile-mcp",
            "default_tools_approval_mode": "approve",
        }
    }


def test_codex_environment_reuses_auth_without_inheriting_config(tmp_path: Path) -> None:
    source_home = tmp_path / "source"
    source_home.mkdir()
    (source_home / "auth.json").write_text("credential", encoding="utf-8")
    (source_home / "config.toml").write_text("invalid = true\n", encoding="utf-8")

    with isolated_codex_environment({"CODEX_HOME": str(source_home), "KEEP": "yes"}) as environment:
        temporary_home = Path(environment["CODEX_HOME"])
        assert environment["KEEP"] == "yes"
        assert environment["CODEX_SQLITE_HOME"] == str(temporary_home)
        assert (temporary_home / "auth.json").read_text(encoding="utf-8") == "credential"
        assert not (temporary_home / "config.toml").exists()

    assert not temporary_home.exists()
