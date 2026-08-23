"""Tests for the chat-file lock, including its interlock with the VS Code side."""

from __future__ import annotations

import json
import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

from chatmd.engine.locks import (
    FileLock,
    LockInfo,
    chat_file_lock,
    lock_holder,
    read_lock_info,
)
from chatmd.errors import LockHeld
from chatmd.paths import chat_lock_path

HAVE_FCNTL = sys.platform != "win32"


def write_body(path: Path, **overrides: object) -> None:
    """Plant a lock body the way another process (or the extension) would."""
    now = time.time()
    body = {
        "owner": "vscode",
        "pid": os.getpid(),
        "host": socket.gethostname(),
        "startedAt": now,
        "heartbeat": now,
    }
    body.update(overrides)
    path.write_text(json.dumps(body, indent=2) + "\n", encoding="utf-8")




def _reaped_pid() -> int:
    proc = subprocess.Popen([sys.executable, "-c", "pass"])
    proc.wait()
    return proc.pid


# --------------------------------------------------------------------------- #
# Basics
# --------------------------------------------------------------------------- #


def test_acquire_writes_body_and_release_removes_file(tmp_path: Path) -> None:
    lock = FileLock(tmp_path / "x.lock", heartbeat_interval=0)
    lock.acquire()
    assert lock.held
    info = read_lock_info(tmp_path / "x.lock")
    assert info is not None
    assert info.pid == os.getpid()
    assert info.owner == "chatmd-cli"

    lock.release()
    assert not lock.held
    assert not (tmp_path / "x.lock").exists()


def test_context_manager_releases(tmp_path: Path) -> None:
    path = tmp_path / "x.lock"
    with FileLock(path, heartbeat_interval=0):
        assert path.exists()
    assert not path.exists()


def test_release_is_safe_when_not_held(tmp_path: Path) -> None:
    FileLock(tmp_path / "x.lock").release()


def test_second_lock_on_same_path_is_refused(tmp_path: Path) -> None:
    path = tmp_path / "x.lock"
    first = FileLock(path, heartbeat_interval=0)
    first.acquire()
    try:
        with pytest.raises(LockHeld):
            FileLock(path, heartbeat_interval=0).acquire()
    finally:
        first.release()


def test_lock_is_free_again_after_release(tmp_path: Path) -> None:
    path = tmp_path / "x.lock"
    FileLock(path, heartbeat_interval=0).__enter__().release()
    second = FileLock(path, heartbeat_interval=0)
    second.acquire()
    second.release()


def test_chat_file_lock_is_a_hidden_sibling(tmp_path: Path) -> None:
    chat = tmp_path / "notes.chat.md"
    chat.write_text("# %% user\nhi\n", encoding="utf-8")
    lock = chat_file_lock(chat, heartbeat_interval=0)
    lock.acquire()
    try:
        assert chat_lock_path(chat) == tmp_path / ".notes.chat.md.lock"
        assert chat_lock_path(chat).exists()
    finally:
        lock.release()


# --------------------------------------------------------------------------- #
# Reclaiming dead holders
# --------------------------------------------------------------------------- #


def test_dead_pid_on_this_host_is_reclaimed(tmp_path: Path) -> None:
    path = tmp_path / "x.lock"
    write_body(path, pid=_reaped_pid())
    lock = FileLock(path, heartbeat_interval=0)
    lock.acquire()
    try:
        assert lock.info is not None and lock.info.pid == os.getpid()
    finally:
        lock.release()


def test_stale_heartbeat_from_another_host_is_reclaimed(tmp_path: Path) -> None:
    path = tmp_path / "x.lock"
    write_body(path, host="some-other-machine", heartbeat=time.time() - 3600)
    lock = FileLock(path, heartbeat_interval=0)
    lock.acquire()
    try:
        assert lock.held
    finally:
        lock.release()


def test_unparseable_body_is_reclaimed(tmp_path: Path) -> None:
    path = tmp_path / "x.lock"
    path.write_text("{ this is not json", encoding="utf-8")
    lock = FileLock(path, heartbeat_interval=0)
    lock.acquire()
    try:
        assert lock.held
    finally:
        lock.release()


def test_empty_body_is_reclaimed(tmp_path: Path) -> None:
    path = tmp_path / "x.lock"
    path.write_text("", encoding="utf-8")
    lock = FileLock(path, heartbeat_interval=0)
    lock.acquire()
    try:
        assert lock.held
    finally:
        lock.release()


# --------------------------------------------------------------------------- #
# Interlock with the extension, which cannot take a kernel lock
# --------------------------------------------------------------------------- #


def test_live_editor_body_blocks_even_without_a_kernel_lock(tmp_path: Path) -> None:
    """The whole point of the advisory body: no flock is held here, yet we must wait."""
    path = tmp_path / "x.lock"
    write_body(path, owner="vscode")  # our own pid, so provably alive

    with pytest.raises(LockHeld) as excinfo:
        FileLock(path, heartbeat_interval=0).acquire()
    assert "vscode" in str(excinfo.value)


def test_editor_body_with_fresh_heartbeat_from_another_host_blocks(tmp_path: Path) -> None:
    path = tmp_path / "x.lock"
    write_body(path, owner="vscode", host="some-other-machine")
    with pytest.raises(LockHeld):
        FileLock(path, heartbeat_interval=0).acquire()


def test_blocking_acquire_gives_up_at_the_timeout(tmp_path: Path) -> None:
    path = tmp_path / "x.lock"
    write_body(path, owner="vscode")
    started = time.monotonic()
    with pytest.raises(LockHeld):
        FileLock(path, heartbeat_interval=0.4).acquire(blocking=True, timeout=0.3)
    assert time.monotonic() - started >= 0.3


# --------------------------------------------------------------------------- #
# Heartbeat
# --------------------------------------------------------------------------- #


def test_beat_advances_the_recorded_heartbeat(tmp_path: Path) -> None:
    path = tmp_path / "x.lock"
    lock = FileLock(path, heartbeat_interval=0)
    lock.acquire()
    try:
        first = read_lock_info(path)
        assert first is not None
        time.sleep(0.02)
        lock.beat()
        second = read_lock_info(path)
        assert second is not None
        assert second.heartbeat > first.heartbeat
        assert second.started_at == first.started_at
    finally:
        lock.release()


def test_heartbeat_thread_keeps_the_lock_fresh(tmp_path: Path) -> None:
    path = tmp_path / "x.lock"
    lock = FileLock(path, heartbeat_interval=0.05)
    lock.acquire()
    try:
        first = read_lock_info(path)
        assert first is not None
        time.sleep(0.25)
        second = read_lock_info(path)
        assert second is not None
        assert second.heartbeat > first.heartbeat
    finally:
        lock.release()


def test_lock_holder_ignores_a_dead_holder(tmp_path: Path) -> None:
    chat = tmp_path / "a.chat.md"
    write_body(chat_lock_path(chat), pid=_reaped_pid())
    assert lock_holder(chat) is None


def test_lock_holder_reports_a_live_holder(tmp_path: Path) -> None:
    chat = tmp_path / "a.chat.md"
    write_body(chat_lock_path(chat), owner="vscode")
    holder = lock_holder(chat)
    assert holder is not None and holder.owner == "vscode"


def test_lock_info_round_trips_camel_case() -> None:
    info = LockInfo(owner="vscode", pid=7, host="h", started_at=1.5, heartbeat=2.5)
    assert info.to_dict()["startedAt"] == 1.5
    assert LockInfo.from_dict(info.to_dict()) == info


# --------------------------------------------------------------------------- #
# Cross-process guarantees
# --------------------------------------------------------------------------- #

_HOLD_SCRIPT = """
import sys, time
from chatmd.engine.locks import FileLock
lock = FileLock(sys.argv[1], heartbeat_interval=0.2)
lock.acquire()
print("locked", flush=True)
time.sleep(60)
"""

_FLOCK_ONLY_SCRIPT = """
import fcntl, os, sys, time
fd = os.open(sys.argv[1], os.O_CREAT | os.O_RDWR, 0o644)
fcntl.flock(fd, fcntl.LOCK_EX)
print("locked", flush=True)
time.sleep(60)
"""


def _spawn(script: str, path: Path) -> subprocess.Popen[str]:
    proc = subprocess.Popen(
        [sys.executable, "-c", script, str(path)],
        stdout=subprocess.PIPE,
        text=True,
    )
    assert proc.stdout is not None
    assert proc.stdout.readline().strip() == "locked"
    return proc


@pytest.mark.skipif(not HAVE_FCNTL, reason="POSIX advisory locking only")
def test_another_process_holding_the_lock_blocks_us(tmp_path: Path) -> None:
    path = tmp_path / "x.lock"
    proc = _spawn(_HOLD_SCRIPT, path)
    try:
        with pytest.raises(LockHeld):
            FileLock(path, heartbeat_interval=0).acquire()
    finally:
        proc.kill()
        proc.wait()


@pytest.mark.skipif(not HAVE_FCNTL, reason="POSIX advisory locking only")
def test_kernel_lock_alone_blocks_us_when_the_body_says_free(tmp_path: Path) -> None:
    """A racing creator that has not written its body yet is still protected."""
    path = tmp_path / "x.lock"
    proc = _spawn(_FLOCK_ONLY_SCRIPT, path)
    try:
        assert read_lock_info(path) is None  # body genuinely empty
        with pytest.raises(LockHeld):
            FileLock(path, heartbeat_interval=0).acquire()
    finally:
        proc.kill()
        proc.wait()


@pytest.mark.skipif(not HAVE_FCNTL, reason="POSIX advisory locking only")
def test_lock_survives_nothing_when_the_holder_is_killed(tmp_path: Path) -> None:
    """SIGKILL must not leave a chat file permanently wedged."""
    path = tmp_path / "x.lock"
    proc = _spawn(_HOLD_SCRIPT, path)
    with pytest.raises(LockHeld):
        FileLock(path, heartbeat_interval=0).acquire()

    proc.send_signal(signal.SIGKILL)
    proc.wait()

    lock = FileLock(path, heartbeat_interval=0)
    lock.acquire()  # the dead pid in the body makes this immediate
    try:
        assert lock.held
    finally:
        lock.release()
