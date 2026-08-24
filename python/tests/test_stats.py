"""Tests for the event log, its rollups, and cost estimation."""

from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

from chatmd.stats.events import Event, EventKind, EventLog
from chatmd.stats.pricing import estimate_cost, find_prices
from chatmd.stats.store import StatsStore, since_timestamp
from chatmd.types import Usage

PRICES = {"claude-opus-5": {"input": 5.0, "output": 25.0, "cacheRead": 0.5}}


def log_and_store(tmp_path: Path, *events: Event, pricing: dict | None = None) -> StatsStore:
    log = EventLog(tmp_path / "events.jsonl")
    for event in events:
        log.append(event)
    store = StatsStore(tmp_path / "stats.db", log.path, pricing=pricing)
    store.sync()
    return store


def turn(
    *,
    model: str = "claude-opus-5",
    path: str = "/chats/a.chat.md",
    at: float | None = None,
    output: int = 100,
    input_: int = 1000,
    outcome: str = "completed",
) -> Event:
    return Event(
        kind=EventKind.TURN_END,
        path=path,
        at=at if at is not None else time.time(),
        model=model,
        provider="anthropic",
        config="sonnet",
        outcome=outcome,
        input_tokens=input_,
        output_tokens=output,
        duration_ms=1500.0,
    )


# --------------------------------------------------------------------------- #
# Event log
# --------------------------------------------------------------------------- #


def test_events_round_trip_through_the_log(tmp_path: Path) -> None:
    log = EventLog(tmp_path / "events.jsonl")
    log.append(turn(output=42))
    log.append(Event(kind=EventKind.TOOL_CALL, path="/a.chat.md", tool="wcgw.BashCommand"))

    events = list(log.iter_events())
    assert [event.kind for event in events] == [EventKind.TURN_END, EventKind.TOOL_CALL]
    assert events[0].output_tokens == 42
    assert events[1].tool == "wcgw.BashCommand"


def test_unset_fields_are_left_out_of_the_line(tmp_path: Path) -> None:
    log = EventLog(tmp_path / "events.jsonl")
    log.append(Event(kind=EventKind.TOOL_CALL, path="/a.chat.md", tool="x"))
    written = json.loads(log.path.read_text().strip())
    assert "input_tokens" not in written
    assert written["tool"] == "x"


def test_a_torn_or_unknown_line_does_not_stop_the_read(tmp_path: Path) -> None:
    """A crash mid-append must not make the whole history unreadable."""
    log = EventLog(tmp_path / "events.jsonl")
    log.append(turn(output=1))
    with open(log.path, "a", encoding="utf-8") as handle:
        handle.write('{"kind": "from_the_future", "at": 1}\n')
        handle.write("{not json at all\n")
    log.append(turn(output=2))

    assert [event.output_tokens for event in log.iter_events()] == [1, 2]


def test_reading_a_missing_log_yields_nothing(tmp_path: Path) -> None:
    assert list(EventLog(tmp_path / "nope.jsonl").iter_events()) == []


def test_appending_never_raises_when_the_path_is_unusable(tmp_path: Path) -> None:
    """Telemetry must never be able to break a chat."""
    blocked = tmp_path / "dir"
    blocked.mkdir()
    EventLog(blocked).append(turn())  # the path is a directory


def test_since_filters_by_timestamp(tmp_path: Path) -> None:
    log = EventLog(tmp_path / "events.jsonl")
    log.append(turn(at=1000.0, output=1))
    log.append(turn(at=2000.0, output=2))
    assert [e.output_tokens for e in log.iter_events(since=1500.0)] == [2]


# --------------------------------------------------------------------------- #
# Rollups
# --------------------------------------------------------------------------- #


def test_summary_groups_by_model(tmp_path: Path) -> None:
    store = log_and_store(
        tmp_path,
        turn(model="claude-opus-5", output=100),
        turn(model="claude-opus-5", output=50),
        turn(model="gpt-5", output=10),
    )
    rows = {row.key: row for row in store.summary()}
    assert rows["claude-opus-5"].turns == 2
    assert rows["claude-opus-5"].output_tokens == 150
    assert rows["gpt-5"].turns == 1
    store.close()


@pytest.mark.parametrize("group_by", ["model", "provider", "config", "file", "outcome"])
def test_every_supported_grouping_works(tmp_path: Path, group_by: str) -> None:
    store = log_and_store(tmp_path, turn())
    assert len(store.summary(group_by=group_by)) == 1
    store.close()


def test_an_unknown_grouping_is_rejected(tmp_path: Path) -> None:
    store = log_and_store(tmp_path, turn())
    with pytest.raises(ValueError, match="Unknown grouping"):
        store.summary(group_by="colour")
    store.close()


def test_timeline_buckets_by_day(tmp_path: Path) -> None:
    day = 86400.0
    store = log_and_store(
        tmp_path,
        turn(at=1_700_000_000.0, output=5),
        turn(at=1_700_000_000.0 + day, output=7),
    )
    rows = store.timeline(bucket="day")
    assert len(rows) == 2
    assert [row.output_tokens for row in rows] == [5, 7]
    store.close()


def test_totals_count_turns_tools_and_errors(tmp_path: Path) -> None:
    store = log_and_store(
        tmp_path,
        turn(output=10),
        Event(kind=EventKind.TOOL_CALL, path="/a.chat.md", tool="t"),
        Event(kind=EventKind.ERROR, path="/a.chat.md", message="boom"),
    )
    totals = store.totals()
    assert (totals.turns, totals.tool_calls, totals.errors) == (1, 1, 1)
    assert totals.output_tokens == 10
    store.close()


def test_top_tools_ranks_by_use(tmp_path: Path) -> None:
    store = log_and_store(
        tmp_path,
        Event(kind=EventKind.TOOL_CALL, path="/a", tool="read"),
        Event(kind=EventKind.TOOL_CALL, path="/a", tool="read"),
        Event(kind=EventKind.TOOL_CALL, path="/a", tool="write"),
    )
    assert store.top_tools() == [("read", 2), ("write", 1)]
    store.close()


def test_sync_is_incremental(tmp_path: Path) -> None:
    """Only new bytes are read, so the log can grow without rescanning history."""
    log = EventLog(tmp_path / "events.jsonl")
    log.append(turn(output=1))
    store = StatsStore(tmp_path / "stats.db", log.path)
    assert store.sync() == 1
    assert store.sync() == 0

    log.append(turn(output=2))
    assert store.sync() == 1
    assert store.totals().turns == 2
    store.close()


def test_a_truncated_log_is_rebuilt_rather_than_double_counted(tmp_path: Path) -> None:
    """A rotated log would otherwise leave the offset pointing into another file."""
    log = EventLog(tmp_path / "events.jsonl")
    log.append(turn(output=1))
    log.append(turn(output=2))
    store = StatsStore(tmp_path / "stats.db", log.path)
    store.sync()
    assert store.totals().turns == 2

    log.path.write_text("")  # rotated away
    log.append(turn(output=9))
    store.sync()

    totals = store.totals()
    assert totals.turns == 1
    assert totals.output_tokens == 9
    store.close()


# --------------------------------------------------------------------------- #
# Cost
# --------------------------------------------------------------------------- #


def test_cost_is_computed_from_configured_prices(tmp_path: Path) -> None:
    store = log_and_store(
        tmp_path,
        turn(model="claude-opus-5", input_=1_000_000, output=1_000_000),
        pricing=PRICES,
    )
    assert store.totals().cost == pytest.approx(30.0)
    store.close()


def test_an_unpriced_model_reports_no_cost_rather_than_zero(tmp_path: Path) -> None:
    """A blank is honest; a zero would read as free."""
    store = log_and_store(tmp_path, turn(model="some-local-model"), pricing=PRICES)
    assert store.totals().cost is None
    store.close()


def test_prices_match_by_longest_prefix() -> None:
    pricing = {"claude": {"output": 1.0}, "claude-opus-5": {"output": 2.0}}
    found = find_prices("claude-opus-5-20260101", pricing)
    assert found is not None and found["output"] == 2.0


def test_estimate_cost_handles_missing_pieces() -> None:
    assert estimate_cost("claude-opus-5", None, PRICES) is None
    assert estimate_cost(None, Usage(output_tokens=10), PRICES) is None
    assert estimate_cost("claude-opus-5", Usage(output_tokens=10), {}) is None
    # A usage field with no configured rate simply contributes nothing.
    cost = estimate_cost("claude-opus-5", Usage(cache_write_tokens=1_000_000), PRICES)
    assert cost == pytest.approx(0.0)


# --------------------------------------------------------------------------- #
# --since parsing
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("spec", "expected_delta"),
    [("30m", 1800), ("24h", 86400), ("7d", 604800), ("2w", 1209600)],
)
def test_since_spans(spec: str, expected_delta: float) -> None:
    assert since_timestamp(spec, now=1_000_000.0) == 1_000_000.0 - expected_delta


@pytest.mark.parametrize("spec", [None, "all", ""])
def test_since_all_means_no_cutoff(spec: str | None) -> None:
    assert since_timestamp(spec) is None


@pytest.mark.parametrize("spec", ["yesterday", "5x", "d"])
def test_a_bad_span_is_rejected(spec: str) -> None:
    with pytest.raises(ValueError):
        since_timestamp(spec)
