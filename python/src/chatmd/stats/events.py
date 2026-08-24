"""Append-only event log.

Every turn, tool call and error the engine handles is appended here as one JSON
line. It is the raw record; :mod:`chatmd.stats.store` rolls it up for reporting.

One line per event, written with a single ``write`` to an ``O_APPEND`` descriptor,
which POSIX makes atomic for writes of this size. That is what lets several
processes -- the daemon and any number of one-shot CLI runs -- share one log
without coordinating.
"""

from __future__ import annotations

import json
import os
import time
from collections.abc import Iterator
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Any

from ..fileio import ensure_dir
from ..paths import events_path
from ..types import Usage


class EventKind(StrEnum):
    TURN_START = "turn_start"
    TURN_END = "turn_end"
    TOOL_CALL = "tool_call"
    ERROR = "error"


@dataclass(frozen=True)
class Event:
    """One thing that happened, flat enough to be one JSON object."""

    kind: EventKind
    path: str
    at: float = field(default_factory=time.time)
    model: str | None = None
    provider: str | None = None
    config: str | None = None
    outcome: str | None = None
    tool: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    cache_read_tokens: int | None = None
    cache_write_tokens: int | None = None
    duration_ms: float | None = None
    message: str | None = None

    @classmethod
    def turn_end(
        cls,
        path: str,
        *,
        model: str | None,
        provider: str | None,
        config: str | None,
        outcome: str,
        usage: Usage | None,
        duration_ms: float,
    ) -> Event:
        return cls(
            kind=EventKind.TURN_END,
            path=path,
            model=model,
            provider=provider,
            config=config,
            outcome=outcome,
            duration_ms=duration_ms,
            input_tokens=usage.input_tokens if usage else None,
            output_tokens=usage.output_tokens if usage else None,
            cache_read_tokens=usage.cache_read_tokens if usage else None,
            cache_write_tokens=usage.cache_write_tokens if usage else None,
        )

    def to_dict(self) -> dict[str, Any]:
        """Omits unset fields, so a log line stays readable by eye."""
        out: dict[str, Any] = {"kind": str(self.kind), "at": self.at, "path": self.path}
        for name in (
            "model",
            "provider",
            "config",
            "outcome",
            "tool",
            "input_tokens",
            "output_tokens",
            "cache_read_tokens",
            "cache_write_tokens",
            "duration_ms",
            "message",
        ):
            value = getattr(self, name)
            if value is not None:
                out[name] = value
        return out

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Event | None:
        """Returns None for a line this version does not understand.

        A log written by a newer build, or a line torn by a crash, must not stop
        the rest of the log from being read.
        """
        kind = data.get("kind")
        if kind not in tuple(EventKind):
            return None
        try:
            return cls(
                kind=EventKind(kind),
                path=str(data.get("path", "")),
                at=float(data.get("at", 0.0)),
                model=data.get("model"),
                provider=data.get("provider"),
                config=data.get("config"),
                outcome=data.get("outcome"),
                tool=data.get("tool"),
                input_tokens=data.get("input_tokens"),
                output_tokens=data.get("output_tokens"),
                cache_read_tokens=data.get("cache_read_tokens"),
                cache_write_tokens=data.get("cache_write_tokens"),
                duration_ms=data.get("duration_ms"),
                message=data.get("message"),
            )
        except (TypeError, ValueError):
            return None


class EventLog:
    """The JSONL log, appendable from several processes at once."""

    def __init__(self, path: str | Path | None = None) -> None:
        self.path = Path(path) if path is not None else events_path()

    def append(self, event: Event) -> None:
        """Append one event. Failures are swallowed: telemetry must never break a chat."""
        line = json.dumps(event.to_dict(), separators=(",", ":")) + "\n"
        try:
            ensure_dir(self.path.parent)
            fd = os.open(self.path, os.O_CREAT | os.O_WRONLY | os.O_APPEND, 0o644)
        except OSError:
            return
        try:
            os.write(fd, line.encode("utf-8"))
        except OSError:
            pass
        finally:
            os.close(fd)

    def size(self) -> int:
        try:
            return self.path.stat().st_size
        except OSError:
            return 0

    def iter_events(self, *, since: float | None = None, offset: int = 0) -> Iterator[Event]:
        """Read events from ``offset`` bytes in, skipping anything unparseable."""
        try:
            handle = open(self.path, encoding="utf-8")
        except OSError:
            return
        with handle:
            if offset:
                handle.seek(offset)
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    data = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(data, dict):
                    continue
                event = Event.from_dict(data)
                if event is None:
                    continue
                if since is not None and event.at < since:
                    continue
                yield event
