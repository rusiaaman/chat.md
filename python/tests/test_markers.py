"""Tests for marker escaping.

The vectors in ``marker_vectors.json`` are shared with the TypeScript engine: a
document written by one side has to be readable by the other, so both must escape
identically.
"""

from __future__ import annotations

import json
import random
from pathlib import Path

import pytest

from chatmd.markers import (
    BLOCK_ROLES,
    SECTION_ROLES,
    contains_marker_line,
    escape_markers,
    unescape_markers,
)
from chatmd.parser.blocks import split_blocks
from chatmd.render import split_assistant_sections

VECTORS = json.loads((Path(__file__).parent / "marker_vectors.json").read_text())["cases"]


@pytest.mark.parametrize(("raw", "escaped"), VECTORS, ids=[repr(case[0]) for case in VECTORS])
def test_shared_vectors(raw: str, escaped: str) -> None:
    assert escape_markers(raw) == escaped
    assert unescape_markers(escaped) == raw


# --------------------------------------------------------------------------- #
# The round-trip property
# --------------------------------------------------------------------------- #


def random_marker_soup(rng: random.Random) -> str:
    """Text built from the pieces most likely to break the escaping."""
    pieces = [
        "# %% ",
        "## %% ",
        "# %%% ",
        "#  %% ",
        "# ",
        "%%",
        "%",
        " ",
        "\t",
        "\r",
        "\n",
        "prose",
        *BLOCK_ROLES,
        *SECTION_ROLES,
        *(role.upper() for role in BLOCK_ROLES),
    ]
    return "".join(rng.choice(pieces) for _ in range(rng.randint(0, 40)))


def test_escaping_round_trips_for_arbitrary_text() -> None:
    """unescape(escape(x)) == x, whatever x is."""
    rng = random.Random(20260825)
    for _ in range(4000):
        text = random_marker_soup(rng)
        assert unescape_markers(escape_markers(text)) == text


def test_escaped_text_never_contains_a_marker_line() -> None:
    """The whole point: escaped content cannot split a document."""
    rng = random.Random(1234)
    for _ in range(4000):
        text = random_marker_soup(rng)
        escaped = escape_markers(text)
        assert not contains_marker_line(escaped)


def test_escaping_is_idempotent_only_in_the_sense_that_it_keeps_climbing() -> None:
    """Escaping twice adds two percent signs, and unescaping twice removes them."""
    once = escape_markers("# %% user")
    twice = escape_markers(once)
    assert twice == "# %%%% user"
    assert unescape_markers(unescape_markers(twice)) == "# %% user"


def test_a_real_marker_is_not_unescaped() -> None:
    """A document's own markers must stay markers when a block body is read."""
    assert unescape_markers("# %% user") == "# %% user"
    assert unescape_markers("## %% thinking") == "## %% thinking"


# --------------------------------------------------------------------------- #
# What escaping is for
# --------------------------------------------------------------------------- #


def test_escaped_content_does_not_split_a_document() -> None:
    other_chat = "# %% user\nWhat is 2+2?\n\n# %% assistant\n4\n"
    document = (
        "# %% user\nRead it\n\n# %% assistant\nHere:\n\n"
        "# %% tool_execute\n<tool_result>\n"
        + escape_markers(other_chat)
        + "\n</tool_result>\n"
    )
    blocks = split_blocks(document)
    assert [block.type for block in blocks] == ["user", "assistant", "tool_execute"]
    # And the body reads back as exactly what the tool returned.
    assert unescape_markers(blocks[2].raw_content).strip().startswith("<tool_result>")
    assert other_chat in unescape_markers(blocks[2].raw_content)


def test_escaped_section_markers_do_not_split_an_assistant_block() -> None:
    body = escape_markers("Here is a chat file:\n## %% thinking\nnot mine\n")
    sections = split_assistant_sections(body)
    assert len(sections) == 1
    assert sections[0].type == "text"
    assert unescape_markers(sections[0].content) == (
        "Here is a chat file:\n## %% thinking\nnot mine\n"
    )


@pytest.mark.parametrize("role", BLOCK_ROLES)
def test_every_block_role_is_escaped(role: str) -> None:
    assert escape_markers(f"# %% {role}") == f"# %%% {role}"


@pytest.mark.parametrize("role", SECTION_ROLES)
def test_every_section_role_is_escaped(role: str) -> None:
    assert escape_markers(f"## %% {role}") == f"## %%% {role}"


def test_contains_marker_line_finds_what_would_break_a_document() -> None:
    assert contains_marker_line("before\n# %% user\nafter")
    assert contains_marker_line("## %% text")
    assert not contains_marker_line("# %%% user")  # already escaped
    assert not contains_marker_line("nothing here")
