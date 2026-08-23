"""Tests for chatmd.providers.capabilities, a port of modelCapabilities.ts + two
helpers lifted from config.ts."""

from __future__ import annotations

import pytest

from chatmd.providers.capabilities import (
    calculate_thinking_tokens_from_effort,
    is_adaptive_thinking_model,
    is_openai_base_url,
    is_responses_api_model,
    needs_interleaved_thinking_beta,
    omits_thinking_by_default,
    requires_always_on_thinking,
    resolve_openai_api_style,
    to_adaptive_effort,
)
from chatmd.types import ReasoningEffort

# Real-world model names table-driven across every predicate.
MODEL_TABLE: dict[str, dict[str, bool]] = {
    "claude-opus-4-5": {
        "adaptive": False,
        "omits": False,
        "always_on": False,
        "interleaved": True,
        "responses_api": False,
    },
    "claude-sonnet-4-6": {
        "adaptive": True,
        "omits": False,
        "always_on": False,
        "interleaved": False,
        "responses_api": False,
    },
    "claude-opus-5": {
        "adaptive": True,
        "omits": True,
        "always_on": False,
        "interleaved": False,
        "responses_api": False,
    },
    "claude-fable-5": {
        "adaptive": True,
        "omits": True,
        "always_on": True,
        "interleaved": False,
        "responses_api": False,
    },
    "claude-haiku-4-5": {
        "adaptive": False,
        "omits": False,
        "always_on": False,
        "interleaved": True,
        "responses_api": False,
    },
    "claude-sonnet-4-7": {
        "adaptive": True,
        "omits": True,
        "always_on": False,
        "interleaved": False,
        "responses_api": False,
    },
    "gpt-4.1-mini": {
        "adaptive": False,
        "omits": False,
        "always_on": False,
        "interleaved": False,
        "responses_api": True,
    },
    "o3": {
        "adaptive": False,
        "omits": False,
        "always_on": False,
        "interleaved": False,
        "responses_api": True,
    },
    "openai/gpt-4o": {
        # Routed through OpenRouter; the "openai/" prefix means it does not match
        # the Claude version regex nor the Responses-API prefix regex.
        "adaptive": False,
        "omits": False,
        "always_on": False,
        "interleaved": False,
        "responses_api": False,
    },
    "totally-not-a-real-model": {
        "adaptive": False,
        "omits": False,
        "always_on": False,
        "interleaved": False,
        "responses_api": False,
    },
}


@pytest.mark.parametrize("model,expected", MODEL_TABLE.items(), ids=list(MODEL_TABLE))
def test_is_adaptive_thinking_model(model: str, expected: dict[str, bool]) -> None:
    assert is_adaptive_thinking_model(model) is expected["adaptive"]


@pytest.mark.parametrize("model,expected", MODEL_TABLE.items(), ids=list(MODEL_TABLE))
def test_omits_thinking_by_default(model: str, expected: dict[str, bool]) -> None:
    assert omits_thinking_by_default(model) is expected["omits"]


@pytest.mark.parametrize("model,expected", MODEL_TABLE.items(), ids=list(MODEL_TABLE))
def test_requires_always_on_thinking(model: str, expected: dict[str, bool]) -> None:
    assert requires_always_on_thinking(model) is expected["always_on"]


@pytest.mark.parametrize("model,expected", MODEL_TABLE.items(), ids=list(MODEL_TABLE))
def test_needs_interleaved_thinking_beta(model: str, expected: dict[str, bool]) -> None:
    assert needs_interleaved_thinking_beta(model) is expected["interleaved"]


@pytest.mark.parametrize("model,expected", MODEL_TABLE.items(), ids=list(MODEL_TABLE))
def test_is_responses_api_model(model: str, expected: dict[str, bool]) -> None:
    assert is_responses_api_model(model) is expected["responses_api"]


# -- case-insensitivity and minor-version-omitted parsing -------------------------- #


def test_claude_version_parse_is_case_insensitive() -> None:
    assert is_adaptive_thinking_model("Claude-Opus-5") is True
    assert is_adaptive_thinking_model("CLAUDE-SONNET-4-6") is True


def test_missing_minor_part_means_zero() -> None:
    # claude-sonnet-4 (no minor) parses as major=4, minor=0.
    assert needs_interleaved_thinking_beta("claude-sonnet-4") is True
    assert is_adaptive_thinking_model("claude-sonnet-4") is False


# -- to_adaptive_effort -------------------------------------------------------------- #


@pytest.mark.parametrize(
    "effort,expected",
    [
        ("minimal", "low"),
        ("low", "low"),
        ("none", "low"),
        ("medium", "medium"),
        ("high", "high"),
    ],
)
def test_to_adaptive_effort(effort: ReasoningEffort, expected: str) -> None:
    assert to_adaptive_effort(effort) == expected


# -- is_openai_base_url -------------------------------------------------------------- #


@pytest.mark.parametrize(
    "base_url,expected",
    [
        (None, True),
        ("", True),
        ("   ", True),
        ("https://api.openai.com/v1", True),
        ("https://sub.api.openai.com", True),
        ("https://openrouter.ai/api/v1", False),
        ("http://localhost:11434", False),
        ("http://[::1", False),  # unparseable -> False
    ],
)
def test_is_openai_base_url(base_url: str | None, expected: bool) -> None:
    assert is_openai_base_url(base_url) is expected


# -- calculate_thinking_tokens_from_effort ------------------------------------------- #


@pytest.mark.parametrize(
    "max_tokens,effort,expected",
    [
        (8000, "none", 1024),  # ratio 0 -> floored to the 1024 minimum, not 0
        (8000, "minimal", 1024),  # 800 rounds below the minimum too
        (8000, "low", 1600),
        (8000, "medium", 4000),
        (8000, "high", 6400),
        (100_000, "high", 32000),  # clamped at the maximum
        (100_000, "none", 1024),  # minimum still wins even with a huge budget
    ],
)
def test_calculate_thinking_tokens_from_effort(
    max_tokens: int, effort: ReasoningEffort, expected: int
) -> None:
    assert calculate_thinking_tokens_from_effort(max_tokens, effort) == expected


# -- resolve_openai_api_style --------------------------------------------------------- #


def test_resolve_openai_api_style_explicit_chat_wins() -> None:
    assert resolve_openai_api_style("gpt-4o", None, "chat") == "chat"


def test_resolve_openai_api_style_explicit_responses_wins() -> None:
    assert resolve_openai_api_style("claude-opus-5", None, "responses") == "responses"


def test_resolve_openai_api_style_auto_responses_model_default_base_url() -> None:
    assert resolve_openai_api_style("gpt-4o", None, "auto") == "responses"


def test_resolve_openai_api_style_auto_responses_model_openai_base_url() -> None:
    assert resolve_openai_api_style("o3", "https://api.openai.com/v1", "auto") == "responses"


def test_resolve_openai_api_style_auto_responses_model_third_party_base_url() -> None:
    # Same model, but routed elsewhere (e.g. OpenRouter): only chat completions apply.
    assert resolve_openai_api_style("gpt-4o", "https://openrouter.ai/api/v1", "auto") == "chat"


def test_resolve_openai_api_style_auto_non_responses_model() -> None:
    assert resolve_openai_api_style("claude-opus-4-5", None, "auto") == "chat"


def test_resolve_openai_api_style_auto_no_model_name() -> None:
    assert resolve_openai_api_style(None, None, "auto") == "chat"
