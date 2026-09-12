"""Picks the provider client for a resolved configuration."""

from __future__ import annotations

import logging
from pathlib import Path

from ..config.model import ResolvedConfig
from ..mcp.sdk_bridge import SdkMcpBridge
from .anthropic_client import AnthropicClient
from .base import LlmClient
from .capabilities import resolve_openai_api_style
from .claude_code import ClaudeCodeClient
from .codex import CodexSdkClient
from .openai_chat import OpenAIChatClient
from .openai_responses import OpenAIResponsesClient

logger = logging.getLogger(__name__)


def create_client(config: ResolvedConfig, chat_path: Path | None) -> LlmClient:
    """Build the client for this configuration's provider and API style.

    OpenAI-compatible backends share one SDK; the API style selects their wire
    translation.
    """
    if config.provider == "anthropic":
        return AnthropicClient(config)

    if config.provider == "openai":
        style = resolve_openai_api_style(config.model_name, config.base_url, config.openai_api)
        logger.debug("Using OpenAI API style: %s", style)
        if style == "responses":
            return OpenAIResponsesClient(config)

        return OpenAIChatClient(config)

    if config.provider == "claude-code":
        if chat_path is None:
            raise ValueError("Claude Code requires a ChatMD path.")
        return ClaudeCodeClient(config, chat_path, None)

    if config.provider == "codex":
        if chat_path is None:
            raise ValueError("Codex requires a ChatMD path.")
        return CodexSdkClient(config, chat_path, None)

    raise ValueError(f"Unknown provider: {config.provider!r}")


def attach_mcp_bridge(
    client: LlmClient, mcp_bridge: SdkMcpBridge | None
) -> LlmClient:
    if isinstance(client, (ClaudeCodeClient, CodexSdkClient)):
        client.set_mcp_bridge(mcp_bridge)
    return client
