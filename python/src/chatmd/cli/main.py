"""The ``chatmd`` command line.

Two ways to drive a chat file: ``chatmd run`` handles one file in the foreground,
and ``chatmd serve`` runs the single system-wide listener that watches registered
folders. Everything else inspects state the listener publishes.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import typer
from rich.console import Console
from rich.live import Live
from rich.syntax import Syntax

from .. import __version__
from ..config.loader import config_exists, load_config, save_config
from ..config.model import ChatmdConfig
from ..daemon.state import (
    CommandName,
    DaemonStatus,
    add_registry_path,
    read_daemon_info,
    read_registry,
    read_status,
    remove_registry_path,
    send_command,
)
from ..engine.locks import pid_alive
from ..errors import ChatmdError
from ..paths import config_path, daemon_log_path, state_dir
from ..render import block_marker_prefix
from ..stats import views
from ..stats.store import StatsStore, since_timestamp
from ..types import McpServerStatus

app = typer.Typer(
    no_args_is_help=True,
    add_completion=False,
    help="Chat with an LLM inside .chat.md files.",
)
mcp_app = typer.Typer(no_args_is_help=True, help="Inspect the shared MCP server pool.")
config_app = typer.Typer(no_args_is_help=True, help="Inspect and edit configuration.")
app.add_typer(mcp_app, name="mcp")
app.add_typer(config_app, name="config")

console = Console()
# Soft wrap on stderr: errors quote paths and commands, and rich's hard wrapping
# breaks them mid-token, which makes them impossible to copy or grep for.
error_console = Console(stderr=True, soft_wrap=True)


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def _fail(message: str, code: int = 1) -> None:
    error_console.print(f"[red]{message}[/red]")
    raise typer.Exit(code)


def _require_config() -> ChatmdConfig:
    if not config_exists():
        _fail(f"No configuration at {config_path()}. Run `chatmd setup` first.")
    try:
        return load_config()
    except ChatmdError as error:
        _fail(str(error))
        raise  # unreachable; keeps the type checker happy


def _live_daemon() -> tuple[DaemonStatus | None, bool]:
    """The published status, and whether the daemon that wrote it is still alive.

    A snapshot left behind by a killed daemon would otherwise be reported as a
    running listener.
    """
    status = read_status()
    info = read_daemon_info()
    alive = bool(info and pid_alive(info.pid))
    if not alive:
        return status, False
    return status, True


def _print_json(payload: Any) -> None:
    console.print_json(json.dumps(payload, default=str))


def _mcp_payload(servers: list[McpServerStatus]) -> list[dict[str, Any]]:
    return [
        {
            "serverId": server.server_id,
            "state": server.state,
            "tools": server.tool_count,
            "prompts": server.prompt_count,
            "resources": server.resource_count,
            "connectedSince": server.connected_since,
            "lastError": server.last_error,
        }
        for server in servers
    ]


# --------------------------------------------------------------------------- #
# Setup and configuration
# --------------------------------------------------------------------------- #


@app.command()
def setup(
    force: bool = typer.Option(False, "--force", help="Overwrite an existing config."),
) -> None:
    """Find editor settings on this machine and import them."""
    from .setup import run_setup

    run_setup(console, force=force)


@config_app.command("show")
def config_show(
    reveal: bool = typer.Option(False, "--reveal", help="Show API keys in full."),
) -> None:
    """Print the configuration as JSON."""
    config = _require_config()
    payload = config.to_dict()
    if not reveal:
        # Redacted by default: this output ends up in bug reports and terminal
        # scrollback far more often than anyone intends.
        for entry in payload.get("apiConfigs", {}).values():
            if entry.get("apiKey"):
                entry["apiKey"] = "***"
    console.print(Syntax(json.dumps(payload, indent=2), "json", background_color="default"))
    console.print(f"[dim]{config_path()}[/dim]")


@config_app.command("path")
def config_path_command() -> None:
    """Print where the configuration lives."""
    console.print(str(config_path()))


@config_app.command("select")
def config_select(name: str = typer.Argument(..., help="Name of an API configuration.")) -> None:
    """Choose the default API configuration."""
    config = _require_config()
    if name not in config.api_configs:
        available = ", ".join(sorted(config.api_configs)) or "none"
        _fail(f"No configuration named {name!r}. Available: {available}")
    config.selected_config = name
    save_config(config)
    console.print(f"[green]Default configuration is now {name}.[/green]")
    _reload_running_daemon()


def _reload_running_daemon() -> None:
    _, alive = _live_daemon()
    if alive:
        send_command(CommandName.RELOAD_CONFIG)
        console.print("[dim]Told the running listener to reload.[/dim]")


# --------------------------------------------------------------------------- #
# The listener
# --------------------------------------------------------------------------- #


@app.command()
def serve(
    background: bool = typer.Option(
        False, "--background", "-b", help="Detach and keep running after this shell exits."
    ),
) -> None:
    """Run the listener that watches registered folders for .chat.md changes."""
    _require_config()

    if background:
        log = daemon_log_path()
        log.parent.mkdir(parents=True, exist_ok=True)
        with open(log, "ab") as stream:
            process = subprocess.Popen(
                [sys.executable, "-m", "chatmd", "serve"],
                stdout=stream,
                stderr=stream,
                stdin=subprocess.DEVNULL,
                start_new_session=True,
            )
        console.print(f"[green]Listener started[/green] (pid {process.pid}), logging to {log}")
        return

    from ..daemon.supervisor import Daemon

    config = _require_config()
    raise typer.Exit(asyncio.run(Daemon(config).run()))


@app.command()
def stop() -> None:
    """Ask the running listener to shut down."""
    info = read_daemon_info()
    if not info or not pid_alive(info.pid):
        console.print("[yellow]No listener is running.[/yellow]")
        return

    send_command(CommandName.SHUTDOWN)
    console.print(f"Asked the listener (pid {info.pid}) to stop…")
    for _ in range(50):
        time.sleep(0.1)
        current = read_daemon_info()
        if current is None or not pid_alive(current.pid):
            console.print("[green]Stopped.[/green]")
            return
    console.print(
        f"[yellow]Still running after 5s. Kill it with `kill {info.pid}` if it is wedged."
        "[/yellow]"
    )


@app.command()
def watch(
    paths: list[Path] = typer.Argument(..., help="Folders, globs or .chat.md files."),
    start: bool = typer.Option(
        True, "--start/--no-start", help="Start the listener if it is not running."
    ),
) -> None:
    """Register paths with the listener."""
    _require_config()
    for path in paths:
        add_registry_path(path)
        console.print(f"[green]Watching[/green] {Path(path).expanduser()}")

    _, alive = _live_daemon()
    if alive:
        send_command(CommandName.RELOAD_CONFIG)
        console.print("[dim]The running listener picked up the change.[/dim]")
    elif start:
        serve(background=True)
    else:
        console.print("[dim]No listener running. Start one with `chatmd serve`.[/dim]")


@app.command()
def unwatch(paths: list[Path] = typer.Argument(..., help="Paths to stop watching.")) -> None:
    """Remove paths from the listener's registry."""
    for path in paths:
        remove_registry_path(path)
        console.print(f"Stopped watching {Path(path).expanduser()}")
    _reload_running_daemon()


@app.command()
def status(as_json: bool = typer.Option(False, "--json", help="Machine-readable output.")) -> None:
    """Show what the listener is doing."""
    snapshot, alive = _live_daemon()

    if as_json:
        _print_json(
            {
                "running": alive,
                "stateDir": str(state_dir()),
                "watching": read_registry(),
                "status": snapshot.to_dict() if snapshot else None,
            }
        )
        return

    if not alive:
        if snapshot is not None:
            console.print("[yellow]The last listener exited without cleaning up.[/yellow]")
        console.print(views.daemon_header(None))
        registered = read_registry()
        if registered:
            console.print("Registered paths:")
            for path in registered:
                console.print(f"  {path}")
        return

    console.print(views.status_renderable(snapshot))


@app.command()
def live(
    interval: float = typer.Option(1.0, "--interval", help="Seconds between refreshes."),
) -> None:
    """Watch the listener work, refreshing in place."""
    config = _require_config()
    store = StatsStore(pricing=config.pricing)
    try:
        with Live(console=console, screen=False, auto_refresh=False) as display:
            while True:
                snapshot, alive = _live_daemon()
                store.sync()
                display.update(
                    views.live_renderable(snapshot if alive else None, store.totals()),
                    refresh=True,
                )
                time.sleep(interval)
    except KeyboardInterrupt:
        console.print("[dim]Stopped watching.[/dim]")
    finally:
        store.close()


# --------------------------------------------------------------------------- #
# Statistics
# --------------------------------------------------------------------------- #


@app.command()
def stats(
    since: str = typer.Option("7d", "--since", help="Time span, e.g. 30m, 24h, 7d, 4w, all."),
    by: str = typer.Option(
        "model", "--by", help="Group by model, provider, config, file or outcome."
    ),
    bucket: str | None = typer.Option(
        None, "--timeline", help="Also show a timeline by hour, day or month."
    ),
    as_json: bool = typer.Option(False, "--json", help="Machine-readable output."),
) -> None:
    """Token, cost and timing totals."""
    config = _require_config()
    try:
        cutoff = since_timestamp(since)
    except ValueError as error:
        _fail(str(error))
        return

    store = StatsStore(pricing=config.pricing)
    try:
        store.sync()
        try:
            rows = store.summary(since=cutoff, group_by=by)
            timeline = store.timeline(since=cutoff, bucket=bucket) if bucket else []
        except ValueError as error:
            _fail(str(error))
            return

        totals = store.totals(since=cutoff)
        tools = store.top_tools(since=cutoff)

        if as_json:
            _print_json(
                {
                    "since": cutoff,
                    "groupBy": by,
                    "groups": [row.__dict__ for row in rows],
                    "timeline": [row.__dict__ for row in timeline],
                    "tools": [{"tool": name, "calls": count} for name, count in tools],
                    "totals": totals.__dict__,
                }
            )
            return

        console.print(views.summary_table(rows, group_by=by))
        if bucket:
            console.print(views.timeline_table(timeline, bucket=bucket))
        console.print(views.tools_table(tools))
        console.print(views.totals_panel(totals))
        if totals.cost is None and totals.turns:
            console.print(
                "[dim]No cost shown: add per-model prices under `pricing` in "
                f"{config_path()} to see one.[/dim]"
            )
    finally:
        store.close()


# --------------------------------------------------------------------------- #
# MCP
# --------------------------------------------------------------------------- #


@mcp_app.command("status")
def mcp_status(
    as_json: bool = typer.Option(False, "--json", help="Machine-readable output."),
) -> None:
    """Show the MCP servers and whether they are connected."""
    config = _require_config()
    snapshot, alive = _live_daemon()

    if alive and snapshot is not None:
        servers = snapshot.mcp
        source = "listener"
    else:
        # No listener, so nothing holds a pool. Probe once so the command still
        # answers the question rather than reporting an empty list.
        servers = asyncio.run(_probe_mcp(config))
        source = "probe"

    if as_json:
        _print_json({"source": source, "servers": _mcp_payload(servers)})
        return

    console.print(views.mcp_table(servers))
    if source == "probe":
        console.print("[dim]Probed directly; no listener is running.[/dim]")


async def _probe_mcp(config: ChatmdConfig) -> list[McpServerStatus]:
    from ..mcp.manager import McpPool

    pool = McpPool(config.mcp_servers)
    try:
        await pool.start()
        return pool.status()
    finally:
        await pool.aclose()


@mcp_app.command("refresh")
def mcp_refresh() -> None:
    """Reconnect the listener's MCP servers."""
    _, alive = _live_daemon()
    if not alive:
        console.print("[yellow]No listener is running; nothing to refresh.[/yellow]")
        return
    send_command(CommandName.MCP_REFRESH)
    console.print("Asked the listener to reconnect its MCP servers.")


@mcp_app.command("tools")
def mcp_tools() -> None:
    """List the tools every configured server advertises."""
    config = _require_config()
    servers = asyncio.run(_probe_tools(config))
    for server_id, tools in sorted(servers.items()):
        console.print(f"[bold]{server_id}[/bold]")
        for name in sorted(tools):
            console.print(f"  {server_id}.{name}")
        if not tools:
            console.print("  [dim](no tools)[/dim]")


async def _probe_tools(config: ChatmdConfig) -> dict[str, list[str]]:
    from ..mcp.manager import McpPool

    pool = McpPool(config.mcp_servers)
    try:
        await pool.start()
        return {server: list(tools) for server, tools in pool.grouped_tools().items()}
    finally:
        await pool.aclose()


# --------------------------------------------------------------------------- #
# Driving a single file
# --------------------------------------------------------------------------- #


@app.command()
def run(
    path: Path = typer.Argument(..., help="A .chat.md file."),
    rounds: int | None = typer.Option(
        None, "--rounds", help="Stop after this many actions instead of running to completion."
    ),
) -> None:
    """Drive one chat file to completion here, without the listener."""
    config = _require_config()
    if not path.exists():
        _fail(f"{path} does not exist.")
    raise typer.Exit(asyncio.run(_run_file(config, path, rounds)))


async def _run_file(config: ChatmdConfig, path: Path, rounds: int | None) -> int:
    from ..engine.driver import ChatDriver, StepAction
    from ..mcp.manager import McpPool

    pool = McpPool(config.mcp_servers)
    await pool.start()
    driver = ChatDriver(config, pool)
    try:
        results = await driver.run(path, max_rounds=rounds)
    finally:
        await pool.aclose()

    for result in results:
        if result.action is StepAction.STREAMED:
            console.print(f"streamed  [dim]{result.outcome}[/dim] {result.model or ''}")
        elif result.action is StepAction.EXECUTED_TOOL:
            console.print(f"tool      {result.tool_name}")
        elif result.action is StepAction.LOCKED:
            console.print(f"[yellow]locked[/yellow]    {result.message}")
        elif result.action is StepAction.ERROR:
            console.print(f"[red]error[/red]     {result.message}")

    last = results[-1] if results else None
    if last and last.action is StepAction.ERROR:
        return 1
    return 0


@app.command()
def send(
    path: Path = typer.Argument(..., help="A .chat.md file; created if missing."),
    message: str = typer.Argument(..., help="What to say."),
    run_now: bool = typer.Option(
        False, "--run", help="Drive the file here instead of leaving it to the listener."
    ),
) -> None:
    """Append a user turn and an empty assistant block, which triggers a reply."""
    config = _require_config()
    existing = path.read_text(encoding="utf-8") if path.exists() else ""
    addition = f"{block_marker_prefix(existing)}# %% user\n{message}\n\n# %% assistant\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(existing + addition, encoding="utf-8")
    console.print(f"[green]Appended to[/green] {path}")

    if run_now:
        raise typer.Exit(asyncio.run(_run_file(config, path, None)))

    _, alive = _live_daemon()
    if not alive:
        console.print(
            "[dim]No listener running: use `chatmd run` on this file, or "
            "`chatmd watch` its folder.[/dim]"
        )


@app.command()
def parse(
    path: Path = typer.Argument(..., help="A .chat.md file."),
    as_json: bool = typer.Option(False, "--json", help="Machine-readable output."),
) -> None:
    """Show how a chat file parses. Useful when a document is not behaving."""
    from dataclasses import asdict

    from ..parser.document import parse_document

    config = load_config() if config_exists() else ChatmdConfig()
    if not path.exists():
        _fail(f"{path} does not exist.")
    try:
        parsed = parse_document(
            path.read_text(encoding="utf-8"), path.parent, assets_path=config.assets_path
        )
    except ChatmdError as error:
        _fail(str(error))
        return

    if as_json:
        _print_json(
            {
                "systemPrompt": parsed.system_prompt,
                "fileConfig": parsed.file_config,
                "hasImageInSystemBlock": parsed.has_image_in_system_block,
                "messages": [asdict(message) for message in parsed.messages],
            }
        )
        return

    console.print(f"[bold]{len(parsed.messages)} message(s)[/bold]")
    if parsed.file_config:
        console.print(f"preamble: {parsed.file_config}")
    if parsed.system_prompt:
        console.print(f"system prompt: {len(parsed.system_prompt)} chars")
    for index, message in enumerate(parsed.messages):
        kinds = ", ".join(block.type for block in message.content)
        console.print(f"  {index:>3}  {message.role:<9} [dim]{kinds}[/dim]")


@app.command()
def version() -> None:
    """Print the version."""
    console.print(__version__)


def main() -> None:
    """Entry point for the ``chatmd`` script."""
    # Log to stderr at whatever level the environment asks for, so a foreground
    # daemon and a one-shot run are debuggable without a flag.
    import logging

    logging.basicConfig(
        level=os.environ.get("CHATMD_LOG", "WARNING").upper(),
        format="%(asctime)s %(levelname)-7s %(name)s  %(message)s",
        stream=sys.stderr,
    )
    app()


if __name__ == "__main__":
    main()
