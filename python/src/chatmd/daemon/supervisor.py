"""The single system-wide listener.

One process watches every registered folder, holds one shared MCP pool for all of
them, and drives each changed ``.chat.md`` file to completion. Being the only one
matters: two listeners on the same folder would both try to answer the same empty
assistant block, so the daemon lock is taken before anything else happens.

Nothing here talks over a socket. State is published to files and commands are
picked up from a drop directory, which is what lets the CLI work whether or not a
listener happens to be running.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import signal
import socket
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any, Protocol

from .. import __version__
from ..config.loader import load_config
from ..config.model import ChatmdConfig
from ..engine.driver import ChatDriver, StepAction, StepResult
from ..engine.locks import FileLock, daemon_lock
from ..errors import LockHeld
from ..mcp.manager import McpPool
from ..parser.blocks import has_empty_assistant_block, has_empty_tool_execute_block
from ..paths import config_path, registry_path
from ..stats.events import Event, EventKind, EventLog
from ..types import McpServerStatus
from .state import (
    Command,
    CommandName,
    DaemonInfo,
    DaemonStatus,
    FileActivity,
    FileState,
    clear_daemon_info,
    clear_status,
    complete_command,
    pending_commands,
    prune_completed_commands,
    read_registry,
    write_daemon_info,
    write_status,
)
from .watcher import DEFAULT_DEBOUNCE_MS, find_chat_files, watch_chat_files

logger = logging.getLogger(__name__)

#: How often commands and the registry are checked. Polling rather than watching:
#: it is a handful of stats a second, and it cannot miss an edit the way an
#: inotify race can.
POLL_INTERVAL = 0.5
STATUS_INTERVAL = 1.0


class PoolLike(Protocol):
    async def start(self) -> None: ...
    async def aclose(self) -> None: ...
    def status(self) -> list[McpServerStatus]: ...


class DriverLike(Protocol):
    async def run(self, path: str | Path, *, max_rounds: int | None = ...) -> list[StepResult]: ...


PoolFactory = Callable[[ChatmdConfig], PoolLike]
DriverFactory = Callable[[ChatmdConfig, PoolLike], DriverLike]


def _default_pool(config: ChatmdConfig) -> PoolLike:
    return McpPool(config.mcp_servers)


def _default_driver(config: ChatmdConfig, pool: PoolLike) -> DriverLike:
    return ChatDriver(config, pool)  # type: ignore[arg-type]


class Daemon:
    """Watches registered paths and answers whatever the documents ask for."""

    def __init__(
        self,
        config: ChatmdConfig | None = None,
        *,
        pool_factory: PoolFactory = _default_pool,
        driver_factory: DriverFactory = _default_driver,
        lock: FileLock | None = None,
        event_log: EventLog | None = None,
        poll_interval: float = POLL_INTERVAL,
        status_interval: float = STATUS_INTERVAL,
    ) -> None:
        self.config = config or load_config()
        self._pool_factory = pool_factory
        self._driver_factory = driver_factory
        self._lock = lock
        self._events = event_log or EventLog()
        self.poll_interval = poll_interval
        self.status_interval = status_interval

        self._pool: PoolLike | None = None
        self._driver: DriverLike | None = None
        self._stopping = asyncio.Event()
        self._restart_watch = asyncio.Event()
        self._roots: list[str] = []

        self._inflight: set[Path] = set()
        self._dirty: set[Path] = set()
        self._tasks: dict[Path, asyncio.Task[None]] = {}
        self._activity: dict[Path, FileActivity] = {}

        self._turns = 0
        self._tool_calls = 0
        self._errors = 0
        self._started_at = 0.0
        self._registry_stamp: float | None = None
        self._last_prune = 0.0
        self._config_stamp: float | None = None

    # -- lifecycle --------------------------------------------------------- #

    async def run(self) -> int:
        """Run until asked to stop. Returns a process exit code."""
        lock = self._lock or daemon_lock()
        try:
            lock.acquire()
        except LockHeld as held:
            # Deliberately before any state is written: a second listener must not
            # overwrite the running one's daemon.json or eat its commands.
            logger.error("Another listener is already running (%s)", held)
            return 1

        self._started_at = time.time()
        self._install_signal_handlers()

        try:
            self._roots = read_registry()
            self._registry_stamp = self._stamp(registry_path())
            self._config_stamp = self._stamp(config_path())

            self._pool = self._pool_factory(self.config)
            await self._pool.start()
            self._driver = self._driver_factory(self.config, self._pool)

            write_daemon_info(self._info())
            logger.info("Listening on %s", ", ".join(self._roots) or "(nothing registered)")

            tasks = [
                asyncio.create_task(self._watch_loop(), name="chatmd-watch"),
                asyncio.create_task(self._control_loop(), name="chatmd-control"),
                asyncio.create_task(self._status_loop(), name="chatmd-status"),
            ]
            await self._stopping.wait()
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            await self._drain_inflight()
        finally:
            if self._pool is not None:
                with contextlib.suppress(Exception):
                    await self._pool.aclose()
            clear_status()
            clear_daemon_info()
            lock.release()
            logger.info("Listener stopped")
        return 0

    async def stop(self) -> None:
        """Ask the run loop to wind down."""
        self._stopping.set()

    def _install_signal_handlers(self) -> None:
        loop = asyncio.get_running_loop()
        for signal_name in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(signal_name, self._stopping.set)
            except (NotImplementedError, RuntimeError, ValueError):
                # Not every platform or embedding context allows this; the command
                # drop directory still provides a way to shut down.
                logger.debug("Could not install a handler for %s", signal_name)

    def _info(self) -> DaemonInfo:
        return DaemonInfo(
            pid=os.getpid(),
            host=socket.gethostname(),
            started_at=self._started_at,
            version=__version__,
            roots=list(self._roots),
        )

    @staticmethod
    def _stamp(path: Path) -> float | None:
        try:
            return path.stat().st_mtime
        except OSError:
            return None

    # -- watching ---------------------------------------------------------- #

    async def _watch_loop(self) -> None:
        while not self._stopping.is_set():
            self._roots = read_registry()
            if not self._roots:
                await asyncio.sleep(self.poll_interval)
                continue

            self._sweep(self._roots)

            self._restart_watch = asyncio.Event()
            stop_watch = asyncio.Event()
            waiter = asyncio.create_task(self._stop_watch_when_asked(stop_watch))
            try:
                async for batch in watch_chat_files(
                    self._roots,
                    debounce_ms=self.config.daemon.debounce_ms or DEFAULT_DEBOUNCE_MS,
                    stop=stop_watch,
                ):
                    for path in batch:
                        self._schedule(path)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Watcher failed; retrying")
                await asyncio.sleep(self.poll_interval)
            finally:
                waiter.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await waiter

    def _sweep(self, roots: list[str]) -> None:
        """Drive anything already waiting when a folder is first watched.

        Only files that are actually asking for something are scheduled, so
        registering a folder of finished chats costs a read each and nothing more.
        """
        waiting = 0
        for path in sorted(find_chat_files(roots)):
            try:
                text = path.read_text(encoding="utf-8")
            except OSError:
                continue
            if has_empty_assistant_block(text) or has_empty_tool_execute_block(text):
                self._schedule(path)
                waiting += 1
        if waiting:
            logger.info("Picked up %d chat file(s) already waiting", waiting)

    async def _stop_watch_when_asked(self, stop_watch: asyncio.Event) -> None:
        stopping = asyncio.create_task(self._stopping.wait())
        restarting = asyncio.create_task(self._restart_watch.wait())
        try:
            await asyncio.wait(
                {stopping, restarting}, return_when=asyncio.FIRST_COMPLETED
            )
        finally:
            for task in (stopping, restarting):
                task.cancel()
            stop_watch.set()

    def _schedule(self, path: Path) -> None:
        """Drive a file, serialising per path.

        A file already being driven is marked dirty rather than queued twice: the
        driver re-reads the document anyway, so one more pass afterwards covers
        every edit that arrived meanwhile.
        """
        if path in self._inflight:
            self._dirty.add(path)
            return
        self._inflight.add(path)
        self._tasks[path] = asyncio.create_task(self._drive(path), name=f"chatmd:{path.name}")

    async def _drive(self, path: Path) -> None:
        try:
            self._activity[path] = FileActivity(
                path=str(path), state=FileState.STREAMING, since=time.time()
            )
            assert self._driver is not None
            for result in await self._driver.run(path):
                self._record(result)
        except asyncio.CancelledError:
            self._activity.pop(path, None)
            raise
        except Exception as error:  # noqa: BLE001 - one bad file must not stop the rest
            logger.exception("Failed while driving %s", path)
            self._errors += 1
            self._events.append(
                Event(kind=EventKind.ERROR, path=str(path), message=str(error))
            )
            self._activity[path] = FileActivity(
                path=str(path), state=FileState.ERROR, since=time.time(), message=str(error)
            )
        else:
            self._activity.pop(path, None)
        finally:
            self._inflight.discard(path)
            self._tasks.pop(path, None)
            if path in self._dirty:
                self._dirty.discard(path)
                self._schedule(path)

    def _record(self, result: StepResult) -> None:
        """Turn one action into counters, an event, and a visible state."""
        path = str(result.path)
        if result.action is StepAction.STREAMED:
            self._turns += 1
            self._events.append(
                Event.turn_end(
                    path,
                    model=result.model,
                    provider=result.provider,
                    config=result.config_name,
                    outcome=str(result.outcome) if result.outcome else "unknown",
                    usage=result.usage,
                    duration_ms=result.duration_ms,
                )
            )
        elif result.action is StepAction.EXECUTED_TOOL:
            self._tool_calls += 1
            self._events.append(
                Event(kind=EventKind.TOOL_CALL, path=path, tool=result.tool_name)
            )
            self._activity[result.path] = FileActivity(
                path=path,
                state=FileState.EXECUTING,
                since=time.time(),
                tool=result.tool_name,
            )
        elif result.action is StepAction.LOCKED:
            self._activity[result.path] = FileActivity(
                path=path, state=FileState.LOCKED, since=time.time(), message=result.message
            )
        elif result.action is StepAction.ERROR:
            self._errors += 1
            self._events.append(
                Event(kind=EventKind.ERROR, path=path, message=result.message)
            )

    async def _drain_inflight(self) -> None:
        """Let files already being driven finish rather than cutting them off."""
        tasks = list(self._tasks.values())
        if not tasks:
            return
        logger.info("Waiting for %d file(s) to finish", len(tasks))
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(asyncio.gather(*tasks, return_exceptions=True), timeout=30.0)

    # -- control ----------------------------------------------------------- #

    async def _control_loop(self) -> None:
        while not self._stopping.is_set():
            try:
                await self._drain_commands()
                self._check_registry()
                await self._check_config()
                self._prune_answers()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Control loop error; continuing")
            await asyncio.sleep(self.poll_interval)

    def _prune_answers(self) -> None:
        """Sweep collected command answers, occasionally rather than every pass."""
        now = time.time()
        if now - self._last_prune < 60.0:
            return
        self._last_prune = now
        prune_completed_commands()

    async def _drain_commands(self) -> None:
        for request, command in pending_commands():
            logger.info("Command: %s", command.name)
            try:
                result = await self._handle(command)
            except Exception as error:  # noqa: BLE001 - always answer, even on failure
                logger.exception("Command %s failed", command.name)
                complete_command(request, {"ok": False, "error": str(error)})
                continue
            complete_command(request, result)

    async def _handle(self, command: Command) -> dict[str, Any]:
        if command.name is CommandName.SHUTDOWN:
            self._stopping.set()
            return {"stopping": True}

        if command.name is CommandName.RELOAD_CONFIG:
            await self._reload_config()
            self._check_registry()
            return {"reloaded": True, "watching": list(self._roots)}

        if command.name is CommandName.ADD_PATH:
            target = command.payload.get("path")
            if target:
                from .state import add_registry_path

                add_registry_path(str(target))
            self._check_registry()
            return {"watching": list(self._roots)}

        if command.name is CommandName.REMOVE_PATH:
            target = command.payload.get("path")
            if target:
                from .state import remove_registry_path

                remove_registry_path(str(target))
            self._check_registry()
            return {"watching": list(self._roots)}

        if command.name is CommandName.STOP_FILE:
            target = command.payload.get("path")
            if not target:
                return {"ok": False, "error": "no path given"}
            path = Path(str(target)).expanduser()
            task = self._tasks.get(path)
            if task is None:
                return {"stopped": False, "reason": "not running"}
            task.cancel()
            return {"stopped": True}

        if command.name is CommandName.MCP_REFRESH:
            await self._restart_pool()
            return {"servers": [status.server_id for status in self._server_status()]}

        return {"ok": False, "error": f"unhandled command {command.name}"}

    def _check_registry(self) -> None:
        """Restart the watcher when the registered paths changed."""
        stamp = self._stamp(registry_path())
        current = read_registry()
        if stamp == self._registry_stamp and current == self._roots:
            return
        self._registry_stamp = stamp
        if current != self._roots:
            logger.info("Watch paths changed: %s", ", ".join(current) or "(none)")
            self._roots = current
            write_daemon_info(self._info())
            self._restart_watch.set()

    async def _check_config(self) -> None:
        stamp = self._stamp(config_path())
        if stamp == self._config_stamp:
            return
        self._config_stamp = stamp
        logger.info("Configuration changed on disk, reloading")
        await self._reload_config()

    async def _reload_config(self) -> None:
        try:
            updated = load_config()
        except Exception:  # noqa: BLE001 - a broken edit must not kill the listener
            logger.exception("Could not reload the configuration; keeping the old one")
            return

        servers_changed = updated.mcp_servers != self.config.mcp_servers
        self.config = updated
        if servers_changed:
            # Only when the servers actually changed: restarting the pool respawns
            # every stdio child, which is far too expensive to do on any edit.
            logger.info("MCP servers changed, restarting the pool")
            await self._restart_pool()
        elif self._pool is not None:
            self._driver = self._driver_factory(self.config, self._pool)

    async def _restart_pool(self) -> None:
        if self._pool is not None:
            with contextlib.suppress(Exception):
                await self._pool.aclose()
        self._pool = self._pool_factory(self.config)
        await self._pool.start()
        self._driver = self._driver_factory(self.config, self._pool)

    # -- status ------------------------------------------------------------ #

    def _server_status(self) -> list[McpServerStatus]:
        if self._pool is None:
            return []
        try:
            return self._pool.status()
        except Exception:  # noqa: BLE001 - status must never break the loop
            logger.exception("Could not read MCP status")
            return []

    def snapshot(self) -> DaemonStatus:
        return DaemonStatus(
            at=time.time(),
            daemon=self._info(),
            watching=list(self._roots),
            files=list(self._activity.values()),
            mcp=self._server_status(),
            turns=self._turns,
            tool_calls=self._tool_calls,
            errors=self._errors,
        )

    async def _status_loop(self) -> None:
        while not self._stopping.is_set():
            try:
                write_status(self.snapshot())
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Could not publish status")
            await asyncio.sleep(self.status_interval)
