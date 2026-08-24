"""Tests for chatmd.parser.settings: the small TOML-like ``# %% settings`` format.

Port of ``parseSettingsBlock`` in TS ``src/parser.ts``. Per ``ParsedDocument``'s
docstring this result is accepted for tolerance and never consumed elsewhere in
this port, so the parser is deliberately best-effort: any error degrades to
``None`` rather than raising.
"""

from __future__ import annotations

from chatmd.parser.settings import parse_settings_block

# --------------------------------------------------------------------------- #
# Root-level key/value pairs
# --------------------------------------------------------------------------- #


def test_root_level_string_value() -> None:
    assert parse_settings_block('name = "hello"') == {"name": "hello"}


def test_root_level_single_quoted_string_value() -> None:
    assert parse_settings_block("name = 'hello'") == {"name": "hello"}


def test_root_level_bare_word_value_is_kept_as_a_string() -> None:
    # No quotes and not a recognised true/false/number literal: kept as-is.
    assert parse_settings_block("mode = auto") == {"mode": "auto"}


def test_root_level_integer_value() -> None:
    assert parse_settings_block("port = 8080") == {"port": 8080}
    assert isinstance(parse_settings_block("port = 8080")["port"], int)


def test_root_level_float_value() -> None:
    assert parse_settings_block("ratio = 3.14") == {"ratio": 3.14}


def test_root_level_negative_number() -> None:
    assert parse_settings_block("offset = -5") == {"offset": -5}


def test_root_level_hex_number() -> None:
    assert parse_settings_block("mask = 0x1F") == {"mask": 31}


def test_root_level_boolean_values() -> None:
    assert parse_settings_block("enabled = true\ndisabled = false") == {
        "enabled": True,
        "disabled": False,
    }


def test_blank_lines_and_comments_are_ignored() -> None:
    text = "\n# a comment\nname = 'x'\n\n# trailing\n"
    assert parse_settings_block(text) == {"name": "x"}


def test_a_line_matching_no_grammar_is_silently_skipped_not_an_error() -> None:
    assert parse_settings_block("this line matches nothing") == {}


def test_empty_text_yields_an_empty_dict() -> None:
    assert parse_settings_block("") == {}


# --------------------------------------------------------------------------- #
# Sections
# --------------------------------------------------------------------------- #


def test_section_header_groups_subsequent_keys() -> None:
    text = "[server]\nhost = 'localhost'\nport = 8080\n"
    assert parse_settings_block(text) == {"server": {"host": "localhost", "port": 8080}}


def test_keys_before_the_first_section_stay_at_the_root() -> None:
    text = "top = 1\n[server]\nport = 8080\n"
    assert parse_settings_block(text) == {"top": 1, "server": {"port": 8080}}


def test_multiple_sections_are_kept_separate() -> None:
    text = "[a]\nx = 1\n[b]\ny = 2\n"
    assert parse_settings_block(text) == {"a": {"x": 1}, "b": {"y": 2}}


def test_revisiting_a_section_does_not_clobber_its_earlier_keys() -> None:
    text = "[a]\nx = 1\n[b]\ny = 2\n[a]\nz = 3\n"
    assert parse_settings_block(text) == {"a": {"x": 1, "z": 3}, "b": {"y": 2}}


# --------------------------------------------------------------------------- #
# Arrays
# --------------------------------------------------------------------------- #


def test_array_of_bare_items_with_no_commas_at_all() -> None:
    # Each line is its own array item; when a line carries no trailing comma the
    # comma-stripping branch is simply never exercised (see the quirk test below).
    text = "tags = [\nalpha\nbeta\ngamma\n]\n"
    assert parse_settings_block(text) == {"tags": ["alpha", "beta", "gamma"]}


def test_array_inside_a_section() -> None:
    text = "[server]\ntags = [\nalpha\nbeta\n]\n"
    assert parse_settings_block(text) == {"server": {"tags": ["alpha", "beta"]}}


def test_array_items_with_a_trailing_comma_are_silently_dropped() -> None:
    """Documented quirk, preserved character-for-character from the TS source: none
    of the three array-item regexes can match a line containing a comma anywhere
    (the plain-value pattern is ``^([^,]*)$``, and the quoted patterns require the
    closing quote to be the line's last character). A conventionally comma-separated
    array -- every item but the last ending in ``,`` -- therefore has every item
    EXCEPT the last one silently dropped, rather than the comma being stripped off.
    This is intentionally not "fixed": doing so would change what a real settings
    block parses to."""
    text = 'tags = [\n"a",\n"b",\n"c"\n]\n'
    assert parse_settings_block(text) == {"tags": ["c"]}


def test_array_item_with_no_comma_survives_trailing_comma_strip_logic() -> None:
    # A single item with no comma anywhere in the line does match the plain
    # pattern, so the "strip a trailing comma" branch is technically reachable --
    # just never for a value that had a real comma to begin with.
    text = "tags = [\nsolo\n]\n"
    assert parse_settings_block(text) == {"tags": ["solo"]}


def test_empty_array() -> None:
    assert parse_settings_block("tags = [\n]\n") == {"tags": []}


def test_array_closes_and_returns_to_normal_key_value_parsing() -> None:
    text = "tags = [\nalpha\n]\nafter = 'value'\n"
    assert parse_settings_block(text) == {"tags": ["alpha"], "after": "value"}


def test_entering_a_new_section_exits_array_mode() -> None:
    # A malformed settings block (array never closed with "]") should not leak
    # array-mode into the next section's keys.
    text = "tags = [\nalpha\n[server]\nport = 8080\n"
    result = parse_settings_block(text)
    assert result is not None
    assert result["server"] == {"port": 8080}


# --------------------------------------------------------------------------- #
# Numbers: JS `Number()` grammar corner cases
# --------------------------------------------------------------------------- #


def test_scientific_notation_number() -> None:
    assert parse_settings_block("x = 1e3") == {"x": 1000}


def test_leading_plus_sign_number() -> None:
    assert parse_settings_block("x = +5") == {"x": 5}


def test_string_that_merely_looks_numeric_but_has_extra_characters_stays_a_string() -> None:
    assert parse_settings_block("x = 5px") == {"x": "5px"}
