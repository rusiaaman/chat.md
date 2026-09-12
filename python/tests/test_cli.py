"""Tests for the command line.

Everything here runs against a temporary XDG root, so no test can read or write
the real configuration, state directory or event log.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
from typer.testing import CliRunner

from chatmd.cli.main import app
from chatmd.cli.setup import add_subscription_defaults, parse_selection
from chatmd.config.model import ApiConfig, ChatmdConfig
from chatmd.daemon.state import (
    CommandName,
    DaemonInfo,
    DaemonStatus,
    pending_commands,
    read_registry,
    write_daemon_info,
    write_status,
)
from chatmd.stats.events import Event, EventKind, EventLog
from chatmd.types import McpServerStatus

runner = CliRunner()

CONFIG = {
    "version": 1,
    "apiConfigs": {
        "sonnet": {
            "type": "anthropic",
            "apiKey": "sk-do-not-print-me",
            "model_name": "claude-sonnet-5",
        }
    },
    "selectedConfig": "sonnet",
    "mcpServers": {},
    "pricing": {"claude-sonnet-5": {"input": 3.0, "output": 15.0}},
}


def _isolate(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "config"))
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "state"))
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "cache"))


@pytest.fixture
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """An isolated XDG root with a usable config already written."""
    _isolate(tmp_path, monkeypatch)
    config_dir = tmp_path / "config" / "chat.md"
    config_dir.mkdir(parents=True)
    (config_dir / "config.json").write_text(json.dumps(CONFIG), encoding="utf-8")
    return tmp_path


@pytest.fixture
def bare_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """An isolated XDG root with no config at all."""
    _isolate(tmp_path, monkeypatch)
    return tmp_path


# --------------------------------------------------------------------------- #
# Basics
# --------------------------------------------------------------------------- #


def test_version_prints_the_package_version() -> None:
    from chatmd import __version__

    result = runner.invoke(app, ["version"])
    assert result.exit_code == 0
    assert __version__ in result.output


def test_commands_needing_config_say_how_to_get_one(bare_home: Path) -> None:
    result = runner.invoke(app, ["stats"])
    assert result.exit_code == 1
    assert "chatmd setup" in result.output


# --------------------------------------------------------------------------- #
# config
# --------------------------------------------------------------------------- #


def test_config_show_redacts_the_api_key(home: Path) -> None:
    """This output ends up in bug reports; the key must not."""
    result = runner.invoke(app, ["config", "show"])
    assert result.exit_code == 0
    assert "sk-do-not-print-me" not in result.output
    assert "***" in result.output


def test_config_show_can_reveal_the_key_when_asked(home: Path) -> None:
    result = runner.invoke(app, ["config", "show", "--reveal"])
    assert "sk-do-not-print-me" in result.output


def test_config_select_rejects_an_unknown_name(home: Path) -> None:
    result = runner.invoke(app, ["config", "select", "nope"])
    assert result.exit_code == 1
    assert "sonnet" in result.output  # tells you what is available


def test_config_select_switches_the_default(home: Path) -> None:
    from chatmd.config.loader import load_config

    result = runner.invoke(app, ["config", "select", "sonnet"])
    assert result.exit_code == 0
    assert load_config().selected_config == "sonnet"


# --------------------------------------------------------------------------- #
# status
# --------------------------------------------------------------------------- #


def test_status_reports_no_listener(home: Path) -> None:
    result = runner.invoke(app, ["status"])
    assert result.exit_code == 0
    assert "No listener running" in result.output


def test_status_json_is_machine_readable(home: Path) -> None:
    result = runner.invoke(app, ["status", "--json"])
    payload = json.loads(result.output)
    assert payload["running"] is False
    assert payload["status"] is None


def test_a_snapshot_from_a_dead_listener_is_not_reported_as_running(home: Path) -> None:
    """A killed daemon leaves its files behind; that must not read as alive."""
    dead = DaemonInfo(pid=999_999, host="h", started_at=1.0, version="0")
    write_daemon_info(dead)
    write_status(DaemonStatus(daemon=dead))

    result = runner.invoke(app, ["status"])
    assert "exited without cleaning up" in result.output

    payload = json.loads(runner.invoke(app, ["status", "--json"]).output)
    assert payload["running"] is False


def test_status_renders_a_live_listener(home: Path) -> None:
    info = DaemonInfo(pid=os.getpid(), host="h", started_at=1.0, version="0.1.0", roots=["/tmp"])
    write_daemon_info(info)
    write_status(
        DaemonStatus(
            daemon=info,
            watching=["/tmp"],
            mcp=[McpServerStatus(server_id="wcgw", state="connected", tool_count=7)],
        )
    )
    result = runner.invoke(app, ["status"])
    assert result.exit_code == 0
    assert "wcgw" in result.output
    assert "connected" in result.output


# --------------------------------------------------------------------------- #
# watch / unwatch / stop
# --------------------------------------------------------------------------- #


def test_watch_registers_a_path_without_starting_a_listener(home: Path) -> None:
    target = home / "chats"
    target.mkdir()
    result = runner.invoke(app, ["watch", "--no-start", str(target)])
    assert result.exit_code == 0
    assert str(target) in read_registry()


def test_unwatch_removes_it_again(home: Path) -> None:
    target = home / "chats"
    target.mkdir()
    runner.invoke(app, ["watch", "--no-start", str(target)])
    runner.invoke(app, ["unwatch", str(target)])
    assert read_registry() == []


def test_watch_is_idempotent(home: Path) -> None:
    target = home / "chats"
    target.mkdir()
    runner.invoke(app, ["watch", "--no-start", str(target)])
    runner.invoke(app, ["watch", "--no-start", str(target)])
    assert read_registry().count(str(target)) == 1


def test_stop_says_so_when_nothing_is_running(home: Path) -> None:
    result = runner.invoke(app, ["stop"])
    assert result.exit_code == 0
    assert "No listener is running" in result.output


def test_stop_drops_a_shutdown_command_for_a_live_listener(home: Path) -> None:
    write_daemon_info(DaemonInfo(pid=os.getpid(), host="h", started_at=1.0, version="0"))
    # This process never answers the command, so stop gives up after its wait.
    result = runner.invoke(app, ["stop"])
    assert [command.name for _, command in pending_commands()] == [CommandName.SHUTDOWN]
    assert "wedged" in result.output


# --------------------------------------------------------------------------- #
# send / parse
# --------------------------------------------------------------------------- #


def test_send_creates_a_file_ending_in_a_trigger_block(home: Path) -> None:
    chat = home / "new.chat.md"
    result = runner.invoke(app, ["send", str(chat), "What is 2+2?"])
    assert result.exit_code == 0
    text = chat.read_text()
    assert text.startswith("# %% user\nWhat is 2+2?")
    # The empty assistant block is what asks for a reply.
    assert text.rstrip().endswith("# %% assistant")


def test_send_appends_to_an_existing_chat_with_a_blank_line_between(home: Path) -> None:
    chat = home / "new.chat.md"
    runner.invoke(app, ["send", str(chat), "first"])
    runner.invoke(app, ["send", str(chat), "second"])
    text = chat.read_text()
    assert "first" in text and "second" in text
    assert "\n\n# %% user\nsecond" in text


def test_parse_summarises_the_history(home: Path) -> None:
    chat = home / "a.chat.md"
    chat.write_text("# %% user\nhi\n\n# %% assistant\nhello\n", encoding="utf-8")
    result = runner.invoke(app, ["parse", str(chat)])
    assert result.exit_code == 0
    assert "2 message(s)" in result.output


def test_parse_json_reports_roles_and_content(home: Path) -> None:
    chat = home / "a.chat.md"
    chat.write_text("# %% user\nhi\n\n# %% assistant\nhello\n", encoding="utf-8")
    payload = json.loads(runner.invoke(app, ["parse", str(chat), "--json"]).output)
    assert [message["role"] for message in payload["messages"]] == ["user", "assistant"]


def test_parse_reports_a_malformed_document_rather_than_crashing(home: Path) -> None:
    chat = home / "bad.chat.md"
    chat.write_text("this is not a key=value line\n\n# %% user\nhi\n", encoding="utf-8")
    result = runner.invoke(app, ["parse", str(chat)])
    assert result.exit_code == 1


def test_parse_rejects_a_missing_file(home: Path) -> None:
    result = runner.invoke(app, ["parse", str(home / "nope.chat.md")])
    assert result.exit_code == 1


# --------------------------------------------------------------------------- #
# stats
# --------------------------------------------------------------------------- #


def seed_events(path: str) -> None:
    log = EventLog()
    for output in (1200, 800):
        log.append(
            Event(
                kind=EventKind.TURN_END,
                path=path,
                model="claude-sonnet-5",
                provider="anthropic",
                config="sonnet",
                outcome="completed",
                input_tokens=100_000,
                output_tokens=output,
                duration_ms=2400.0,
            )
        )
    log.append(Event(kind=EventKind.TOOL_CALL, path=path, tool="wcgw.BashCommand"))


def test_stats_renders_totals_and_cost(home: Path) -> None:
    seed_events(str(home / "a.chat.md"))
    result = runner.invoke(app, ["stats", "--since", "all"])
    assert result.exit_code == 0
    assert "claude-sonnet-5" in result.output
    # 200k in at $3/M plus 2k out at $15/M.
    assert "$0.63" in result.output
    assert "wcgw.BashCommand" in result.output


def test_stats_json_carries_the_groups(home: Path) -> None:
    seed_events(str(home / "a.chat.md"))
    payload = json.loads(runner.invoke(app, ["stats", "--since", "all", "--json"]).output)
    assert payload["totals"]["turns"] == 2
    assert payload["groups"][0]["key"] == "claude-sonnet-5"


def test_stats_rejects_a_bad_time_span(home: Path) -> None:
    result = runner.invoke(app, ["stats", "--since", "yesterday"])
    assert result.exit_code == 1


def test_stats_rejects_an_unknown_grouping(home: Path) -> None:
    result = runner.invoke(app, ["stats", "--by", "colour"])
    assert result.exit_code == 1


def test_stats_with_no_history_still_renders(home: Path) -> None:
    result = runner.invoke(app, ["stats"])
    assert result.exit_code == 0
    assert "nothing recorded yet" in result.output


# --------------------------------------------------------------------------- #
# setup helpers
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("1", [0]), ("2,1", [1, 0]), ("all", [0, 1, 2]), ("none", []), ("", []), ("1,1", [0])],
)
def test_selection_parsing(raw: str, expected: list[int]) -> None:
    assert parse_selection(raw, 3) == expected


@pytest.mark.parametrize("raw", ["4", "0", "x", "1,x"])
def test_a_bad_selection_is_rejected_rather_than_guessed(raw: str) -> None:
    """Importing the wrong editor's keys silently would be worse than an error."""
    with pytest.raises(ValueError):
        parse_selection(raw, 3)


def test_subscription_defaults_prefer_claude_and_preserve_a_selection() -> None:
    defaults = add_subscription_defaults(ChatmdConfig(), True, True)

    assert defaults.selected_config == "claude-code-opus"
    assert defaults.api_configs["claude-code-opus"].model_name == "claude-opus-5"
    assert defaults.api_configs["claude-code-opus"].reasoning_effort == "high"
    assert defaults.api_configs["claude-code-opus"].claude_code == {
        "permissionMode": "bypassPermissions"
    }
    assert defaults.api_configs["codex-sol"].model_name == "gpt-5.6-sol"
    assert defaults.api_configs["codex-sol"].reasoning_effort == "high"
    assert defaults.api_configs["codex-sol"].codex == {
        "thread": {
            "sandboxMode": "danger-full-access",
            "approvalPolicy": "never",
        }
    }

    existing = ChatmdConfig(
        api_configs={"api": ApiConfig(type="openai", api_key="placeholder")},
        selected_config="api",
    )
    preserved = add_subscription_defaults(existing, True, False)
    assert preserved.selected_config == "api"
    assert "claude-code-opus" not in existing.api_configs
