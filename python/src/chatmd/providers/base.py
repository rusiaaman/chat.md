"""Provider-facing contracts.

Each provider client turns a message history plus a system prompt into a stream of
:class:`~chatmd.types.StreamEvent` values. Nothing above this layer knows which
SDK produced them.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path
from typing import Protocol, runtime_checkable

from ..config.model import ResolvedConfig
from ..types import MessageParam, StreamEvent, Usage


@runtime_checkable
class LlmClient(Protocol):
    """A streaming completion client for one provider/API style."""

    config: ResolvedConfig
    #: Usage of the most recent request, populated as the stream progresses.
    last_usage: Usage | None

    def stream(
        self,
        messages: list[MessageParam],
        system_prompt: str,
        *,
        base_dir: str | Path | None = None,
    ) -> AsyncIterator[StreamEvent]:
        """Yield events for one assistant turn.

        ``base_dir`` resolves image attachments written as relative paths.
        Raises on transport failure; the engine owns retry policy.
        """
        ...


class MaxTokensError(Exception):
    """The model hit its output limit; the engine restarts with partial context."""


class RetryableError(Exception):
    """A 5xx, 429 or transport hiccup that the engine should retry with backoff."""
