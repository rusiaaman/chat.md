"""Turns the registered watch paths into a debounced stream of changed chat files.

The daemon watches a mix of directories, single files and globs, registered by
the CLI in ``paths.json``. This module resolves that list into concrete
``watchfiles.awatch`` roots plus a filter, and coalesces bursts of filesystem
events -- an editor can emit several write events for one keystroke -- into one
set of paths per debounce window, so the supervisor drives each file once per
burst instead of once per event.
"""

from __future__ import annotations

import asyncio
import fnmatch
import logging
from collections.abc import AsyncIterator, Sequence
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import watchfiles

logger = logging.getLogger(__name__)

#: Glob metacharacters that mark a registered path as a pattern rather than a
#: plain directory or file.
_GLOB_CHARS = frozenset("*?[")

#: Directory component that holds engine-written assets -- reacting to writes
#: there would make the daemon watch its own output and spin.
_IGNORED_DIR_NAME = "cmdassets"


@dataclass(frozen=True)
class WatchTarget:
    """One root to watch, plus an optional filter on what under it matches."""

    root: Path  # a directory to hand to awatch
    pattern: str | None  # fnmatch pattern to filter by, None means "any .chat.md"


def _has_glob_chars(text: str) -> bool:
    return any(char in text for char in _GLOB_CHARS)


def _split_glob(path: Path) -> WatchTarget:
    """Split a glob path into its longest literal parent directory and a pattern.

    Walks path components left to right; everything before the first component
    containing a glob metacharacter is the literal root, and that component plus
    everything after it becomes the fnmatch pattern (joined back with ``/`` so a
    pattern spanning several components, e.g. ``**/*.chat.md``, still works).
    """
    literal: list[str] = []
    pattern: list[str] = []
    for part in path.parts:
        if not pattern and not _has_glob_chars(part):
            literal.append(part)
        else:
            pattern.append(part)
    root = Path(*literal) if literal else Path(path.anchor or ".")
    return WatchTarget(root=root, pattern="/".join(pattern) if pattern else "*")


def resolve_targets(paths: Sequence[str]) -> list[WatchTarget]:
    """Turn registered paths (dirs, globs, single files, ``~``) into watch targets.

    Deliberately string-based rather than stat-ing the filesystem: a folder that
    does not exist yet (registered ahead of its first file) must still resolve to
    something watchable, so "is this a directory" is decided by whether it looks
    like a ``.chat.md`` file, not by whether it currently exists.
    """
    targets: list[WatchTarget] = []
    for raw in paths:
        expanded = Path(raw).expanduser()
        text = str(expanded)
        if _has_glob_chars(text):
            targets.append(_split_glob(expanded))
        elif text.endswith(".chat.md"):
            targets.append(WatchTarget(root=expanded.parent, pattern=expanded.name))
        else:
            targets.append(WatchTarget(root=expanded, pattern=None))
    return targets


def _is_ignored(path: Path) -> bool:
    """Paths the engine writes itself, which must never re-trigger the engine."""
    if _IGNORED_DIR_NAME in path.parts:
        return True
    if path.name.endswith(".lock"):
        return True
    return path.name.startswith(".")


def matches(target: WatchTarget, path: Path) -> bool:
    """Whether a changed path is a ``.chat.md`` file this target cares about."""
    if not path.name.endswith(".chat.md"):
        return False
    if _is_ignored(path):
        return False
    try:
        relative = path.relative_to(target.root)
    except ValueError:
        return False
    if target.pattern is None:
        return True
    return fnmatch.fnmatch(relative.as_posix(), target.pattern)


async def watch_chat_files(
    paths: Sequence[str], *, debounce_ms: int = 300, stop: asyncio.Event | None = None
) -> AsyncIterator[set[Path]]:
    """Yield sets of changed ``.chat.md`` paths, debounced per burst.

    A background task pumps raw ``watchfiles`` batches into a queue; the
    consumer loop here accumulates paths and flushes them once ``debounce_ms``
    passes with no further activity. Reading via the queue (rather than calling
    ``__anext__`` under a timeout directly) matters: cancelling a timed-out
    ``__anext__`` would throw into the underlying async generator and could tear
    it down, whereas cancelling a ``Queue.get`` only abandons our own wait.
    """
    targets = resolve_targets(paths)
    if not targets:
        return

    roots = [str(target.root) for target in targets]

    def watch_filter(change: Any, changed_path: str) -> bool:
        candidate = Path(changed_path)
        return any(matches(target, candidate) for target in targets)

    stop_event = stop if stop is not None else asyncio.Event()
    queue: asyncio.Queue[set[tuple[Any, str]] | None] = asyncio.Queue()

    async def pump() -> None:
        try:
            async for batch in watchfiles.awatch(
                *roots, watch_filter=watch_filter, stop_event=stop_event
            ):
                await queue.put(batch)
        finally:
            # Sentinel: tells the consumer the source is done, flushing whatever
            # is still pending instead of leaving it stranded forever.
            await queue.put(None)

    pump_task = asyncio.create_task(pump())
    try:
        pending: set[Path] = set()
        window = debounce_ms / 1000.0
        while True:
            timeout = window if pending else None
            try:
                batch = await asyncio.wait_for(queue.get(), timeout=timeout)
            except TimeoutError:
                if pending:
                    yield pending
                    pending = set()
                continue
            if batch is None:
                break
            for _, changed_path in batch:
                pending.add(Path(changed_path))
        if pending:
            yield pending
    finally:
        pump_task.cancel()
        with suppress(asyncio.CancelledError):
            await pump_task
