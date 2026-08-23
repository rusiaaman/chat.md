"""Cross-process locks for chat files and for the daemon singleton.

Two mechanisms are combined on the same file, because the two sides of chat.md
have different capabilities:

* ``flock`` (``msvcrt.locking`` on Windows) gives kernel-enforced exclusion and,
  crucially, is released by the kernel when the holder dies — including on
  ``SIGKILL``. That is what makes a crashed streamer unable to wedge a file.
  Only the Python side can take it.
* An advisory JSON body carrying pid, host and a heartbeat. The VS Code extension
  is Node without native modules, so it cannot ``flock``; it can create the same
  file with ``O_EXCL`` and refresh the same heartbeat. Both sides therefore see
  each other, and either can reclaim a lock whose owner is provably gone.

The body is camelCase so the TypeScript side can read and write it unchanged.
"""

from __future__ import annotations

import json
import os
import socket
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..errors import LockHeld
from ..fileio import ensure_dir
from ..paths import chat_lock_path, daemon_lock_path

# Branching on sys.platform rather than try/except import keeps the two
# platform-specific locking APIs statically checkable: a type checker narrows each
# branch to the platform where that module actually exists.
if sys.platform == "win32":  # pragma: no cover - exercised on Windows only
    import msvcrt
else:
    import fcntl


DEFAULT_HEARTBEAT_INTERVAL = 5.0
#: A lock whose heartbeat is older than this is reclaimable. Three missed beats,
#: so an ordinary scheduling hiccup never costs a live holder its lock.
DEFAULT_STALE_FACTOR = 3.0
#: Bounded, because losing the create race repeatedly means real contention.
_MAX_ACQUIRE_ATTEMPTS = 3


@dataclass(frozen=True)
class LockInfo:
    """The advisory body of a lock file."""

    owner: str
    pid: int
    host: str
    started_at: float
    heartbeat: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "owner": self.owner,
            "pid": self.pid,
            "host": self.host,
            "startedAt": self.started_at,
            "heartbeat": self.heartbeat,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> LockInfo:
        return cls(
            owner=str(data.get("owner", "unknown")),
            pid=int(data.get("pid", 0)),
            host=str(data.get("host", "")),
            started_at=float(data.get("startedAt", 0.0)),
            heartbeat=float(data.get("heartbeat", 0.0)),
        )


def read_lock_info(path: str | Path) -> LockInfo | None:
    """Read a lock body, or None when it is absent, empty or unparseable.

    An unparseable body is treated as absent rather than fatal: a half-written
    lock file must not be able to block a chat forever.
    """
    try:
        raw = Path(path).read_text(encoding="utf-8")
    except OSError:
        return None
    if not raw.strip():
        return None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    try:
        return LockInfo.from_dict(data)
    except (TypeError, ValueError):
        return None


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        # Owned by another user, so it exists.
        return True
    except OSError:
        return True
    return True


def _lock_fd(fd: int) -> bool:
    """Take an exclusive non-blocking lock on ``fd``. False when already held."""
    if sys.platform == "win32":  # pragma: no cover - exercised on Windows only
        try:
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
        except OSError:
            return False
        return True
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return False
    return True


def _unlock_fd(fd: int) -> None:
    if sys.platform == "win32":  # pragma: no cover - exercised on Windows only
        try:
            msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
        except OSError:
            pass
        return
    try:
        fcntl.flock(fd, fcntl.LOCK_UN)
    except OSError:
        pass


class FileLock:
    """An exclusive lock on one path, with a heartbeat so crashes are detectable.

    Not reentrant, and not shared between threads: one instance owns one lock.
    """

    def __init__(
        self,
        path: str | Path,
        *,
        owner: str = "chatmd-cli",
        heartbeat_interval: float = DEFAULT_HEARTBEAT_INTERVAL,
        stale_after: float | None = None,
    ) -> None:
        self.path = Path(path)
        self.owner = owner
        self.heartbeat_interval = heartbeat_interval
        # Floored at the default interval on purpose. Deriving the window from the
        # configured interval alone means a lock with beating switched off gets a
        # window of zero, and then every live holder — the editor included — reads
        # as dead the instant it is looked at.
        self.stale_after = (
            stale_after
            if stale_after is not None
            else max(heartbeat_interval, DEFAULT_HEARTBEAT_INTERVAL) * DEFAULT_STALE_FACTOR
        )
        self._fd: int | None = None
        self._info: LockInfo | None = None
        self._stop = threading.Event()
        self._beat: threading.Thread | None = None

    # -- state ------------------------------------------------------------- #

    @property
    def held(self) -> bool:
        return self._fd is not None

    @property
    def info(self) -> LockInfo | None:
        """The body written when this lock was acquired."""
        return self._info

    # -- acquire / release ------------------------------------------------- #

    def acquire(self, *, blocking: bool = False, timeout: float = 30.0) -> None:
        """Take the lock, raising :class:`~chatmd.errors.LockHeld` if someone has it.

        With ``blocking`` it retries until ``timeout`` elapses, which is what a
        one-shot CLI run wants; the daemon never blocks, it just tries again on the
        next file event.
        """
        deadline = time.monotonic() + timeout
        while True:
            try:
                self._try_acquire()
                return
            except LockHeld:
                if not blocking or time.monotonic() >= deadline:
                    raise
                time.sleep(min(0.2, self.heartbeat_interval / 4))

    def _try_acquire(self) -> None:
        ensure_dir(self.path.parent)
        for _ in range(_MAX_ACQUIRE_ATTEMPTS):
            # The body is checked before the kernel lock, and it is decisive. A
            # successful flock only proves no *Python* process holds this file;
            # the VS Code extension cannot flock at all, so trusting flock alone
            # would happily steal a lock the editor is actively holding.
            existing = read_lock_info(self.path)
            if existing is not None and not self._is_stale(existing):
                raise LockHeld(str(self.path), owner=existing.owner, pid=existing.pid)

            fd = self._open_for_takeover()
            if fd is None:
                continue

            if not _lock_fd(fd):
                # A live Python holder, whose body we either could not read or had
                # already judged stale. The kernel lock settles it.
                existing = read_lock_info(self.path)
                os.close(fd)
                raise LockHeld(
                    str(self.path),
                    owner=existing.owner if existing else None,
                    pid=existing.pid if existing else None,
                )

            # A release unlinks while still holding the kernel lock, so an fd we
            # opened just before that can end up locking an orphaned inode, which
            # protects nothing. Start over if the path no longer points at us.
            if not self._fd_is_current(fd):
                _unlock_fd(fd)
                os.close(fd)
                continue

            # Re-read under the kernel lock. The extension takes no kernel lock,
            # so it can have written its body between our first check and now.
            existing = read_lock_info(self.path)
            if existing is not None and not self._is_stale(existing):
                _unlock_fd(fd)
                os.close(fd)
                raise LockHeld(str(self.path), owner=existing.owner, pid=existing.pid)

            self._fd = fd
            now = time.time()
            self._info = LockInfo(
                owner=self.owner,
                pid=os.getpid(),
                host=socket.gethostname(),
                started_at=now,
                heartbeat=now,
            )
            self._write_info()
            self._start_heartbeat()
            return

        raise LockHeld(str(self.path))

    def _open_for_takeover(self) -> int | None:
        """Open the lock file for writing, creating it if it is absent.

        Deliberately not ``O_EXCL`` and deliberately no unlink: a stale lock is
        taken over in place. Unlinking here would destroy the inode of a process
        that created the file microseconds ago and has not written its body yet,
        leaving two holders each locking a different inode.
        """
        try:
            return os.open(self.path, os.O_CREAT | os.O_RDWR, 0o644)
        except OSError as error:
            raise LockHeld(str(self.path)) from error

    def _is_stale(self, existing: LockInfo) -> bool:
        """Whether a recorded holder can be presumed gone.

        On this host a dead pid is proof. Otherwise all we have is the heartbeat,
        so a holder that stops beating for three intervals is treated as gone —
        which also covers a wedged editor that will never release.
        """
        if existing.host == socket.gethostname() and not _pid_alive(existing.pid):
            return True
        return (time.time() - existing.heartbeat) > self.stale_after

    def _fd_is_current(self, fd: int) -> bool:
        try:
            on_disk = os.stat(self.path)
        except OSError:
            return False
        opened = os.fstat(fd)
        return (on_disk.st_ino, on_disk.st_dev) == (opened.st_ino, opened.st_dev)

    def release(self) -> None:
        """Release the lock and remove the file. Safe to call when not held."""
        self._stop.set()
        beat, self._beat = self._beat, None
        if beat is not None and beat is not threading.current_thread():
            beat.join(timeout=1.0)

        fd, self._fd = self._fd, None
        self._info = None
        if fd is None:
            return
        # Unlink before unlocking: while we still hold the kernel lock nobody can
        # be mid-acquire on this inode, so no one loses a lock they just took.
        try:
            os.unlink(self.path)
        except OSError:
            pass
        _unlock_fd(fd)
        try:
            os.close(fd)
        except OSError:
            pass

    # -- heartbeat --------------------------------------------------------- #

    def _write_info(self) -> None:
        if self._fd is None or self._info is None:
            return
        payload = json.dumps(self._info.to_dict(), indent=2) + "\n"
        try:
            os.lseek(self._fd, 0, os.SEEK_SET)
            os.truncate(self._fd, 0)
            os.write(self._fd, payload.encode("utf-8"))
            os.fsync(self._fd)
        except OSError:
            # A lock we cannot describe is still a lock we hold; the flock stands.
            pass

    def beat(self) -> None:
        """Refresh the heartbeat so other processes do not judge us dead."""
        if self._info is None:
            return
        self._info = LockInfo(
            owner=self._info.owner,
            pid=self._info.pid,
            host=self._info.host,
            started_at=self._info.started_at,
            heartbeat=time.time(),
        )
        self._write_info()

    def _start_heartbeat(self) -> None:
        if self.heartbeat_interval <= 0:
            return
        self._stop = threading.Event()
        thread = threading.Thread(
            target=self._heartbeat_loop,
            name=f"chatmd-lock-{self.path.name}",
            daemon=True,
        )
        self._beat = thread
        thread.start()

    def _heartbeat_loop(self) -> None:
        while not self._stop.wait(self.heartbeat_interval):
            if self._fd is None:
                return
            self.beat()

    # -- context manager --------------------------------------------------- #

    def __enter__(self) -> FileLock:
        self.acquire()
        return self

    def __exit__(self, *_exc: object) -> None:
        self.release()


def chat_file_lock(chat_file: str | Path, **kwargs: Any) -> FileLock:
    """Lock guarding one ``.chat.md`` document, as a hidden sibling file."""
    return FileLock(chat_lock_path(chat_file), **kwargs)


def daemon_lock(**kwargs: Any) -> FileLock:
    """Lock enforcing a single listener per machine."""
    kwargs.setdefault("owner", "chatmd-daemon")
    return FileLock(daemon_lock_path(), **kwargs)


def lock_holder(chat_file: str | Path) -> LockInfo | None:
    """Who is driving this chat file, if anyone live is.

    Returns None when the lock is absent or its holder is provably gone, so
    callers can report "free" without trying to take it.
    """
    path = chat_lock_path(chat_file)
    existing = read_lock_info(path)
    if existing is None:
        return None
    if existing.host == socket.gethostname() and not _pid_alive(existing.pid):
        return None
    if (time.time() - existing.heartbeat) > (
        DEFAULT_HEARTBEAT_INTERVAL * DEFAULT_STALE_FACTOR
    ):
        return None
    return existing
