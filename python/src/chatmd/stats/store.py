"""SQLite rollups over the JSONL event log.

The log is the record; this is a cache of it. Ingestion tracks a byte offset so
each sync only reads what was appended since the last one, and a log that shrank
(rotated, or deleted) is detected and rebuilt from scratch rather than silently
reporting nonsense.
"""

from __future__ import annotations

import sqlite3
import time
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..fileio import ensure_dir
from ..paths import stats_db_path
from ..types import Usage
from .events import Event, EventKind, EventLog
from .pricing import estimate_cost

_SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS turns (
    at REAL NOT NULL,
    path TEXT NOT NULL,
    model TEXT,
    provider TEXT,
    config TEXT,
    outcome TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read_tokens INTEGER,
    cache_write_tokens INTEGER,
    duration_ms REAL,
    cost REAL
);
CREATE TABLE IF NOT EXISTS tool_calls (at REAL NOT NULL, path TEXT NOT NULL, tool TEXT);
CREATE TABLE IF NOT EXISTS errors (at REAL NOT NULL, path TEXT NOT NULL, message TEXT);
CREATE INDEX IF NOT EXISTS turns_at ON turns (at);
CREATE INDEX IF NOT EXISTS tool_calls_at ON tool_calls (at);
"""

_OFFSET_KEY = "ingest_offset"


@dataclass(frozen=True)
class GroupRow:
    """One row of a grouped summary."""

    key: str
    turns: int
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int
    cache_write_tokens: int
    cost: float | None
    duration_ms: float

    @property
    def total_tokens(self) -> int:
        return self.input_tokens + self.output_tokens


@dataclass(frozen=True)
class Totals:
    turns: int = 0
    tool_calls: int = 0
    errors: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    cost: float | None = None


#: What a summary may be grouped by, mapped to its column.
GROUP_COLUMNS = {
    "model": "model",
    "provider": "provider",
    "config": "config",
    "file": "path",
    "outcome": "outcome",
}

#: strftime formats for timeline buckets.
BUCKET_FORMATS = {"hour": "%Y-%m-%d %H:00", "day": "%Y-%m-%d", "month": "%Y-%m"}


class StatsStore:
    """Queryable rollups of the event log."""

    def __init__(
        self,
        db_path: str | Path | None = None,
        log_path: str | Path | None = None,
        *,
        pricing: dict[str, Any] | None = None,
    ) -> None:
        self.db_path = Path(db_path) if db_path is not None else stats_db_path()
        self.log = EventLog(log_path)
        self.pricing = pricing or {}
        ensure_dir(self.db_path.parent)
        self._db = sqlite3.connect(self.db_path)
        self._db.row_factory = sqlite3.Row
        self._db.executescript(_SCHEMA)
        self._db.commit()

    def close(self) -> None:
        self._db.close()

    def __enter__(self) -> StatsStore:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    # -- ingestion --------------------------------------------------------- #

    def sync(self) -> int:
        """Ingest whatever was appended since the last sync. Returns the count."""
        offset = self._offset()
        size = self.log.size()
        if size < offset:
            # The log shrank, so our offset points into a different file. Anything
            # we have is untrustworthy; start over.
            self._reset()
            offset = 0
        if size == offset:
            return 0

        ingested = 0
        for event in self.log.iter_events(offset=offset):
            self._insert(event)
            ingested += 1
        self._set_offset(size)
        self._db.commit()
        return ingested

    def _insert(self, event: Event) -> None:
        if event.kind is EventKind.TURN_END:
            usage = Usage(
                input_tokens=event.input_tokens,
                output_tokens=event.output_tokens,
                cache_read_tokens=event.cache_read_tokens,
                cache_write_tokens=event.cache_write_tokens,
            )
            self._db.execute(
                "INSERT INTO turns (at, path, model, provider, config, outcome,"
                " input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,"
                " duration_ms, cost) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    event.at,
                    event.path,
                    event.model,
                    event.provider,
                    event.config,
                    event.outcome,
                    event.input_tokens or 0,
                    event.output_tokens or 0,
                    event.cache_read_tokens or 0,
                    event.cache_write_tokens or 0,
                    event.duration_ms,
                    estimate_cost(event.model, usage, self.pricing),
                ),
            )
        elif event.kind is EventKind.TOOL_CALL:
            self._db.execute(
                "INSERT INTO tool_calls (at, path, tool) VALUES (?,?,?)",
                (event.at, event.path, event.tool),
            )
        elif event.kind is EventKind.ERROR:
            self._db.execute(
                "INSERT INTO errors (at, path, message) VALUES (?,?,?)",
                (event.at, event.path, event.message),
            )

    def _offset(self) -> int:
        row = self._db.execute("SELECT value FROM meta WHERE key = ?", (_OFFSET_KEY,)).fetchone()
        return int(row["value"]) if row else 0

    def _set_offset(self, offset: int) -> None:
        self._db.execute(
            "INSERT INTO meta (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (_OFFSET_KEY, str(offset)),
        )

    def _reset(self) -> None:
        for table in ("turns", "tool_calls", "errors"):
            self._db.execute(f"DELETE FROM {table}")  # noqa: S608 - fixed table names
        self._set_offset(0)
        self._db.commit()

    # -- queries ----------------------------------------------------------- #

    def summary(self, *, since: float | None = None, group_by: str = "model") -> list[GroupRow]:
        """Token and cost totals grouped by model, provider, config, file or outcome."""
        column = GROUP_COLUMNS.get(group_by)
        if column is None:
            raise ValueError(
                f"Unknown grouping {group_by!r}; expected one of {sorted(GROUP_COLUMNS)}"
            )
        rows = self._db.execute(
            f"SELECT COALESCE({column}, '(unknown)') AS key, COUNT(*) AS turns,"  # noqa: S608
            " SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,"
            " SUM(cache_read_tokens) AS cache_read_tokens,"
            " SUM(cache_write_tokens) AS cache_write_tokens,"
            " SUM(cost) AS cost, SUM(COALESCE(duration_ms, 0)) AS duration_ms"
            " FROM turns WHERE at >= ? GROUP BY key ORDER BY output_tokens DESC",
            (since or 0.0,),
        ).fetchall()
        return [self._group_row(row) for row in rows]

    def timeline(self, *, since: float | None = None, bucket: str = "day") -> list[GroupRow]:
        """The same totals bucketed by local hour, day or month."""
        fmt = BUCKET_FORMATS.get(bucket)
        if fmt is None:
            raise ValueError(
                f"Unknown bucket {bucket!r}; expected one of {sorted(BUCKET_FORMATS)}"
            )
        rows = self._db.execute(
            "SELECT strftime(?, at, 'unixepoch', 'localtime') AS key, COUNT(*) AS turns,"
            " SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,"
            " SUM(cache_read_tokens) AS cache_read_tokens,"
            " SUM(cache_write_tokens) AS cache_write_tokens,"
            " SUM(cost) AS cost, SUM(COALESCE(duration_ms, 0)) AS duration_ms"
            " FROM turns WHERE at >= ? GROUP BY key ORDER BY key",
            (fmt, since or 0.0),
        ).fetchall()
        return [self._group_row(row) for row in rows]

    def totals(self, *, since: float | None = None) -> Totals:
        cutoff = since or 0.0
        turn = self._db.execute(
            "SELECT COUNT(*) AS turns, SUM(input_tokens) AS input_tokens,"
            " SUM(output_tokens) AS output_tokens,"
            " SUM(cache_read_tokens) AS cache_read_tokens,"
            " SUM(cache_write_tokens) AS cache_write_tokens, SUM(cost) AS cost"
            " FROM turns WHERE at >= ?",
            (cutoff,),
        ).fetchone()
        tools = self._db.execute(
            "SELECT COUNT(*) AS n FROM tool_calls WHERE at >= ?", (cutoff,)
        ).fetchone()
        errors = self._db.execute(
            "SELECT COUNT(*) AS n FROM errors WHERE at >= ?", (cutoff,)
        ).fetchone()
        return Totals(
            turns=int(turn["turns"] or 0),
            tool_calls=int(tools["n"] or 0),
            errors=int(errors["n"] or 0),
            input_tokens=int(turn["input_tokens"] or 0),
            output_tokens=int(turn["output_tokens"] or 0),
            cache_read_tokens=int(turn["cache_read_tokens"] or 0),
            cache_write_tokens=int(turn["cache_write_tokens"] or 0),
            cost=turn["cost"],
        )

    def top_tools(self, *, since: float | None = None, limit: int = 10) -> list[tuple[str, int]]:
        rows = self._db.execute(
            "SELECT COALESCE(tool, '(unknown)') AS tool, COUNT(*) AS n FROM tool_calls"
            " WHERE at >= ? GROUP BY tool ORDER BY n DESC LIMIT ?",
            (since or 0.0, limit),
        ).fetchall()
        return [(row["tool"], int(row["n"])) for row in rows]

    @staticmethod
    def _group_row(row: sqlite3.Row) -> GroupRow:
        return GroupRow(
            key=str(row["key"]),
            turns=int(row["turns"] or 0),
            input_tokens=int(row["input_tokens"] or 0),
            output_tokens=int(row["output_tokens"] or 0),
            cache_read_tokens=int(row["cache_read_tokens"] or 0),
            cache_write_tokens=int(row["cache_write_tokens"] or 0),
            cost=row["cost"],
            duration_ms=float(row["duration_ms"] or 0.0),
        )


def since_timestamp(spec: str | None, *, now: float | None = None) -> float | None:
    """Parse a ``--since`` value like ``24h``, ``7d``, ``30m`` or ``all``."""
    if spec is None or spec.lower() in ("all", "any", ""):
        return None
    units = {"m": 60, "h": 3600, "d": 86400, "w": 604800}
    unit = spec[-1].lower()
    if unit not in units:
        raise ValueError(f"Unknown time span {spec!r}; use e.g. 30m, 24h, 7d, 4w or all")
    try:
        amount = float(spec[:-1])
    except ValueError as error:
        raise ValueError(f"Unknown time span {spec!r}") from error
    return (now if now is not None else time.time()) - amount * units[unit]


def ingest_all(events: Iterable[Event], store: StatsStore) -> None:
    """Insert events straight into a store, bypassing the log. For tests."""
    for event in events:
        store._insert(event)  # noqa: SLF001 - deliberate test seam
    store._db.commit()  # noqa: SLF001
