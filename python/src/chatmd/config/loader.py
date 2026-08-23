"""Read and write ``~/.config/chat.md/config.json`` (honouring ``XDG_CONFIG_HOME``)."""

from __future__ import annotations

import json
import os
import tempfile
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from ..errors import ConfigError
from ..fileio import ensure_dir, read_text
from ..paths import config_path
from .discovery import EditorCandidate
from .jsonc import loads_jsonc
from .model import ChatmdConfig


def config_exists(path: Path | None = None) -> bool:
    """Whether the config file is present."""
    return (path or config_path()).is_file()


def load_config(path: Path | None = None) -> ChatmdConfig:
    """Load the global config, tolerating hand-written comments/trailing commas."""
    target = path or config_path()
    text = read_text(target)
    if text is None:
        raise ConfigError(f"Config file not found: {target}")
    try:
        data = loads_jsonc(text)
    except ValueError as exc:
        raise ConfigError(f"Malformed config file {target}: {exc}") from exc
    if not isinstance(data, dict):
        raise ConfigError(f"Malformed config file {target}: expected a JSON object")
    return ChatmdConfig.from_dict(data)


def save_config(config: ChatmdConfig, path: Path | None = None) -> Path:
    """Write ``config``, returning the path written.

    The file holds API keys, so it is created with mode 0o600 rather than
    whatever the umask would otherwise allow. Writing goes through a temp file
    in the same directory followed by ``os.replace`` so a crash or power loss
    mid-write can only orphan the temp file, never truncate an existing config.
    """
    target = path or config_path()
    ensure_dir(target.parent)
    body = json.dumps(config.to_dict(), indent=2) + "\n"

    fd, tmp_name = tempfile.mkstemp(dir=target.parent, prefix=f".{target.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(body)
        # mkstemp already creates the file at 0o600, but that is an
        # implementation detail of tempfile, not a documented guarantee — set
        # it explicitly since this permission is a security requirement.
        os.chmod(tmp_name, 0o600)
        os.replace(tmp_name, target)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise
    return target


def config_from_editor_candidates(candidates: Sequence[EditorCandidate]) -> ChatmdConfig:
    """Merge chatmd settings from several editor candidates into one config.

    Candidates are applied in the order given, later ones winning per key —
    except ``apiConfigs`` and ``mcpServers``, which merge per named entry so
    picking several editors combines their configs/servers instead of the
    last candidate's dict wholesale replacing the others'.
    """
    merged: dict[str, Any] = {}
    api_configs: dict[str, Any] = {}
    mcp_servers: dict[str, Any] = {}

    for candidate in candidates:
        for key, value in candidate.settings.items():
            if key == "apiConfigs" and isinstance(value, dict):
                api_configs.update(value)
            elif key == "mcpServers" and isinstance(value, dict):
                mcp_servers.update(value)
            else:
                merged[key] = value

    if api_configs:
        merged["apiConfigs"] = api_configs
    if mcp_servers:
        merged["mcpServers"] = mcp_servers

    return ChatmdConfig.from_dict(merged)
