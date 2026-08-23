"""Tests for chatmd.config.discovery: locating and reading editor settings files."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from chatmd.config.discovery import (
    EditorCandidate,
    discover_editor_settings,
    editor_settings_locations,
    extract_chatmd_settings,
)

EDITOR_DIR_COUNT = 7  # Code, Code - Insiders, VSCodium, Cursor, Windsurf, Antigravity, Trae


def _patch_home(monkeypatch: pytest.MonkeyPatch, home: Path) -> None:
    monkeypatch.setattr(Path, "home", lambda: home)


# --------------------------------------------------------------------------- #
# editor_settings_locations
# --------------------------------------------------------------------------- #


def test_locations_macos(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(sys, "platform", "darwin")
    _patch_home(monkeypatch, tmp_path)

    locations = editor_settings_locations()

    assert len(locations) == EDITOR_DIR_COUNT
    names = [editor for editor, _ in locations]
    assert "VS Code" in names
    assert "VS Code Insiders" in names
    assert "Cursor" in names
    code_path = dict(locations)["VS Code"]
    expected = tmp_path / "Library" / "Application Support" / "Code" / "User" / "settings.json"
    assert code_path == expected


def test_locations_linux_default_xdg(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.delenv("XDG_CONFIG_HOME", raising=False)
    _patch_home(monkeypatch, tmp_path)

    locations = editor_settings_locations()

    assert len(locations) == EDITOR_DIR_COUNT
    cursor_path = dict(locations)["Cursor"]
    assert cursor_path == tmp_path / ".config" / "Cursor" / "User" / "settings.json"


def test_locations_linux_honours_xdg_config_home(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(sys, "platform", "linux")
    custom = tmp_path / "custom-xdg"
    monkeypatch.setenv("XDG_CONFIG_HOME", str(custom))
    _patch_home(monkeypatch, tmp_path)

    locations = editor_settings_locations()

    vscodium_path = dict(locations)["VSCodium"]
    assert vscodium_path == custom / "VSCodium" / "User" / "settings.json"


def test_locations_windows_uses_appdata(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(sys, "platform", "win32")
    appdata = tmp_path / "AppData" / "Roaming"
    monkeypatch.setenv("APPDATA", str(appdata))
    _patch_home(monkeypatch, tmp_path)

    locations = editor_settings_locations()

    assert len(locations) == EDITOR_DIR_COUNT
    trae_path = dict(locations)["Trae"]
    assert trae_path == appdata / "Trae" / "User" / "settings.json"


def test_locations_windows_falls_back_without_appdata(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.delenv("APPDATA", raising=False)
    _patch_home(monkeypatch, tmp_path)

    locations = editor_settings_locations()

    code_path = dict(locations)["VS Code"]
    assert code_path == tmp_path / "AppData" / "Roaming" / "Code" / "User" / "settings.json"


# --------------------------------------------------------------------------- #
# extract_chatmd_settings
# --------------------------------------------------------------------------- #


def test_extract_flat_dotted_keys() -> None:
    raw = {
        "editor.fontSize": 12,
        "chatmd.selectedConfig": "sonnet",
        "chatmd.apiConfigs": {"sonnet": {"type": "anthropic", "apiKey": "x"}},
    }
    assert extract_chatmd_settings(raw) == {
        "selectedConfig": "sonnet",
        "apiConfigs": {"sonnet": {"type": "anthropic", "apiKey": "x"}},
    }


def test_extract_nested_object() -> None:
    raw = {
        "editor.fontSize": 12,
        "chatmd": {
            "selectedConfig": "sonnet",
            "mcpServers": {"wcgw": {"command": "uvx", "args": []}},
        },
    }
    assert extract_chatmd_settings(raw) == {
        "selectedConfig": "sonnet",
        "mcpServers": {"wcgw": {"command": "uvx", "args": []}},
    }


def test_extract_flat_wins_over_nested_on_conflict() -> None:
    raw = {
        "chatmd": {"selectedConfig": "from-nested", "maxTokens": 1},
        "chatmd.selectedConfig": "from-flat",
    }
    result = extract_chatmd_settings(raw)
    assert result["selectedConfig"] == "from-flat"
    assert result["maxTokens"] == 1  # non-conflicting nested key still comes through


def test_extract_ignores_unknown_keys() -> None:
    raw = {"editor.fontSize": 12, "workbench.colorTheme": "dark", "chatmdish.notReal": 1}
    assert extract_chatmd_settings(raw) == {}


def test_extract_empty_when_no_chatmd_keys() -> None:
    assert extract_chatmd_settings({"foo": "bar"}) == {}


# --------------------------------------------------------------------------- #
# discover_editor_settings
# --------------------------------------------------------------------------- #


def _write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def test_discover_mixed_candidates(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.delenv("XDG_CONFIG_HOME", raising=False)
    _patch_home(monkeypatch, tmp_path)

    config_root = tmp_path / ".config"

    # Flat dotted keys, as VS Code itself writes.
    _write(
        config_root / "Code" / "User" / "settings.json",
        json.dumps(
            {
                "editor.fontSize": 12,
                "chatmd.selectedConfig": "sonnet",
                "chatmd.apiConfigs": {
                    "sonnet": {"type": "anthropic", "apiKey": "x"},
                    "gpt": {"type": "openai", "apiKey": "y"},
                },
                "chatmd.mcpServers": {"wcgw": {"command": "uvx", "args": []}},
            }
        ),
    )

    # Nested, hand-written object.
    _write(
        config_root / "Cursor" / "User" / "settings.json",
        json.dumps(
            {
                "chatmd": {
                    "selectedConfig": "sonnet",
                    "apiConfigs": {"sonnet": {"type": "anthropic", "apiKey": "z"}},
                }
            }
        ),
    )

    # Malformed JSON — must be skipped, not raised on.
    _write(config_root / "VSCodium" / "User" / "settings.json", "{ not valid json ][")

    # Valid JSON but no chatmd keys at all — must be skipped.
    _write(
        config_root / "Windsurf" / "User" / "settings.json",
        json.dumps({"editor.fontSize": 14}),
    )

    # No file at all for the remaining editors (Code - Insiders, Antigravity, Trae).

    candidates = discover_editor_settings()

    assert [c.editor for c in candidates] == ["Cursor", "VS Code"]  # sorted by editor name

    by_editor = {c.editor: c for c in candidates}

    code = by_editor["VS Code"]
    assert isinstance(code, EditorCandidate)
    assert code.api_config_count == 2
    assert code.mcp_server_count == 1
    assert code.settings["selectedConfig"] == "sonnet"
    assert code.settings_path == config_root / "Code" / "User" / "settings.json"

    cursor = by_editor["Cursor"]
    assert cursor.api_config_count == 1
    assert cursor.mcp_server_count == 0


def test_discover_returns_empty_when_nothing_present(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.delenv("XDG_CONFIG_HOME", raising=False)
    _patch_home(monkeypatch, tmp_path)

    assert discover_editor_settings() == []


def test_discover_skips_unreadable_file(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.delenv("XDG_CONFIG_HOME", raising=False)
    _patch_home(monkeypatch, tmp_path)

    config_root = tmp_path / ".config"
    # A directory where a file is expected is "unreadable" as text in a
    # deterministic, cross-platform way (no chmod games needed).
    settings_path = config_root / "Code" / "User" / "settings.json"
    settings_path.mkdir(parents=True)

    assert discover_editor_settings() == []


def test_discover_uses_jsonc_tolerant_parsing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.delenv("XDG_CONFIG_HOME", raising=False)
    _patch_home(monkeypatch, tmp_path)

    config_root = tmp_path / ".config"
    _write(
        config_root / "Code" / "User" / "settings.json",
        '{\n  // hand-edited\n  "chatmd.selectedConfig": "sonnet", // trailing comma below\n'
        '  "chatmd.maxTokens": 4000,\n}\n',
    )

    candidates = discover_editor_settings()

    assert len(candidates) == 1
    assert candidates[0].settings["selectedConfig"] == "sonnet"
    assert candidates[0].settings["maxTokens"] == 4000
