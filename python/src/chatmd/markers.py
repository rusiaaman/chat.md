"""Escaping block and section markers that appear inside content.

A ``.chat.md`` document is structured entirely by its ``# %%`` marker lines, so
content that happens to contain one tears the document apart: the block splits in
the wrong place, a ``<tool_result>`` wrapper loses its other half, and turns that
never happened appear in the history. That is not hypothetical — it is what
happens the moment a chat reads or writes another chat through a tool.

So anything written *into* a document is escaped by adding a percent sign, and
anything read back *out* of a block body has one removed:

    # %% user      written as   # %%% user
    # %%% user     written as   # %%%% user

Escaping the whole ladder rather than just the two-percent form is what makes it
reversible. If only ``%%`` were escaped, content that already contained
``# %%% user`` would pass through untouched and then *become* a real marker when
it was unescaped.

``unescape(escape(text)) == text`` holds for any text. The reverse deliberately
does not: a bare ``# %% user`` in a document is a real marker, and reading a block
body must never turn one into content.
"""

from __future__ import annotations

import re

#: Roles that open a top-level block.
BLOCK_ROLES = ("user", "assistant", "system", "tool_execute", "settings")
#: Roles that open a section inside an assistant block.
SECTION_ROLES = ("thinking", "text")

# Trailing whitespace is limited to spaces, tabs and a carriage return so these
# match exactly the *lines* the parser treats as markers. The parser's own regex
# ends in `\s*$`, which also swallows following newlines, but that affects where
# its match ends, not which lines count.
_TRAILING = r"([ \t\r]*)$"

_BLOCK_ESCAPABLE = re.compile(
    r"^# (%{2,}) (" + "|".join(BLOCK_ROLES) + r")" + _TRAILING,
    re.MULTILINE | re.IGNORECASE,
)
_SECTION_ESCAPABLE = re.compile(
    r"^## (%{2,}) (" + "|".join(SECTION_ROLES) + r")" + _TRAILING,
    re.MULTILINE | re.IGNORECASE,
)
# Exactly two percent signs: the third character after `%%` must be a space, so
# these match precisely the lines the parser turns into blocks -- no more.
_BLOCK_MARKER = re.compile(
    r"^# %% (" + "|".join(BLOCK_ROLES) + r")" + _TRAILING,
    re.MULTILINE | re.IGNORECASE,
)
_SECTION_MARKER = re.compile(
    r"^## %% (" + "|".join(SECTION_ROLES) + r")" + _TRAILING,
    re.MULTILINE | re.IGNORECASE,
)
_BLOCK_ESCAPED = re.compile(
    r"^# %(%{2,}) (" + "|".join(BLOCK_ROLES) + r")" + _TRAILING,
    re.MULTILINE | re.IGNORECASE,
)
_SECTION_ESCAPED = re.compile(
    r"^## %(%{2,}) (" + "|".join(SECTION_ROLES) + r")" + _TRAILING,
    re.MULTILINE | re.IGNORECASE,
)


def _add_percent(match: re.Match[str], hashes: str) -> str:
    return f"{hashes} %{match.group(1)} {match.group(2)}{match.group(3)}"


def _drop_percent(match: re.Match[str], hashes: str) -> str:
    return f"{hashes} {match.group(1)} {match.group(2)}{match.group(3)}"


def escape_markers(text: str) -> str:
    """Make marker-shaped lines safe to write into a document.

    Applied to everything the engine writes: streamed assistant text, tool
    results, and messages appended on a user's behalf.
    """
    text = _BLOCK_ESCAPABLE.sub(lambda match: _add_percent(match, "#"), text)
    return _SECTION_ESCAPABLE.sub(lambda match: _add_percent(match, "##"), text)


def unescape_markers(text: str) -> str:
    """Restore marker-shaped lines when reading a block body back out.

    Only ever applied to content *inside* a block, never to a whole document: the
    document's own markers carry two percent signs and must stay markers.
    """
    text = _BLOCK_ESCAPED.sub(lambda match: _drop_percent(match, "#"), text)
    return _SECTION_ESCAPED.sub(lambda match: _drop_percent(match, "##"), text)


def contains_marker_line(text: str) -> bool:
    """Whether `text` holds a line the parser would read as a marker.

    Strictly two percent signs: an already-escaped ``# %%% user`` is content, and
    reporting it here would mean escaped text still looked dangerous.
    """
    return bool(_BLOCK_MARKER.search(text) or _SECTION_MARKER.search(text))
