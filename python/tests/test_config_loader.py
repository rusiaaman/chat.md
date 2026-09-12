"""Tests for chatmd.config.loader: reading, writing and merging the global config."""

from __future__ import annotations

import json
import stat
from pathlib import Path

import pytest

from chatmd.config.discovery import EditorCandidate
from chatmd.config.loader import (
    config_exists,
    config_from_editor_candidates,
    load_config,
    save_config,
)
from chatmd.config.model import ApiConfig, ChatmdConfig, McpServerConfig
from chatmd.errors import ConfigError
from chatmd.paths import config_path


@pytest.fixture(autouse=True)
def _redirect_config_home(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Point the default config location at tmp_path for every test in this file."""
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))


def _sample_config() -> ChatmdConfig:
    return ChatmdConfig(
        api_configs={
            "sonnet": ApiConfig(type="anthropic", api_key="sk-ant-1", model_name="claude-sonnet-5"),
            "gpt": ApiConfig(type="openai", api_key="sk-oai-1", base_url="https://api.openai.com/v1"),
        },
        selected_config="sonnet",
        mcp_servers={"wcgw": McpServerConfig(command="uvx", args=["wcgw"])},
        max_tokens=5000,
        max_thinking_tokens=12000,
        reasoning_effort="high",
    )


# --------------------------------------------------------------------------- #
# config_exists
# --------------------------------------------------------------------------- #


def test_config_exists_false_when_absent() -> None:
    assert config_exists() is False


def test_config_exists_true_after_save() -> None:
    save_config(_sample_config())
    assert config_exists() is True


def test_config_exists_with_explicit_path(tmp_path: Path) -> None:
    explicit = tmp_path / "elsewhere" / "config.json"
    assert config_exists(explicit) is False
    save_config(_sample_config(), explicit)
    assert config_exists(explicit) is True


# --------------------------------------------------------------------------- #
# save_config / load_config round trip
# --------------------------------------------------------------------------- #


def test_round_trip_default_path() -> None:
    original = _sample_config()

    written_path = save_config(original)

    assert written_path == config_path()
    loaded = load_config()
    assert loaded == original


def test_named_subscription_profiles_round_trip_without_api_keys() -> None:
    original = ChatmdConfig.from_dict(
        {
            "selectedConfig": "codex-terra",
            "apiConfigs": {
                "claude-work": {
                    "type": "claude-code",
                    "model_name": "claude-sonnet-5",
                    "claudeCode": {"permissionMode": "plan"},
                },
                "codex-terra": {
                    "type": "codex",
                    "model_name": "gpt-5.6-terra",
                    "codex": {"thread": {"sandboxMode": "workspace-write"}},
                },
            },
        }
    )

    save_config(original)
    loaded = load_config()
    resolved = loaded.resolve(config_name="codex-terra")

    assert set(loaded.api_configs) == {"claude-work", "codex-terra"}
    assert resolved.provider == "codex"
    assert resolved.api_key is None
    assert resolved.model_name == "gpt-5.6-terra"
    assert resolved.codex == {"thread": {"sandboxMode": "workspace-write"}}


def test_round_trip_explicit_path(tmp_path: Path) -> None:
    original = _sample_config()
    target = tmp_path / "nested" / "dir" / "config.json"

    written_path = save_config(original, target)

    assert written_path == target
    assert target.is_file()
    loaded = load_config(target)
    assert loaded == original


def test_save_config_creates_parent_directory(tmp_path: Path) -> None:
    target = tmp_path / "does" / "not" / "exist" / "config.json"
    assert not target.parent.exists()

    save_config(ChatmdConfig(), target)

    assert target.parent.is_dir()
    assert target.is_file()


def test_save_config_file_mode_is_0600() -> None:
    path = save_config(_sample_config())

    mode = stat.S_IMODE(path.stat().st_mode)
    assert mode == 0o600


def test_save_config_writes_indented_json_with_trailing_newline() -> None:
    path = save_config(_sample_config())

    text = path.read_text(encoding="utf-8")
    assert text.endswith("\n")
    assert json.loads(text) == _sample_config().to_dict()
    # indent=2 pretty-printing, not a single-line dump
    assert "\n  " in text


def test_save_config_no_leftover_temp_files() -> None:
    path = save_config(_sample_config())

    siblings = list(path.parent.iterdir())
    assert siblings == [path]


def test_save_config_overwrites_existing_file() -> None:
    save_config(_sample_config())
    replacement = ChatmdConfig(selected_config="gpt")

    save_config(replacement)

    loaded = load_config()
    assert loaded.selected_config == "gpt"
    assert loaded.api_configs == {}


# --------------------------------------------------------------------------- #
# load_config error handling
# --------------------------------------------------------------------------- #


def test_load_config_missing_raises_config_error() -> None:
    with pytest.raises(ConfigError):
        load_config()


def test_load_config_missing_explicit_path_raises_config_error(tmp_path: Path) -> None:
    with pytest.raises(ConfigError):
        load_config(tmp_path / "nope" / "config.json")


def test_load_config_malformed_json_raises_config_error() -> None:
    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{ this is not json ][", encoding="utf-8")

    with pytest.raises(ConfigError):
        load_config()


def test_load_config_non_object_json_raises_config_error() -> None:
    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("[1, 2, 3]", encoding="utf-8")

    with pytest.raises(ConfigError):
        load_config()


def test_load_config_tolerates_jsonc_comments_and_trailing_commas() -> None:
    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "{\n"
        '  // hand-edited config\n'
        '  "version": 1,\n'
        '  "selectedConfig": "sonnet", // pick sonnet by default\n'
        '  "apiConfigs": {\n'
        '    "sonnet": { "type": "anthropic", "apiKey": "sk-1", },\n'
        "  },\n"
        "}\n",
        encoding="utf-8",
    )

    loaded = load_config()

    assert loaded.selected_config == "sonnet"
    assert loaded.api_configs["sonnet"].api_key == "sk-1"


# --------------------------------------------------------------------------- #
# config_from_editor_candidates
# --------------------------------------------------------------------------- #


def test_config_from_editor_candidates_empty_yields_default() -> None:
    assert config_from_editor_candidates([]) == ChatmdConfig()


def test_config_from_editor_candidates_single() -> None:
    candidate = EditorCandidate(
        editor="VS Code",
        settings_path=Path("/fake/settings.json"),
        settings={
            "selectedConfig": "sonnet",
            "apiConfigs": {"sonnet": {"type": "anthropic", "apiKey": "sk-1"}},
        },
        api_config_count=1,
        mcp_server_count=0,
    )

    config = config_from_editor_candidates([candidate])

    assert config.selected_config == "sonnet"
    assert config.api_configs["sonnet"].api_key == "sk-1"


def test_config_from_editor_candidates_later_wins_on_scalar_key() -> None:
    first = EditorCandidate(
        editor="VS Code",
        settings_path=Path("/fake/a.json"),
        settings={"selectedConfig": "from-first", "maxTokens": 1000},
        api_config_count=0,
        mcp_server_count=0,
    )
    second = EditorCandidate(
        editor="Cursor",
        settings_path=Path("/fake/b.json"),
        settings={"selectedConfig": "from-second"},
        api_config_count=0,
        mcp_server_count=0,
    )

    config = config_from_editor_candidates([first, second])

    assert config.selected_config == "from-second"
    assert config.max_tokens == 1000  # untouched key from the first candidate survives


def test_config_from_editor_candidates_merges_api_configs_per_entry() -> None:
    first = EditorCandidate(
        editor="VS Code",
        settings_path=Path("/fake/a.json"),
        settings={
            "apiConfigs": {
                "sonnet": {"type": "anthropic", "apiKey": "sk-old"},
                "haiku": {"type": "anthropic", "apiKey": "sk-haiku"},
            }
        },
        api_config_count=2,
        mcp_server_count=0,
    )
    second = EditorCandidate(
        editor="Cursor",
        settings_path=Path("/fake/b.json"),
        settings={
            "apiConfigs": {
                "sonnet": {"type": "anthropic", "apiKey": "sk-new"},  # overrides "sonnet"
                "gpt": {"type": "openai", "apiKey": "sk-gpt"},  # adds "gpt"
            }
        },
        api_config_count=2,
        mcp_server_count=0,
    )

    config = config_from_editor_candidates([first, second])

    assert set(config.api_configs) == {"sonnet", "haiku", "gpt"}
    assert config.api_configs["sonnet"].api_key == "sk-new"  # second candidate wins per-entry
    assert config.api_configs["haiku"].api_key == "sk-haiku"  # untouched entry survives
    assert config.api_configs["gpt"].api_key == "sk-gpt"


def test_config_from_editor_candidates_merges_mcp_servers_per_entry() -> None:
    first = EditorCandidate(
        editor="VS Code",
        settings_path=Path("/fake/a.json"),
        settings={"mcpServers": {"wcgw": {"command": "uvx", "args": ["old"]}}},
        api_config_count=0,
        mcp_server_count=1,
    )
    second = EditorCandidate(
        editor="Cursor",
        settings_path=Path("/fake/b.json"),
        settings={
            "mcpServers": {
                "wcgw": {"command": "uvx", "args": ["new"]},
                "extra": {"url": "https://example.com/mcp"},
            }
        },
        api_config_count=0,
        mcp_server_count=2,
    )

    config = config_from_editor_candidates([first, second])

    assert set(config.mcp_servers) == {"wcgw", "extra"}
    assert config.mcp_servers["wcgw"].args == ["new"]
    assert config.mcp_servers["extra"].url == "https://example.com/mcp"
