"""Tests for chatmd.parser.preamble: the ``key=value`` block before the first
``# %%`` marker.

Port of the inline preamble-parsing logic in TS ``parseDocument`` (``src/parser.ts``).
"""

from __future__ import annotations

import pytest

from chatmd.config.model import ALLOWED_FILE_CONFIG_KEYS, FORBIDDEN_FILE_CONFIG_KEYS
from chatmd.errors import ForbiddenInlineConfigKey, InvalidStartContent
from chatmd.parser.preamble import parse_preamble

# --------------------------------------------------------------------------- #
# Legal preamble shapes: blank lines, comments, key=value
# --------------------------------------------------------------------------- #


def test_empty_preamble_has_no_configuration_block() -> None:
    assert parse_preamble("") == ({}, False)


def test_blank_lines_are_allowed_and_ignored() -> None:
    assert parse_preamble("\n\n   \n\n") == ({}, False)


def test_comment_lines_are_allowed_and_ignored() -> None:
    assert parse_preamble("# this is a comment\n# another one\n") == ({}, False)


def test_a_single_key_value_pair_is_collected() -> None:
    assert parse_preamble("selectedConfig=work\n") == ({"selectedConfig": "work"}, True)


def test_max_reasoning_effort_is_supported_in_chat_file_config() -> None:
    assert parse_preamble("reasoningEffort=max\n") == (
        {"reasoningEffort": "max"},
        True,
    )


def test_comments_and_blanks_interleaved_with_real_keys() -> None:
    text = "# header comment\n\nselectedConfig=work\n\n# trailing comment\n"
    assert parse_preamble(text) == ({"selectedConfig": "work"}, True)


def test_crlf_line_endings_are_handled() -> None:
    assert parse_preamble("selectedConfig=work\r\nreasoningEffort=low\r\n") == (
        {"selectedConfig": "work", "reasoningEffort": "low"},
        True,
    )


# --------------------------------------------------------------------------- #
# Illegal content
# --------------------------------------------------------------------------- #


def test_non_key_value_line_raises_invalid_start_content() -> None:
    with pytest.raises(InvalidStartContent):
        parse_preamble("this is not a key=value line\n")


def test_a_line_with_leading_digit_key_is_not_a_valid_identifier() -> None:
    # The key must start with a letter or underscore.
    with pytest.raises(InvalidStartContent):
        parse_preamble("1key=value\n")


@pytest.mark.parametrize("key", sorted(FORBIDDEN_FILE_CONFIG_KEYS))
def test_forbidden_keys_raise_forbidden_inline_config_key(key: str) -> None:
    with pytest.raises(ForbiddenInlineConfigKey) as excinfo:
        parse_preamble(f"{key}=somevalue\n")
    assert excinfo.value.key == key


def test_forbidden_key_error_message_names_all_forbidden_keys() -> None:
    with pytest.raises(ForbiddenInlineConfigKey) as excinfo:
        parse_preamble("apiKey=secret\n")
    message = str(excinfo.value)
    assert "apiKey" in message
    assert "selectedConfig" in message  # points the author at the right escape hatch


# --------------------------------------------------------------------------- #
# Comment stripping / quoting
# --------------------------------------------------------------------------- #


def test_inline_hash_comment_is_stripped_from_an_unquoted_value() -> None:
    cfg, _ = parse_preamble("selectedConfig=work # this is a comment\n")
    assert cfg == {"selectedConfig": "work"}


def test_inline_hash_comment_is_not_stripped_from_a_double_quoted_value() -> None:
    # A quoted value may legitimately contain a literal "#".
    cfg, _ = parse_preamble('selectedConfig="work#123"\n')
    assert cfg == {"selectedConfig": "work#123"}


def test_inline_hash_comment_is_not_stripped_from_a_single_quoted_value() -> None:
    cfg, _ = parse_preamble("selectedConfig='work#123'\n")
    assert cfg == {"selectedConfig": "work#123"}


def test_surrounding_double_quotes_are_removed() -> None:
    cfg, _ = parse_preamble('selectedConfig="quoted value"\n')
    assert cfg == {"selectedConfig": "quoted value"}


def test_surrounding_single_quotes_are_removed() -> None:
    cfg, _ = parse_preamble("selectedConfig='quoted value'\n")
    assert cfg == {"selectedConfig": "quoted value"}


def test_mismatched_quotes_are_left_untouched() -> None:
    cfg, _ = parse_preamble("""selectedConfig="mismatched'\n""")
    assert cfg == {"selectedConfig": "\"mismatched'"}


# --------------------------------------------------------------------------- #
# maxTokens / maxThinkingTokens numeric parsing
# --------------------------------------------------------------------------- #


def test_max_tokens_is_parsed_as_an_int() -> None:
    cfg, _ = parse_preamble("maxTokens=4096\n")
    assert cfg == {"maxTokens": 4096}
    assert isinstance(cfg["maxTokens"], int)


def test_max_thinking_tokens_is_parsed_as_an_int() -> None:
    cfg, _ = parse_preamble("maxThinkingTokens=8192\n")
    assert cfg == {"maxThinkingTokens": 8192}


def test_max_tokens_loose_parse_takes_leading_digits_like_js_parse_int() -> None:
    # Mirrors JS `parseInt("123abc", 10) === 123`, not a strict full-string parse.
    cfg, _ = parse_preamble("maxTokens=123abc\n")
    assert cfg == {"maxTokens": 123}


def test_max_tokens_negative_value_is_parsed() -> None:
    cfg, _ = parse_preamble("maxTokens=-5\n")
    assert cfg == {"maxTokens": -5}


def test_max_tokens_unparseable_value_is_silently_ignored_not_an_error() -> None:
    cfg, has_block = parse_preamble("maxTokens=notanumber\n")
    assert cfg == {}
    assert has_block is False


# --------------------------------------------------------------------------- #
# Unknown keys / has_configuration_block
# --------------------------------------------------------------------------- #


def test_unknown_keys_are_silently_ignored() -> None:
    cfg, has_block = parse_preamble("someFutureSetting=value\n")
    assert cfg == {}
    assert has_block is False


def test_has_configuration_block_false_when_everything_is_ignored_or_blank() -> None:
    text = "# just a comment\n\nsomeFutureSetting=value\n"
    assert parse_preamble(text) == ({}, False)


def test_has_configuration_block_true_once_at_least_one_key_is_collected() -> None:
    text = "someFutureSetting=value\nselectedConfig=work\n"
    cfg, has_block = parse_preamble(text)
    assert cfg == {"selectedConfig": "work"}
    assert has_block is True


@pytest.mark.parametrize(
    "key", sorted(ALLOWED_FILE_CONFIG_KEYS - {"maxTokens", "maxThinkingTokens"})
)
def test_every_allowed_string_key_round_trips(key: str) -> None:
    cfg, has_block = parse_preamble(f"{key}=some-value\n")
    assert cfg == {key: "some-value"}
    assert has_block is True
