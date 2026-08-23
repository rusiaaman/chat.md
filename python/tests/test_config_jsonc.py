"""Tests for chatmd.config.jsonc: comment/trailing-comma stripping without
corrupting string contents."""

from __future__ import annotations

import json

import pytest

from chatmd.config.jsonc import loads_jsonc, strip_jsonc


def test_line_comment_stripped() -> None:
    text = '{\n  "a": 1 // trailing comment\n}\n'
    assert loads_jsonc(text) == {"a": 1}


def test_line_comment_on_its_own_line() -> None:
    text = '{\n  // a leading comment\n  "a": 1\n}\n'
    assert loads_jsonc(text) == {"a": 1}


def test_block_comment_single_line() -> None:
    text = '{ "a": /* inline */ 1 }'
    assert loads_jsonc(text) == {"a": 1}


def test_block_comment_multiline_preserves_newlines() -> None:
    text = '{\n  "a": 1,\n  /* this is\n     a multi-line\n     comment */\n  "b": 2\n}\n'
    assert loads_jsonc(text) == {"a": 1, "b": 2}


def test_trailing_comma_in_object() -> None:
    text = '{ "a": 1, "b": 2, }'
    assert loads_jsonc(text) == {"a": 1, "b": 2}


def test_trailing_comma_in_array() -> None:
    text = "[1, 2, 3, ]"
    assert loads_jsonc(text) == [1, 2, 3]


def test_trailing_comma_nested() -> None:
    text = '{ "a": [1, 2, ], "b": { "c": 3, }, }'
    assert loads_jsonc(text) == {"a": [1, 2], "b": {"c": 3}}


def test_non_trailing_comma_kept() -> None:
    # A comma that is *not* immediately before a closing bracket must survive.
    text = '{ "a": 1, "b": 2 }'
    assert loads_jsonc(text) == {"a": 1, "b": 2}


def test_double_slash_inside_string_survives() -> None:
    text = '{ "url": "https://example.com/path" }'
    assert loads_jsonc(text) == {"url": "https://example.com/path"}


def test_block_comment_open_inside_string_survives() -> None:
    text = '{ "note": "see /* not a comment */ here" }'
    assert loads_jsonc(text) == {"note": "see /* not a comment */ here"}


def test_comment_looking_sequence_inside_key_survives() -> None:
    text = '{ "weird//key": 1, "weird/*key*/": 2 }'
    assert loads_jsonc(text) == {"weird//key": 1, "weird/*key*/": 2}


def test_trailing_comma_looking_sequence_inside_string_survives() -> None:
    # ',}' and ',]' inside a string must not be mistaken for a trailing comma.
    text = '{ "a": "value,}", "b": "other,]" }'
    assert loads_jsonc(text) == {"a": "value,}", "b": "other,]"}


def test_escaped_quote_inside_string() -> None:
    text = r'{ "a": "she said \"hi\" // not a comment" }'
    assert loads_jsonc(text) == {"a": 'she said "hi" // not a comment'}


def test_string_ending_in_escaped_backslash() -> None:
    # The string is `C:\path\` (ends with an escaped backslash) followed by a
    # real comment; the scanner must not think the string is still open.
    text = r'{ "path": "C:\\path\\" // comment' + "\n}"
    assert loads_jsonc(text) == {"path": "C:\\path\\"}


def test_string_ending_in_escaped_backslash_then_trailing_comma() -> None:
    text = r'{ "path": "C:\\path\\", }'
    assert loads_jsonc(text) == {"path": "C:\\path\\"}


def test_odd_number_of_escaped_backslashes_before_quote() -> None:
    # `\\\"` = one escaped backslash followed by an escaped quote -> the
    # string contains a literal backslash and a literal quote, and does NOT
    # close early.
    text = r'{ "a": "x\\\"y" }'
    assert loads_jsonc(text) == {"a": 'x\\"y'}


def test_strip_jsonc_preserves_length_and_offsets() -> None:
    text = '{\n  "a": 1, // comment\n  "b": /* x */ 2,\n}\n'
    stripped = strip_jsonc(text)
    assert len(stripped) == len(text)
    # Every newline in the source must still be a newline after stripping,
    # since line comments and block comments can span/hide them otherwise.
    assert stripped.count("\n") == text.count("\n")


def test_unterminated_block_comment_does_not_crash() -> None:
    text = '{ "a": 1 /* unterminated'
    # Malformed input just fails to parse like plain JSON would; it must not
    # raise anything other than the standard decode error.
    with pytest.raises(json.JSONDecodeError):
        loads_jsonc(text)


def test_plain_json_without_comments_unaffected() -> None:
    text = '{"a": 1, "b": [1, 2, 3], "c": {"d": true, "e": null}}'
    assert loads_jsonc(text) == json.loads(text)


def test_empty_object_and_array() -> None:
    assert loads_jsonc("{}") == {}
    assert loads_jsonc("[]") == []


def test_only_trailing_comma_in_singleton_array() -> None:
    assert loads_jsonc("[1,]") == [1]


def test_line_comment_at_end_of_file_without_trailing_newline() -> None:
    text = '{"a": 1} // trailing, no newline after'
    assert loads_jsonc(text) == {"a": 1}
