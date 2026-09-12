"""First-run setup: find the editor settings already on this machine and import them.

Most people arrive here with the VS Code extension already configured, so the
fastest correct setup is to copy what they have rather than ask them to retype API
keys. The keys the extension uses are named identically in our config, so an
import is a straight copy.
"""

from __future__ import annotations

import shutil
from collections.abc import Sequence
from typing import Literal

from rich.console import Console
from rich.prompt import Confirm, Prompt
from rich.table import Table

from ..config.discovery import EditorCandidate, discover_editor_settings
from ..config.loader import config_from_editor_candidates, load_config, save_config
from ..config.model import ApiConfig, ChatmdConfig
from ..paths import config_path


def candidates_table(candidates: Sequence[EditorCandidate]) -> Table:
    table = Table(header_style="bold")
    table.add_column("#", justify="right")
    table.add_column("Editor")
    table.add_column("API configs", justify="right")
    table.add_column("MCP servers", justify="right")
    table.add_column("Settings file", overflow="fold", style="dim")
    for index, candidate in enumerate(candidates, start=1):
        table.add_row(
            str(index),
            candidate.editor,
            str(candidate.api_config_count),
            str(candidate.mcp_server_count),
            str(candidate.settings_path),
        )
    return table


def parse_selection(raw: str, count: int) -> list[int]:
    """Turn "1,3" or "all" or "none" into zero-based indices.

    Raises ValueError on anything else, so a typo is reported rather than silently
    importing the wrong editor's keys.
    """
    cleaned = raw.strip().lower()
    if cleaned in ("", "none", "skip"):
        return []
    if cleaned == "all":
        return list(range(count))

    indices: list[int] = []
    for piece in cleaned.replace(" ", "").split(","):
        if not piece.isdigit():
            raise ValueError(f"Not a number: {piece!r}")
        number = int(piece)
        if not 1 <= number <= count:
            raise ValueError(f"No such option: {number}")
        if number - 1 not in indices:
            indices.append(number - 1)
    return indices


def _available_name(config: ChatmdConfig, preferred: str) -> str:
    if preferred not in config.api_configs:
        return preferred
    suffix = 2
    while f"{preferred}-{suffix}" in config.api_configs:
        suffix += 1
    return f"{preferred}-{suffix}"


def add_subscription_defaults(
    config: ChatmdConfig, claude_available: bool, codex_available: bool
) -> ChatmdConfig:
    """Add detected subscription providers without mutating imported settings."""
    updated = ChatmdConfig.from_dict(config.to_dict())
    claude_name = next(
        (name for name, entry in updated.api_configs.items() if entry.type == "claude-code"),
        None,
    )
    if claude_available and claude_name is None:
        claude_name = _available_name(updated, "claude-code-opus")
        updated.api_configs[claude_name] = ApiConfig(
            type="claude-code",
            api_key=None,
            model_name="claude-opus-5",
            reasoning_effort="high",
            claude_code={"permissionMode": "bypassPermissions"},
        )

    codex_name = next(
        (name for name, entry in updated.api_configs.items() if entry.type == "codex"),
        None,
    )
    if codex_available and codex_name is None:
        codex_name = _available_name(updated, "codex-sol")
        updated.api_configs[codex_name] = ApiConfig(
            type="codex",
            api_key=None,
            model_name="gpt-5.6-sol",
            reasoning_effort="high",
            codex={
                "thread": {
                    "sandboxMode": "danger-full-access",
                    "approvalPolicy": "never",
                }
            },
        )

    if updated.selected_config not in updated.api_configs:
        updated.selected_config = (
            claude_name if claude_available else codex_name if codex_available else None
        )
    return updated


def _prompt_api_config(console: Console) -> ChatmdConfig:
    selected_provider = Prompt.ask(
        "API provider", choices=["anthropic", "openai"], default="anthropic", console=console
    )
    provider: Literal["anthropic", "openai"] = (
        "openai" if selected_provider == "openai" else "anthropic"
    )
    name = Prompt.ask("Configuration name", default=provider, console=console)
    api_key = Prompt.ask(f"{provider} API key", password=True, console=console)
    default_model = "claude-sonnet-4-6" if provider == "anthropic" else "gpt-5.4"
    model = Prompt.ask("Model", default=default_model, console=console)
    return ChatmdConfig(
        api_configs={name: ApiConfig(type=provider, api_key=api_key, model_name=model)},
        selected_config=name,
    )


def summarise(config: ChatmdConfig, console: Console) -> None:
    """Show what the config now holds, so a mistake is visible immediately."""
    if config.api_configs:
        table = Table(title="API configurations", header_style="bold", title_style="bold")
        table.add_column("Name")
        table.add_column("Provider")
        table.add_column("Model", overflow="fold")
        table.add_column("Authentication")
        for name, entry in sorted(config.api_configs.items()):
            if entry.type in ("claude-code", "codex"):
                marker = "CLI subscription"
            else:
                marker = "API key set" if entry.api_key else "[red]API key missing[/red]"
            selected = " [green](selected)[/green]" if name == config.selected_config else ""
            table.add_row(f"{name}{selected}", entry.type, entry.model_name or "-", marker)
        console.print(table)
    else:
        console.print("[yellow]No API configurations imported.[/yellow]")

    if config.mcp_servers:
        table = Table(title="MCP servers", header_style="bold", title_style="bold")
        table.add_column("Server")
        table.add_column("Transport")
        table.add_column("Command or URL", overflow="fold")
        for name, server in sorted(config.mcp_servers.items()):
            if server.is_stdio:
                table.add_row(name, "stdio", " ".join([server.command or "", *server.args]).strip())
            else:
                table.add_row(name, server.transport, server.url or "")
        console.print(table)
    else:
        console.print("[dim]No MCP servers configured; tools will be unavailable.[/dim]")


def run_setup(console: Console, *, force: bool = False) -> ChatmdConfig:
    """Interactive first-run setup. Returns the config that was written."""
    target = config_path()
    if target.exists() and not force:
        if not Confirm.ask(
            f"A config already exists at {target}. Overwrite it?", default=False, console=console
        ):
            console.print("[dim]Keeping the existing config.[/dim]")
            return load_config()

    console.print("\n[bold]Looking for editor settings…[/bold]")
    candidates = discover_editor_settings()

    config = ChatmdConfig()
    if not candidates:
        console.print("[yellow]No editor settings with chat.md configuration found.[/yellow]")
    else:
        console.print(candidates_table(candidates))
        console.print(
            "\nPick which to import: a number, several separated by commas, "
            "[bold]all[/bold], or [bold]none[/bold]."
        )
        while True:
            raw = Prompt.ask("Import", default="1", console=console)
            try:
                chosen = parse_selection(raw, len(candidates))
                break
            except ValueError as error:
                console.print(f"[red]{error}[/red]")

        # Later picks win per key, and apiConfigs/mcpServers merge per entry, so
        # importing several editors combines their providers rather than replacing.
        config = config_from_editor_candidates([candidates[index] for index in chosen])

    config = add_subscription_defaults(
        config,
        shutil.which("claude") is not None,
        shutil.which("codex") is not None,
    )
    if not config.api_configs:
        console.print("No Claude Code or Codex subscription login was detected.")
        config = _prompt_api_config(console)

    if len(config.api_configs) > 1 and not config.selected_config:
        names = sorted(config.api_configs)
        config.selected_config = Prompt.ask(
            "Which configuration should be the default?",
            choices=names,
            default=names[0],
            console=console,
        )
    elif not config.selected_config and config.api_configs:
        config.selected_config = next(iter(config.api_configs))

    written = save_config(config)
    console.print(f"\n[green]Wrote {written}[/green] (readable only by you)\n")
    summarise(config, console)
    console.print(
        "\nNext: [bold]chatmd watch <folder>[/bold] to start listening, "
        "or [bold]chatmd run <file.chat.md>[/bold] for a single file."
    )
    return config
