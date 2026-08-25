"""Finding the ``chatmd`` command line, when we can be certain of it.

The system prompt tells the model how to hand work to subagents, and that section
is only included when there is a command it can actually run. A wrong path there
is worse than no section at all: the model would try, fail, and have no way to
tell whether the feature exists.

So this returns something only when the answer is certain — an executable found on
PATH, or this very interpreter, which is by definition able to run the package it
is already running.
"""

from __future__ import annotations

import functools
import shutil
import sys
from pathlib import Path

EXECUTABLE_NAME = "chatmd"


def _quote(path: str) -> str:
    """Quote a path for a shell only when it needs it."""
    return f'"{path}"' if " " in path else path


@functools.lru_cache(maxsize=1)
def find_chatmd_command() -> str | None:
    """The command that runs this CLI, or None when it cannot be established.

    Prefers a real executable on PATH, since that is what a person would type.
    Falls back to ``<interpreter> -m chatmd``: this process is running the package,
    so that form is guaranteed to work even when no console script was installed.
    """
    found = shutil.which(EXECUTABLE_NAME)
    if found:
        return _quote(found)

    interpreter = sys.executable
    if interpreter and Path(interpreter).exists():
        return f"{_quote(interpreter)} -m {EXECUTABLE_NAME}"

    return None
