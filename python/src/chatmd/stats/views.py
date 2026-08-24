"""Terminal rendering for statistics, daemon status and MCP health.

Kept separate from the CLI so the same tables can back a one-shot command and the
live view, and so the formatting helpers can be tested without a terminal.
"""

from __future__ import annotations

import time
from collections.abc import Sequence

from rich.console import Group, RenderableType
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

from ..daemon.state import DaemonStatus, FileState
from ..types import McpServerStatus
from .store import GroupRow, Totals

#: Not priced, rather than free. See chatmd.stats.pricing.
NOT_PRICED = "—"

_STATE_STYLES = {
    FileState.STREAMING: "bold green",
    FileState.EXECUTING: "bold yellow",
    FileState.LOCKED: "dim",
    FileState.ERROR: "bold red",
    FileState.IDLE: "dim",
}

_MCP_STYLES = {
    "connected": "green",
    "connecting": "yellow",
    "errored": "red",
    "not-started": "dim",
}


def format_tokens(count: int | None) -> str:
    """Compact token counts, so a wide table still fits a terminal."""
    if not count:
        return "0"
    if count < 1_000:
        return str(count)
    if count < 1_000_000:
        return f"{count / 1_000:.1f}k"
    return f"{count / 1_000_000:.2f}M"


def format_cost(cost: float | None) -> str:
    if cost is None:
        return NOT_PRICED
    if cost < 0.01:
        return f"${cost:.4f}"
    return f"${cost:,.2f}"


def format_duration_ms(milliseconds: float | None) -> str:
    if not milliseconds:
        return "-"
    seconds = milliseconds / 1000.0
    if seconds < 60:
        return f"{seconds:.1f}s"
    minutes, seconds = divmod(int(seconds), 60)
    if minutes < 60:
        return f"{minutes}m {seconds}s"
    hours, minutes = divmod(minutes, 60)
    return f"{hours}h {minutes}m"


def format_age(timestamp: float | None, *, now: float | None = None) -> str:
    """How long ago something happened, as a relative label."""
    if not timestamp:
        return "-"
    delta = (now if now is not None else time.time()) - timestamp
    if delta < 0:
        return "just now"
    if delta < 60:
        return f"{int(delta)}s ago"
    if delta < 3600:
        return f"{int(delta // 60)}m ago"
    if delta < 86400:
        return f"{int(delta // 3600)}h ago"
    return f"{int(delta // 86400)}d ago"


def summary_table(rows: Sequence[GroupRow], *, group_by: str = "model") -> Table:
    """Token and cost totals, grouped."""
    table = Table(title=f"Usage by {group_by}", title_style="bold", header_style="bold")
    table.add_column(group_by.capitalize(), overflow="fold")
    table.add_column("Turns", justify="right")
    table.add_column("In", justify="right")
    table.add_column("Out", justify="right")
    table.add_column("Cache r/w", justify="right")
    table.add_column("Cost", justify="right")
    table.add_column("Time", justify="right")

    for row in rows:
        table.add_row(
            row.key,
            str(row.turns),
            format_tokens(row.input_tokens),
            format_tokens(row.output_tokens),
            f"{format_tokens(row.cache_read_tokens)}/{format_tokens(row.cache_write_tokens)}",
            format_cost(row.cost),
            format_duration_ms(row.duration_ms),
        )

    if not rows:
        table.add_row("(nothing recorded yet)", "", "", "", "", "", "")
    return table


def timeline_table(rows: Sequence[GroupRow], *, bucket: str = "day") -> Table:
    table = Table(title=f"Usage by {bucket}", title_style="bold", header_style="bold")
    table.add_column(bucket.capitalize())
    table.add_column("Turns", justify="right")
    table.add_column("In", justify="right")
    table.add_column("Out", justify="right")
    table.add_column("Cost", justify="right")
    table.add_column("", justify="left")  # sparkline-ish bar

    peak = max((row.output_tokens for row in rows), default=0)
    for row in rows:
        width = int((row.output_tokens / peak) * 24) if peak else 0
        table.add_row(
            row.key,
            str(row.turns),
            format_tokens(row.input_tokens),
            format_tokens(row.output_tokens),
            format_cost(row.cost),
            Text("█" * width, style="cyan"),
        )
    if not rows:
        table.add_row("(nothing recorded yet)", "", "", "", "", "")
    return table


def tools_table(tools: Sequence[tuple[str, int]]) -> Table:
    table = Table(title="Tools", title_style="bold", header_style="bold")
    table.add_column("Tool", overflow="fold")
    table.add_column("Calls", justify="right")
    for name, count in tools:
        table.add_row(name, str(count))
    if not tools:
        table.add_row("(no tool calls yet)", "")
    return table


def totals_panel(totals: Totals) -> Panel:
    body = Table.grid(padding=(0, 2))
    body.add_column(style="dim")
    body.add_column(justify="right")
    body.add_row("Turns", str(totals.turns))
    body.add_row("Tool calls", str(totals.tool_calls))
    body.add_row("Errors", str(totals.errors))
    body.add_row("Input", format_tokens(totals.input_tokens))
    body.add_row("Output", format_tokens(totals.output_tokens))
    body.add_row(
        "Cache read/write",
        f"{format_tokens(totals.cache_read_tokens)}/"
        f"{format_tokens(totals.cache_write_tokens)}",
    )
    body.add_row("Cost", format_cost(totals.cost))
    return Panel(body, title="Totals", title_align="left")


def mcp_table(servers: Sequence[McpServerStatus]) -> Table:
    table = Table(title="MCP servers", title_style="bold", header_style="bold")
    table.add_column("Server", overflow="fold")
    table.add_column("State")
    table.add_column("Tools", justify="right")
    table.add_column("Prompts", justify="right")
    table.add_column("Resources", justify="right")
    table.add_column("Connected")
    table.add_column("Last error", overflow="fold")

    for server in servers:
        table.add_row(
            server.server_id,
            Text(server.state, style=_MCP_STYLES.get(server.state, "")),
            str(server.tool_count),
            str(server.prompt_count),
            str(server.resource_count),
            format_age(server.connected_since),
            server.last_error or "",
        )
    if not servers:
        table.add_row("(no MCP servers configured)", "", "", "", "", "", "")
    return table


def files_table(status: DaemonStatus) -> Table:
    table = Table(title="Chat files", title_style="bold", header_style="bold")
    table.add_column("File", overflow="fold")
    table.add_column("State")
    table.add_column("Model", overflow="fold")
    table.add_column("Tool", overflow="fold")
    table.add_column("Written", justify="right")
    table.add_column("For", justify="right")

    for activity in status.files:
        table.add_row(
            activity.path,
            Text(str(activity.state), style=_STATE_STYLES.get(activity.state, "")),
            activity.model or "",
            activity.tool or "",
            format_tokens(activity.characters),
            format_age(activity.since, now=status.at),
        )
    if not status.files:
        table.add_row("(nothing in flight)", "", "", "", "", "")
    return table


def daemon_header(status: DaemonStatus | None) -> RenderableType:
    """One line saying whether a listener is running, and since when."""
    if status is None or status.daemon is None:
        return Panel(
            Text("No listener running. Start one with `chatmd serve`.", style="yellow"),
            title="chat.md",
            title_align="left",
        )

    info = status.daemon
    grid = Table.grid(padding=(0, 2))
    grid.add_column(style="dim")
    grid.add_column()
    grid.add_row("pid", str(info.pid))
    grid.add_row("host", info.host)
    grid.add_row("version", info.version)
    grid.add_row("up", format_duration_ms((status.at - info.started_at) * 1000.0))
    grid.add_row("watching", "\n".join(status.watching) or "(nothing registered)")
    grid.add_row("snapshot", format_age(status.at))
    return Panel(grid, title="Listener", title_align="left")


def status_renderable(status: DaemonStatus | None) -> RenderableType:
    """What ``chatmd status`` prints."""
    if status is None or status.daemon is None:
        return daemon_header(status)
    return Group(daemon_header(status), files_table(status), mcp_table(status.mcp))


def live_renderable(status: DaemonStatus | None, totals: Totals) -> RenderableType:
    """What ``chatmd live`` refreshes in place."""
    if status is None or status.daemon is None:
        return daemon_header(status)
    counters = Table.grid(padding=(0, 3))
    counters.add_column(style="dim")
    counters.add_column(justify="right")
    counters.add_row("turns this session", str(status.turns))
    counters.add_row("tool calls", str(status.tool_calls))
    counters.add_row("errors", str(status.errors))
    return Group(
        daemon_header(status),
        Panel(counters, title="Since start", title_align="left"),
        files_table(status),
        mcp_table(status.mcp),
        totals_panel(totals),
    )
