"""The daemon's on-disk control plane.

There is no socket and no port. Everything the CLI and the daemon say to each
other goes through files in the state directory:

* ``paths.json``   — the folders and globs to watch. The CLI writes it; the daemon
  watches it, so registering a path takes effect without a restart.
* ``commands/``    — one JSON file per request (reload, shutdown, ...), answered by
  a sibling ``.done.json``. A drop directory rather than a request/response
  channel, so a command survives the daemon being momentarily down.
* ``status.json``  — a snapshot the daemon rewrites about once a second, which is
  what ``chatmd status``, ``chatmd live`` and ``chatmd mcp status`` read.
* ``daemon.json``  — who the running daemon is.

Every write here is atomic (temp file plus rename): readers poll these files, and
a reader must never see half a snapshot.
"""

from __future__ import annotations

import json
import os
import tempfile
import time
import uuid
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Any

from ..fileio import ensure_dir
from ..paths import commands_dir, daemon_info_path, registry_path, status_path
from ..types import McpServerStatus


class FileState(StrEnum):
    IDLE = "idle"
    STREAMING = "streaming"
    EXECUTING = "executing"
    LOCKED = "locked"
    ERROR = "error"


class CommandName(StrEnum):
    RELOAD_CONFIG = "reload-config"
    ADD_PATH = "add-path"
    REMOVE_PATH = "remove-path"
    STOP_FILE = "stop-file"
    MCP_REFRESH = "mcp-refresh"
    SHUTDOWN = "shutdown"


def write_json_atomic(path: Path, payload: Any) -> None:
    """Write JSON so a concurrent reader sees either the old or the new file."""
    ensure_dir(path.parent)
    handle, temporary = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            json.dump(payload, stream, indent=2)
            stream.write("\n")
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def read_json(path: Path) -> Any | None:
    """Read JSON, or None when it is missing or unparseable."""
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return None
    if not raw.strip():
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


# --------------------------------------------------------------------------- #
# daemon.json
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class DaemonInfo:
    pid: int
    host: str
    started_at: float
    version: str
    roots: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "pid": self.pid,
            "host": self.host,
            "startedAt": self.started_at,
            "version": self.version,
            "roots": list(self.roots),
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> DaemonInfo:
        return cls(
            pid=int(data.get("pid", 0)),
            host=str(data.get("host", "")),
            started_at=float(data.get("startedAt", 0.0)),
            version=str(data.get("version", "")),
            roots=[str(item) for item in data.get("roots") or []],
        )


def write_daemon_info(info: DaemonInfo, path: Path | None = None) -> None:
    write_json_atomic(path or daemon_info_path(), info.to_dict())


def read_daemon_info(path: Path | None = None) -> DaemonInfo | None:
    data = read_json(path or daemon_info_path())
    return DaemonInfo.from_dict(data) if isinstance(data, dict) else None


def clear_daemon_info(path: Path | None = None) -> None:
    try:
        (path or daemon_info_path()).unlink()
    except OSError:
        pass


# --------------------------------------------------------------------------- #
# paths.json
# --------------------------------------------------------------------------- #


def read_registry(path: Path | None = None) -> list[str]:
    """The registered watch paths, in the order they were added."""
    data = read_json(path or registry_path())
    if not isinstance(data, dict):
        return []
    return [str(item) for item in data.get("paths") or []]


def write_registry(paths: list[str], path: Path | None = None) -> None:
    write_json_atomic(path or registry_path(), {"version": 1, "paths": list(paths)})


def add_registry_path(target: str | Path, path: Path | None = None) -> list[str]:
    """Register a folder or glob, keeping the list unique and ordered."""
    resolved = str(Path(target).expanduser())
    current = read_registry(path)
    if resolved not in current:
        current.append(resolved)
        write_registry(current, path)
    return current


def remove_registry_path(target: str | Path, path: Path | None = None) -> list[str]:
    resolved = str(Path(target).expanduser())
    current = [item for item in read_registry(path) if item != resolved]
    write_registry(current, path)
    return current


# --------------------------------------------------------------------------- #
# commands/
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class Command:
    name: CommandName
    id: str
    at: float = field(default_factory=time.time)
    payload: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {"cmd": str(self.name), "id": self.id, "at": self.at, **self.payload}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Command | None:
        name = data.get("cmd")
        if name not in tuple(CommandName):
            return None
        payload = {key: value for key, value in data.items() if key not in ("cmd", "id", "at")}
        return cls(
            name=CommandName(name),
            id=str(data.get("id", "")),
            at=float(data.get("at", 0.0)),
            payload=payload,
        )


def send_command(
    name: CommandName, payload: dict[str, Any] | None = None, directory: Path | None = None
) -> str:
    """Drop a command for the daemon to pick up. Returns its id."""
    target = directory or commands_dir()
    ensure_dir(target)
    identifier = uuid.uuid4().hex[:12]
    command = Command(name=name, id=identifier, payload=payload or {})
    write_json_atomic(target / f"{identifier}.json", command.to_dict())
    return identifier


def pending_commands(directory: Path | None = None) -> list[tuple[Path, Command]]:
    """Unanswered commands, oldest first. Unreadable ones are dropped, not retried."""
    target = directory or commands_dir()
    try:
        entries = sorted(target.glob("*.json"), key=lambda item: item.stat().st_mtime)
    except OSError:
        return []

    found: list[tuple[Path, Command]] = []
    for entry in entries:
        if entry.name.endswith(".done.json"):
            continue
        data = read_json(entry)
        command = Command.from_dict(data) if isinstance(data, dict) else None
        if command is None:
            try:
                entry.unlink()
            except OSError:
                pass
            continue
        found.append((entry, command))
    return found


def complete_command(request: Path, result: dict[str, Any] | None = None) -> None:
    """Answer a command and remove the request."""
    payload: dict[str, Any] = {"ok": True, "at": time.time()}
    payload.update(result or {})
    write_json_atomic(request.with_suffix(".done.json"), payload)
    try:
        request.unlink()
    except OSError:
        pass


def read_command_result(identifier: str, directory: Path | None = None) -> dict[str, Any] | None:
    data = read_json((directory or commands_dir()) / f"{identifier}.done.json")
    return data if isinstance(data, dict) else None


# --------------------------------------------------------------------------- #
# status.json
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class FileActivity:
    path: str
    state: FileState = FileState.IDLE
    since: float = 0.0
    model: str | None = None
    tool: str | None = None
    characters: int = 0
    message: str | None = None

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "path": self.path,
            "state": str(self.state),
            "since": self.since,
            "characters": self.characters,
        }
        for name in ("model", "tool", "message"):
            value = getattr(self, name)
            if value is not None:
                out[name] = value
        return out

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> FileActivity:
        raw_state = data.get("state", FileState.IDLE)
        state = FileState(raw_state) if raw_state in tuple(FileState) else FileState.IDLE
        return cls(
            path=str(data.get("path", "")),
            state=state,
            since=float(data.get("since", 0.0)),
            model=data.get("model"),
            tool=data.get("tool"),
            characters=int(data.get("characters", 0)),
            message=data.get("message"),
        )


def _mcp_to_dict(status: McpServerStatus) -> dict[str, Any]:
    return {
        "serverId": status.server_id,
        "state": status.state,
        "toolCount": status.tool_count,
        "promptCount": status.prompt_count,
        "resourceCount": status.resource_count,
        "lastError": status.last_error,
        "connectedSince": status.connected_since,
    }


def _mcp_from_dict(data: dict[str, Any]) -> McpServerStatus:
    return McpServerStatus(
        server_id=str(data.get("serverId", "")),
        state=data.get("state", "not-started"),
        tool_count=int(data.get("toolCount", 0)),
        prompt_count=int(data.get("promptCount", 0)),
        resource_count=int(data.get("resourceCount", 0)),
        last_error=data.get("lastError"),
        connected_since=data.get("connectedSince"),
    )


@dataclass(frozen=True)
class DaemonStatus:
    """The snapshot the daemon publishes for the CLI to render."""

    at: float = field(default_factory=time.time)
    daemon: DaemonInfo | None = None
    watching: list[str] = field(default_factory=list)
    files: list[FileActivity] = field(default_factory=list)
    mcp: list[McpServerStatus] = field(default_factory=list)
    turns: int = 0
    tool_calls: int = 0
    errors: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "at": self.at,
            "daemon": self.daemon.to_dict() if self.daemon else None,
            "watching": list(self.watching),
            "files": [item.to_dict() for item in self.files],
            "mcp": [_mcp_to_dict(item) for item in self.mcp],
            "turns": self.turns,
            "toolCalls": self.tool_calls,
            "errors": self.errors,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> DaemonStatus:
        daemon = data.get("daemon")
        return cls(
            at=float(data.get("at", 0.0)),
            daemon=DaemonInfo.from_dict(daemon) if isinstance(daemon, dict) else None,
            watching=[str(item) for item in data.get("watching") or []],
            files=[
                FileActivity.from_dict(item)
                for item in data.get("files") or []
                if isinstance(item, dict)
            ],
            mcp=[
                _mcp_from_dict(item) for item in data.get("mcp") or [] if isinstance(item, dict)
            ],
            turns=int(data.get("turns", 0)),
            tool_calls=int(data.get("toolCalls", 0)),
            errors=int(data.get("errors", 0)),
        )

    @property
    def active_files(self) -> list[FileActivity]:
        return [item for item in self.files if item.state is not FileState.IDLE]


def write_status(status: DaemonStatus, path: Path | None = None) -> None:
    write_json_atomic(path or status_path(), status.to_dict())


def read_status(path: Path | None = None) -> DaemonStatus | None:
    data = read_json(path or status_path())
    return DaemonStatus.from_dict(data) if isinstance(data, dict) else None


def clear_status(path: Path | None = None) -> None:
    try:
        (path or status_path()).unlink()
    except OSError:
        pass
