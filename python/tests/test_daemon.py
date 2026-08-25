"""Tests for the listener: what it watches, what it publishes, and what it survives.

No real MCP servers, no network, no LLM calls — the pool and the driver are both
injected. Every test runs against a temporary XDG state root.
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Any

import pytest

from chatmd.config.model import ChatmdConfig
from chatmd.daemon.state import (
    CommandName,
    DaemonInfo,
    FileState,
    pending_commands,
    prune_completed_commands,
    read_command_result,
    read_daemon_info,
    read_registry,
    read_status,
    send_command,
    write_daemon_info,
    write_json_atomic,
    write_registry,
)
from chatmd.daemon.supervisor import Daemon
from chatmd.daemon.watcher import (
    WatchTarget,
    existing_roots,
    find_chat_files,
    matches,
    resolve_targets,
    watch_chat_files,
)
from chatmd.engine.driver import StepAction, StepResult
from chatmd.engine.locks import daemon_lock
from chatmd.paths import commands_dir, events_path
from chatmd.stats.events import EventKind, EventLog
from chatmd.types import McpServerStatus, Usage

TIMEOUT = 10.0


@pytest.fixture
def state(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "state"))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "config"))
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "cache"))
    return tmp_path


class FakePool:
    def __init__(self, *_args: Any, **_kwargs: Any) -> None:
        self.started = 0
        self.closed = 0

    async def start(self) -> None:
        self.started += 1

    async def aclose(self) -> None:
        self.closed += 1

    def status(self) -> list[McpServerStatus]:
        return [McpServerStatus(server_id="fake", state="connected", tool_count=3)]


class FakeDriver:
    """Returns canned step results, or raises, per path."""

    def __init__(self, results: list[StepResult] | None = None) -> None:
        self.results = results or []
        self.raises: Exception | None = None
        self.seen: list[Path] = []
        self.ran = asyncio.Event()

    async def run(
        self, path: str | Path, *, max_rounds: int | None = None
    ) -> list[StepResult]:
        self.seen.append(Path(path))
        self.ran.set()
        if self.raises is not None:
            raise self.raises
        return [
            StepResult(**{**result.__dict__, "path": Path(path)}) for result in self.results
        ]


def make_daemon(driver: FakeDriver, pool: FakePool | None = None, **kwargs: Any) -> Daemon:
    the_pool = pool or FakePool()
    return Daemon(
        ChatmdConfig(),
        pool_factory=lambda _config: the_pool,
        driver_factory=lambda _config, _pool: driver,
        poll_interval=0.02,
        status_interval=0.02,
        **kwargs,
    )


async def run_briefly(daemon: Daemon, body: Any) -> int:
    """Start the daemon, run `body`, then stop it. Never hangs."""
    task = asyncio.create_task(daemon.run())
    try:
        await asyncio.wait_for(_await_started(), timeout=TIMEOUT)
        await asyncio.wait_for(body(), timeout=TIMEOUT)
    finally:
        # Stop and reap inside the finally so a failing body still releases the
        # daemon lock, but return outside it: returning from a finally would
        # swallow that failure and make every test here pass regardless.
        await daemon.stop()
        exit_code = await asyncio.wait_for(task, timeout=TIMEOUT)
    return exit_code


async def _await_started() -> None:
    while read_daemon_info() is None:
        await asyncio.sleep(0.01)


async def _wait_until(predicate: Any) -> None:
    while not predicate():
        await asyncio.sleep(0.01)


# --------------------------------------------------------------------------- #
# resolve_targets / matches
# --------------------------------------------------------------------------- #


def test_a_directory_is_watched_whole(tmp_path: Path) -> None:
    targets = resolve_targets([tmp_path])
    assert targets == [WatchTarget(root=tmp_path, pattern=None)]


def test_a_single_chat_file_watches_its_directory(tmp_path: Path) -> None:
    """Editors often replace a file rather than modify it, so watch the folder."""
    chat = tmp_path / "notes.chat.md"
    targets = resolve_targets([chat])
    assert targets == [WatchTarget(root=tmp_path, pattern="notes.chat.md")]


def test_a_glob_splits_into_its_literal_parent_and_a_pattern(tmp_path: Path) -> None:
    targets = resolve_targets([tmp_path / "projects" / "*" / "*.chat.md"])
    assert targets[0].root == tmp_path / "projects"
    assert targets[0].pattern == "*/*.chat.md"


def test_home_is_expanded() -> None:
    target = resolve_targets(["~/chats"])[0]
    assert "~" not in str(target.root)
    assert str(target.root).startswith(str(Path.home()))


@pytest.mark.parametrize(
    "name",
    ["a.chat.md", "deep.chat.md"],
)
def test_chat_files_match(tmp_path: Path, name: str) -> None:
    target = WatchTarget(root=tmp_path)
    assert matches(target, tmp_path / name)


@pytest.mark.parametrize(
    "relative",
    [
        "notes.md",  # not a chat file
        "notes.txt",
        ".notes.chat.md.lock",  # our own lock
        ".hidden.chat.md",  # hidden files are ours
        "cmdassets/tool-result.chat.md",  # our own asset directory
    ],
)
def test_what_the_engine_writes_itself_is_ignored(tmp_path: Path, relative: str) -> None:
    """Reacting to our own writes would make the listener chase its tail."""
    target = WatchTarget(root=tmp_path)
    assert not matches(target, tmp_path / relative)


def test_a_file_outside_the_root_does_not_match(tmp_path: Path) -> None:
    target = WatchTarget(root=tmp_path / "inside")
    assert not matches(target, tmp_path / "outside" / "a.chat.md")


def test_a_pattern_narrows_which_files_match(tmp_path: Path) -> None:
    target = WatchTarget(root=tmp_path, pattern="wanted.chat.md")
    assert matches(target, tmp_path / "wanted.chat.md")
    assert not matches(target, tmp_path / "other.chat.md")


def test_a_missing_root_is_skipped_rather_than_fatal(tmp_path: Path) -> None:
    """One unregistered folder must not stop every other one being watched."""
    roots = existing_roots(
        [WatchTarget(root=tmp_path), WatchTarget(root=tmp_path / "gone")]
    )
    assert roots == [str(tmp_path)]


def test_no_existing_roots_yields_nothing(tmp_path: Path) -> None:
    async def drain() -> list[set[Path]]:
        return [batch async for batch in watch_chat_files([tmp_path / "gone"])]

    assert asyncio.run(drain()) == []


# --------------------------------------------------------------------------- #
# Watching for real
# --------------------------------------------------------------------------- #


async def test_changes_are_coalesced_into_one_batch(tmp_path: Path) -> None:
    chats = tmp_path / "chats"
    chats.mkdir()
    stop = asyncio.Event()
    batches: list[set[Path]] = []

    async def collect() -> None:
        async for batch in watch_chat_files([chats], debounce_ms=200, stop=stop):
            batches.append(batch)
            stop.set()

    task = asyncio.create_task(collect())
    await asyncio.sleep(0.3)
    for index in range(3):
        (chats / "a.chat.md").write_text(f"# %% user\n{index}\n", encoding="utf-8")
        (chats / "cmdassets").mkdir(exist_ok=True)
        (chats / "cmdassets" / "noise.txt").write_text("x", encoding="utf-8")
        await asyncio.sleep(0.02)

    await asyncio.wait_for(task, timeout=TIMEOUT)
    assert batches
    # Three writes to one file, coalesced, and the asset write filtered out.
    assert batches[0] == {chats / "a.chat.md"}


# --------------------------------------------------------------------------- #
# Singleton
# --------------------------------------------------------------------------- #


async def test_a_second_listener_refuses_to_start(state: Path) -> None:
    """Two listeners would both answer the same empty assistant block."""
    holder = daemon_lock()
    holder.acquire()
    original = DaemonInfo(pid=os.getpid(), host="h", started_at=1.0, version="original")
    write_daemon_info(original)
    try:
        exit_code = await asyncio.wait_for(
            make_daemon(FakeDriver()).run(), timeout=TIMEOUT
        )
    finally:
        holder.release()

    assert exit_code == 1
    # It must not have stamped its own identity over the running listener's.
    still = read_daemon_info()
    assert still is not None and still.version == "original"


async def test_a_listener_publishes_and_then_cleans_up(state: Path) -> None:
    daemon = make_daemon(FakeDriver())

    async def body() -> None:
        info = read_daemon_info()
        assert info is not None and info.pid == os.getpid()

    assert await run_briefly(daemon, body) == 0
    # State files are cleared, so `chatmd status` does not report a ghost.
    assert read_daemon_info() is None
    assert read_status() is None


# --------------------------------------------------------------------------- #
# Status
# --------------------------------------------------------------------------- #


async def test_status_carries_the_mcp_servers_and_counters(state: Path) -> None:
    daemon = make_daemon(FakeDriver())

    async def body() -> None:
        await _wait_until(lambda: read_status() is not None)
        snapshot = read_status()
        assert snapshot is not None
        assert [server.server_id for server in snapshot.mcp] == ["fake"]
        assert snapshot.daemon is not None

    await run_briefly(daemon, body)


async def test_the_pool_is_started_once_and_closed_on_exit(state: Path) -> None:
    pool = FakePool()
    daemon = make_daemon(FakeDriver(), pool=pool)

    async def body() -> None:
        assert pool.started == 1

    await run_briefly(daemon, body)
    assert pool.closed == 1


# --------------------------------------------------------------------------- #
# Commands
# --------------------------------------------------------------------------- #


async def test_shutdown_stops_the_listener(state: Path) -> None:
    daemon = make_daemon(FakeDriver())
    task = asyncio.create_task(daemon.run())
    await asyncio.wait_for(_await_started(), timeout=TIMEOUT)

    identifier = send_command(CommandName.SHUTDOWN)
    assert await asyncio.wait_for(task, timeout=TIMEOUT) == 0
    assert read_command_result(identifier) is not None


@pytest.mark.parametrize(
    "name",
    [CommandName.RELOAD_CONFIG, CommandName.MCP_REFRESH, CommandName.STOP_FILE],
)
async def test_every_command_gets_an_answer(state: Path, name: CommandName) -> None:
    """A CLI waiting on a command must never be left hanging."""
    daemon = make_daemon(FakeDriver())

    async def body() -> None:
        identifier = send_command(name, {"path": "/nowhere.chat.md"})
        await _wait_until(lambda: read_command_result(identifier) is not None)

    await run_briefly(daemon, body)


async def test_add_and_remove_path_update_the_registry(state: Path) -> None:
    daemon = make_daemon(FakeDriver())
    target = state / "chats"
    target.mkdir()

    async def body() -> None:
        added = send_command(CommandName.ADD_PATH, {"path": str(target)})
        await _wait_until(lambda: read_command_result(added) is not None)
        assert str(target) in read_registry()

        removed = send_command(CommandName.REMOVE_PATH, {"path": str(target)})
        await _wait_until(lambda: read_command_result(removed) is not None)
        assert str(target) not in read_registry()

    await run_briefly(daemon, body)


async def test_an_unreadable_command_is_discarded_not_retried(state: Path) -> None:
    directory = commands_dir()
    directory.mkdir(parents=True, exist_ok=True)
    write_json_atomic(directory / "bogus.json", {"cmd": "not-a-real-command"})

    assert pending_commands() == []
    assert not (directory / "bogus.json").exists()


# --------------------------------------------------------------------------- #
# Driving files
# --------------------------------------------------------------------------- #


async def test_a_changed_file_is_driven(state: Path) -> None:
    chats = state / "chats"
    chats.mkdir()
    write_registry([str(chats)])
    driver = FakeDriver()
    daemon = make_daemon(driver)

    async def body() -> None:
        await asyncio.sleep(0.4)  # let the watcher settle before touching anything
        (chats / "a.chat.md").write_text("# %% user\nhi\n\n# %% assistant\n", encoding="utf-8")
        await asyncio.wait_for(driver.ran.wait(), timeout=TIMEOUT)
        assert driver.seen == [chats / "a.chat.md"]

    await run_briefly(daemon, body)


async def test_a_failing_file_does_not_stop_the_listener(state: Path) -> None:
    driver = FakeDriver()
    driver.raises = RuntimeError("provider exploded")
    daemon = make_daemon(driver)

    async def body() -> None:
        daemon._schedule(state / "boom.chat.md")  # noqa: SLF001 - drives one file directly
        await asyncio.wait_for(driver.ran.wait(), timeout=TIMEOUT)
        await _wait_until(lambda: daemon.snapshot().errors == 1)
        activity = {item.path: item for item in daemon.snapshot().files}
        assert activity[str(state / "boom.chat.md")].state is FileState.ERROR

    await run_briefly(daemon, body)

    kinds = [event.kind for event in EventLog(events_path()).iter_events()]
    assert EventKind.ERROR in kinds


async def test_a_streamed_turn_is_recorded_with_its_model_and_usage(state: Path) -> None:
    driver = FakeDriver(
        [
            StepResult(
                action=StepAction.STREAMED,
                path=Path("placeholder"),
                model="claude-opus-5",
                provider="anthropic",
                config_name="main",
                usage=Usage(input_tokens=90, output_tokens=12),
                duration_ms=1234.0,
            ),
            StepResult(
                action=StepAction.EXECUTED_TOOL,
                path=Path("placeholder"),
                tool_name="wcgw.BashCommand",
            ),
        ]
    )
    daemon = make_daemon(driver)

    async def body() -> None:
        daemon._schedule(state / "a.chat.md")  # noqa: SLF001
        await asyncio.wait_for(driver.ran.wait(), timeout=TIMEOUT)
        await _wait_until(lambda: daemon.snapshot().turns == 1)

    await run_briefly(daemon, body)

    events = list(EventLog(events_path()).iter_events())
    turn = next(event for event in events if event.kind is EventKind.TURN_END)
    assert turn.model == "claude-opus-5"
    assert turn.output_tokens == 12
    assert turn.duration_ms == 1234.0
    tool = next(event for event in events if event.kind is EventKind.TOOL_CALL)
    assert tool.tool == "wcgw.BashCommand"


async def test_a_file_already_being_driven_is_not_driven_twice_at_once(state: Path) -> None:
    """Two concurrent passes over one document would fight over the same block."""
    started = asyncio.Event()
    release = asyncio.Event()

    class Slow(FakeDriver):
        async def run(
            self, path: str | Path, *, max_rounds: int | None = None
        ) -> list[StepResult]:
            self.seen.append(Path(path))
            started.set()
            await release.wait()
            return []

    driver = Slow()
    daemon = make_daemon(driver)

    async def body() -> None:
        target = state / "a.chat.md"
        daemon._schedule(target)  # noqa: SLF001
        await asyncio.wait_for(started.wait(), timeout=TIMEOUT)
        daemon._schedule(target)  # noqa: SLF001 - arrives while the first is running
        daemon._schedule(target)  # noqa: SLF001
        release.set()
        # The queued edits collapse into exactly one more pass.
        await _wait_until(lambda: len(driver.seen) == 2)

    await run_briefly(daemon, body)


async def test_collected_answers_are_swept_but_recent_ones_are_kept(state: Path) -> None:
    """Otherwise the drop directory grows for the life of the machine."""
    import os
    import time

    directory = commands_dir()
    directory.mkdir(parents=True, exist_ok=True)
    old = directory / "old.done.json"
    fresh = directory / "fresh.done.json"
    write_json_atomic(old, {"ok": True})
    write_json_atomic(fresh, {"ok": True})
    stale = time.time() - 3600
    os.utime(old, (stale, stale))

    assert prune_completed_commands(max_age_seconds=300.0) == 1
    assert not old.exists()
    assert fresh.exists()


# --------------------------------------------------------------------------- #
# Picking up files that already exist
# --------------------------------------------------------------------------- #


def test_find_chat_files_enumerates_what_is_already_there(tmp_path: Path) -> None:
    chats = tmp_path / "chats"
    (chats / "nested").mkdir(parents=True)
    (chats / "a.chat.md").write_text("x", encoding="utf-8")
    (chats / "nested" / "b.chat.md").write_text("x", encoding="utf-8")
    (chats / "notes.md").write_text("x", encoding="utf-8")
    (chats / ".hidden.chat.md").write_text("x", encoding="utf-8")
    (chats / "cmdassets").mkdir()
    (chats / "cmdassets" / "c.chat.md").write_text("x", encoding="utf-8")

    assert find_chat_files([chats]) == {chats / "a.chat.md", chats / "nested" / "b.chat.md"}


async def test_a_file_written_before_the_folder_is_watched_is_still_driven(
    state: Path,
) -> None:
    """The ordinary case for subagent work: write the brief, then register."""
    chats = state / "chats"
    chats.mkdir()
    waiting = chats / "job.chat.md"
    waiting.write_text("# %% user\ndo the thing\n\n# %% assistant\n", encoding="utf-8")
    finished = chats / "done.chat.md"
    finished.write_text("# %% user\nhi\n\n# %% assistant\nhello\n", encoding="utf-8")
    write_registry([str(chats)])

    driver = FakeDriver()
    daemon = make_daemon(driver)

    async def body() -> None:
        await asyncio.wait_for(driver.ran.wait(), timeout=TIMEOUT)
        # Only the one asking for a reply; the finished chat is left alone.
        assert driver.seen == [waiting]

    await run_briefly(daemon, body)


async def test_a_file_waiting_on_a_tool_is_also_picked_up(state: Path) -> None:
    chats = state / "chats"
    chats.mkdir()
    pending = chats / "job.chat.md"
    pending.write_text(
        "# %% user\nhi\n\n# %% assistant\ncalling\n\n# %% tool_execute\n",
        encoding="utf-8",
    )
    write_registry([str(chats)])

    driver = FakeDriver()
    daemon = make_daemon(driver)

    async def body() -> None:
        await asyncio.wait_for(driver.ran.wait(), timeout=TIMEOUT)
        assert driver.seen == [pending]

    await run_briefly(daemon, body)


# --------------------------------------------------------------------------- #
# Symlinked roots
# --------------------------------------------------------------------------- #


def test_a_root_reached_through_a_symlink_is_canonicalised(tmp_path: Path) -> None:
    """macOS reaches its temp directory through /var, a symlink to /private/var."""
    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "link"
    link.symlink_to(real, target_is_directory=True)

    target = resolve_targets([link])[0]
    assert target.root == real.resolve()

    # The watcher reports real paths; a person types the convenient one. Both must
    # match, or every event for the folder is discarded and it looks empty forever.
    assert matches(target, real / "a.chat.md")
    assert matches(target, link / "a.chat.md")


def test_find_chat_files_follows_a_symlinked_root(tmp_path: Path) -> None:
    real = tmp_path / "real"
    real.mkdir()
    (real / "a.chat.md").write_text("x", encoding="utf-8")
    link = tmp_path / "link"
    link.symlink_to(real, target_is_directory=True)

    assert find_chat_files([link]) == {real.resolve() / "a.chat.md"}


async def test_a_file_created_in_a_symlinked_folder_is_driven(state: Path) -> None:
    """The regression: registered through the link, reported through the real path."""
    real = state / "real"
    real.mkdir()
    link = state / "link"
    link.symlink_to(real, target_is_directory=True)
    write_registry([str(link)])

    driver = FakeDriver()
    daemon = make_daemon(driver)

    async def body() -> None:
        await asyncio.sleep(0.4)  # let the watcher settle before touching anything
        (real / "job.chat.md").write_text(
            "# %% user\nhi\n\n# %% assistant\n", encoding="utf-8"
        )
        await asyncio.wait_for(driver.ran.wait(), timeout=TIMEOUT)
        assert driver.seen == [real.resolve() / "job.chat.md"]

    await run_briefly(daemon, body)
