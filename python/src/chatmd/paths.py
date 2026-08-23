"""XDG-style locations used by the CLI and the daemon."""

from __future__ import annotations

import os
from pathlib import Path

APP_DIR_NAME = "chat.md"


def _base(env_var: str, default: Path) -> Path:
    value = os.environ.get(env_var)
    return Path(value) if value else default


def config_dir() -> Path:
    """``$XDG_CONFIG_HOME/chat.md``, defaulting to ``~/.config/chat.md``."""
    return _base("XDG_CONFIG_HOME", Path.home() / ".config") / APP_DIR_NAME


def config_path() -> Path:
    return config_dir() / "config.json"


def state_dir() -> Path:
    """``$XDG_STATE_HOME/chat.md``, defaulting to ``~/.local/state/chat.md``."""
    return _base("XDG_STATE_HOME", Path.home() / ".local" / "state") / APP_DIR_NAME


def cache_dir() -> Path:
    return _base("XDG_CACHE_HOME", Path.home() / ".cache") / APP_DIR_NAME


def daemon_lock_path() -> Path:
    return state_dir() / "daemon.lock"


def daemon_info_path() -> Path:
    return state_dir() / "daemon.json"


def registry_path() -> Path:
    return state_dir() / "paths.json"


def commands_dir() -> Path:
    return state_dir() / "commands"


def status_path() -> Path:
    return state_dir() / "status.json"


def events_path() -> Path:
    return state_dir() / "events.jsonl"


def stats_db_path() -> Path:
    return state_dir() / "stats.db"


def daemon_log_path() -> Path:
    return state_dir() / "daemon.log"


def chat_lock_path(chat_file: str | Path) -> Path:
    """Hidden sibling lock file for a chat document."""
    target = Path(chat_file)
    return target.parent / f".{target.name}.lock"
