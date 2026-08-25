"""Turning registered paths into a stream of ``.chat.md`` files that changed.

The engine writes into the very files it watches — tokens as they stream, tool
results, asset files beside them — so the filter here matters as much as the
watching does. Anything the engine produces itself is excluded, or the daemon
would chase its own tail.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass
from fnmatch import fnmatch
from pathlib import Path

from watchfiles import awatch

logger = logging.getLogger(__name__)

CHAT_SUFFIX = ".chat.md"
ASSETS_DIR_NAME = "cmdassets"
_GLOB_CHARACTERS = "*?["

DEFAULT_DEBOUNCE_MS = 300


@dataclass(frozen=True)
class WatchTarget:
    """A directory to watch, and an optional pattern narrowing what counts."""

    root: Path
    pattern: str | None = None


def _has_glob(text: str) -> bool:
    return any(character in text for character in _GLOB_CHARACTERS)


def resolve_targets(paths: Sequence[str | Path]) -> list[WatchTarget]:
    """Turn registered paths into directories to watch plus filters.

    A directory is watched whole; a glob is split into its longest literal parent
    and the pattern beneath it; a single chat file watches its directory and
    matches only that name (an editor replacing a file would otherwise be missed,
    since many editors write a new inode rather than modifying the old one).
    """
    targets: list[WatchTarget] = []
    for raw in paths:
        expanded = Path(raw).expanduser()

        if _has_glob(str(expanded)):
            literal: list[str] = []
            parts = expanded.parts
            for part in parts:
                if _has_glob(part):
                    break
                literal.append(part)
            root = Path(*literal) if literal else Path()
            pattern = str(Path(*parts[len(literal) :])) if len(parts) > len(literal) else "*"
            targets.append(WatchTarget(root=root, pattern=pattern))
            continue

        if expanded.name.endswith(CHAT_SUFFIX):
            targets.append(WatchTarget(root=expanded.parent, pattern=expanded.name))
            continue

        targets.append(WatchTarget(root=expanded, pattern=None))
    return targets


def matches(target: WatchTarget, path: Path) -> bool:
    """Whether a changed path is a chat file this target covers."""
    name = path.name
    if not name.endswith(CHAT_SUFFIX):
        return False
    # A hidden sibling is ours: the lock file is `.<name>.lock`, and reacting to
    # our own bookkeeping would loop.
    if name.startswith("."):
        return False
    if ASSETS_DIR_NAME in path.parts:
        return False

    try:
        relative = path.relative_to(target.root)
    except ValueError:
        return False

    if target.pattern is None:
        return True
    return fnmatch(str(relative), target.pattern) or fnmatch(name, target.pattern)


def existing_roots(targets: Sequence[WatchTarget]) -> list[str]:
    """Roots that exist right now.

    A missing directory makes the underlying watcher raise, and one unregistered
    folder must not stop the daemon watching every other one.
    """
    roots: list[str] = []
    for target in targets:
        if target.root.is_dir():
            candidate = str(target.root)
            if candidate not in roots:
                roots.append(candidate)
        else:
            logger.warning("Not watching %s: it is not a directory", target.root)
    return roots


async def watch_chat_files(
    paths: Sequence[str | Path],
    *,
    debounce_ms: int = DEFAULT_DEBOUNCE_MS,
    stop: asyncio.Event | None = None,
) -> AsyncIterator[set[Path]]:
    """Yield sets of chat files that changed, coalesced over the debounce window.

    Never yields an empty set: a batch containing only files we filtered out is
    not a batch worth waking anything for.
    """
    targets = resolve_targets(paths)
    roots = existing_roots(targets)
    if not roots:
        return

    async for changes in awatch(*roots, debounce=debounce_ms, stop_event=stop, recursive=True):
        matched = {
            path
            for path in (Path(raw) for _change, raw in changes)
            if any(matches(target, path) for target in targets)
        }
        if matched:
            yield matched
