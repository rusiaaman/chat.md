"""Model capability checks needed for reasoning support.

A port of ``src/utils/modelCapabilities.ts``, plus ``calculateThinkingTokensFromEffort``
and ``resolveOpenaiApiStyle`` from ``src/config.ts``. Kept free of provider SDK imports
so it can be unit tested in isolation.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal
from urllib.parse import urlparse

from ..types import OpenaiApiStyle, ReasoningEffort

#: Anthropic effort levels accepted by adaptive thinking.
AdaptiveEffort = Literal["low", "medium", "high"]

_CLAUDE_VERSION_RE = re.compile(
    r"claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:[-.](\d+))?", re.IGNORECASE
)


@dataclass(frozen=True)
class _ClaudeVersion:
    family: str
    major: int
    minor: int


def _parse_claude_version(model: str) -> _ClaudeVersion | None:
    match = _CLAUDE_VERSION_RE.search(model)
    if not match:
        return None
    return _ClaudeVersion(
        family=match.group(1).lower(),
        major=int(match.group(2)),
        minor=int(match.group(3)) if match.group(3) else 0,
    )


def is_adaptive_thinking_model(model: str) -> bool:
    """Models using ``thinking: {type: "adaptive"}`` + effort, not budget_tokens.

    Claude 4.6 and everything from 5 onwards.
    """
    version = _parse_claude_version(model)
    if version is None:
        return False
    if version.family in ("fable", "mythos"):
        return True
    if version.major >= 5:
        return True
    return version.major == 4 and version.minor >= 6


def omits_thinking_by_default(model: str) -> bool:
    """Models that omit thinking content unless ``display: "summarized"`` is asked for.

    Claude 4.7+, 5.x, Fable/Mythos.
    """
    version = _parse_claude_version(model)
    if version is None:
        return False
    if version.family in ("fable", "mythos"):
        return True
    if version.major >= 5:
        return True
    return version.major == 4 and version.minor >= 7


def requires_always_on_thinking(model: str) -> bool:
    """Models where a disabled thinking config is rejected, so the param must be omitted."""
    version = _parse_claude_version(model)
    return version is not None and version.family == "fable" and version.major == 5


def needs_interleaved_thinking_beta(model: str) -> bool:
    """Older Anthropic models that need the interleaved thinking beta header.

    Generally available from 4.6 onwards.
    """
    version = _parse_claude_version(model)
    if version is None:
        return False
    if version.major > 4:
        return False
    return version.major == 4 and version.minor <= 5


def to_adaptive_effort(effort: ReasoningEffort) -> AdaptiveEffort:
    """Map the configured reasoning effort onto Anthropic's adaptive effort levels."""
    if effort in ("minimal", "low", "none"):
        return "low"
    if effort == "medium":
        return "medium"
    return "high"


def is_responses_api_model(model: str) -> bool:
    """OpenAI models served by the Responses API: the gpt-* family and o-series."""
    return re.match(r"^(gpt-|o[1-9])", model.strip(), re.IGNORECASE) is not None


def is_openai_base_url(base_url: str | None) -> bool:
    """True when a base URL points at OpenAI itself.

    Any other host (OpenRouter, local servers, Azure gateways, ...) only speaks chat
    completions.
    """
    if not base_url or not base_url.strip():
        return True  # no override means api.openai.com
    try:
        hostname = urlparse(base_url).hostname
    except ValueError:
        return False
    if hostname is None:
        return False
    return hostname.endswith("api.openai.com")


_EFFORT_RATIOS: dict[ReasoningEffort, float] = {
    "none": 0.0,
    "minimal": 0.1,
    "low": 0.2,
    "medium": 0.5,
    "high": 0.8,
}


def calculate_thinking_tokens_from_effort(max_tokens: int, effort: ReasoningEffort) -> int:
    """Convert a reasoning effort into a thinking token budget, using OpenRouter-like ratios.

    The clamp order matters: the ratio-derived budget is capped at 32000 first, then
    floored at 1024 — so "none" still yields 1024, not 0, matching the TS behaviour.
    """
    ratio = _EFFORT_RATIOS[effort]
    calculated_budget = int(max_tokens * ratio)  # floor, matches Math.floor for non-negative
    min_budget = 1024
    max_budget = 32000
    return max(min(calculated_budget, max_budget), min_budget)


def resolve_openai_api_style(
    model_name: str | None, base_url: str | None, openai_api: OpenaiApiStyle
) -> Literal["chat", "responses"]:
    """Decide which OpenAI API shape to speak for this request.

    The VS Code version reads the ``openaiApi`` setting internally; here it is passed
    in already resolved. Only when it is "auto" do the model name and base URL matter.
    """
    if openai_api in ("chat", "responses"):
        return openai_api

    if model_name and is_responses_api_model(model_name) and is_openai_base_url(base_url):
        return "responses"
    return "chat"
