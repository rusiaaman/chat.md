"""Find ``chatmd.*`` settings sitting in a user's editor config, for import.

Only user-level settings are probed. Project-level ``.vscode/settings.json`` is
deliberately out of scope: the chat.md listener drives one file at a time and
has no notion of "current workspace", so a project-scoped setting would not
mean anything to it — there would be no principled way to pick which project's
settings apply to a file opened outside any of them.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..fileio import read_text
from .jsonc import loads_jsonc

# Directory name the editor itself uses under "Application Support" / ".config"
# / "%APPDATA%", mapped to the display name shown to the user when choosing a
# candidate to import from.
_EDITOR_DIRS: tuple[tuple[str, str], ...] = (
    ("Code", "VS Code"),
    ("Code - Insiders", "VS Code Insiders"),
    ("VSCodium", "VSCodium"),
    ("Cursor", "Cursor"),
    ("Windsurf", "Windsurf"),
    ("Antigravity", "Antigravity"),
    ("Trae", "Trae"),
)

_CHATMD_PREFIX = "chatmd."


@dataclass(frozen=True)
class EditorCandidate:
    """One editor's user settings, filtered down to its ``chatmd.*`` keys."""

    editor: str
    settings_path: Path
    settings: dict[str, Any]
    api_config_count: int
    mcp_server_count: int


def _user_settings_root() -> Path:
    """Platform-specific root that holds every editor's ``<dir>/User/`` folder.

    ``sys.platform`` and ``Path.home()``/``os.environ`` are read on every call
    (never cached at import time) so tests can monkeypatch them per case.
    """
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support"
    if sys.platform.startswith("win"):
        appdata = os.environ.get("APPDATA")
        return Path(appdata) if appdata else Path.home() / "AppData" / "Roaming"
    # Linux, BSD, etc. — VS Code and its forks follow the XDG config convention.
    xdg_config = os.environ.get("XDG_CONFIG_HOME")
    return Path(xdg_config) if xdg_config else Path.home() / ".config"


def editor_settings_locations() -> list[tuple[str, Path]]:
    """``(display name, settings.json path)`` for every known editor on this platform."""
    root = _user_settings_root()
    return [
        (display, root / dir_name / "User" / "settings.json") for dir_name, display in _EDITOR_DIRS
    ]


def extract_chatmd_settings(raw: dict[str, Any]) -> dict[str, Any]:
    """Pull ``chatmd.*`` keys out of a settings object, un-prefixed.

    VS Code itself always writes flat dotted keys (``"chatmd.apiConfigs"``),
    but a nested ``{"chatmd": {...}}`` object is equally valid JSON that a user
    could have typed by hand, so both are read; the flat form wins on
    conflict, since that is the shape the editor's own settings UI produces.
    Keys outside the ``chatmd`` namespace are ignored.
    """
    merged: dict[str, Any] = {}

    nested = raw.get("chatmd")
    if isinstance(nested, dict):
        merged.update(nested)

    for key, value in raw.items():
        if isinstance(key, str) and key.startswith(_CHATMD_PREFIX):
            merged[key[len(_CHATMD_PREFIX) :]] = value

    return merged


def discover_editor_settings() -> list[EditorCandidate]:
    """Read every editor's user settings file, keeping only those with chatmd keys.

    A missing, unreadable or malformed file is skipped rather than raised on —
    one editor's broken ``settings.json`` must not prevent discovering the rest.
    """
    candidates: list[EditorCandidate] = []

    for editor, path in editor_settings_locations():
        text = read_text(path)
        if text is None:
            continue
        try:
            raw = loads_jsonc(text)
        except ValueError:
            continue
        if not isinstance(raw, dict):
            continue

        settings = extract_chatmd_settings(raw)
        if not settings:
            continue

        api_configs = settings.get("apiConfigs")
        mcp_servers = settings.get("mcpServers")
        candidates.append(
            EditorCandidate(
                editor=editor,
                settings_path=path,
                settings=settings,
                api_config_count=len(api_configs) if isinstance(api_configs, dict) else 0,
                mcp_server_count=len(mcp_servers) if isinstance(mcp_servers, dict) else 0,
            )
        )

    candidates.sort(key=lambda c: c.editor)
    return candidates
