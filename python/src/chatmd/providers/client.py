"""Picks the provider client for a resolved configuration."""

from __future__ import annotations

import logging

from ..config.model import ResolvedConfig
from .base import LlmClient
from .capabilities import resolve_openai_api_style

logger = logging.getLogger(__name__)


def create_client(config: ResolvedConfig) -> LlmClient:
    """Build the client for this configuration's provider and API style.

    Imports are deferred so that using one provider never requires the other
    provider's SDK to be importable.
    """
    if config.provider == "anthropic":
        from .anthropic_client import AnthropicClient

        return AnthropicClient(config)

    if config.provider == "openai":
        style = resolve_openai_api_style(config.model_name, config.base_url, config.openai_api)
        logger.debug("Using OpenAI API style: %s", style)
        if style == "responses":
            from .openai_responses import OpenAIResponsesClient

            return OpenAIResponsesClient(config)

        from .openai_chat import OpenAIChatClient

        return OpenAIChatClient(config)

    raise ValueError(f"Unknown provider: {config.provider!r}")
