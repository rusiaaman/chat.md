"""Parsing the ``.env``-like configuration preamble before the first ``# %%`` marker.

Port of the inline preamble-parsing logic in TS ``parseDocument`` (``src/parser.ts``).
"""

from __future__ import annotations

import re
from typing import Any

from chatmd.config.model import ALLOWED_FILE_CONFIG_KEYS, FORBIDDEN_FILE_CONFIG_KEYS
from chatmd.errors import ForbiddenInlineConfigKey, InvalidStartContent

_KV_LINE_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$")

#: Mirrors JS `parseInt(value, 10)`: parses a leading optionally-signed integer
#: and ignores anything after it, rather than requiring the whole string to be
#: numeric the way Python's `int()` does.
_LOOSE_LEADING_INT_RE = re.compile(r"^\s*([+-]?\d+)")


def _parse_int_loose(value: str) -> int | None:
    """Port of JS `parseInt(value, 10)`, returning ``None`` where JS returns NaN."""
    match = _LOOSE_LEADING_INT_RE.match(value)
    return int(match.group(1)) if match else None


def parse_preamble(text: str) -> tuple[dict[str, Any], bool]:
    """Parse the ``key=value`` preamble that may precede the first block marker.

    Blank lines and ``#``-comment lines are allowed and ignored. Any other line
    that is not ``key=value`` raises :class:`InvalidStartContent`. A forbidden key
    (must come from the global config, never per-file) raises
    :class:`ForbiddenInlineConfigKey`. Unrecognised keys are silently ignored --
    this is where a `.chat.md` grows tolerant of settings from a newer version of
    the extension.

    Returns ``(file_config, has_configuration_block)``: the second element is
    ``True`` only once at least one key was actually collected, so a preamble that
    is blank, all comments, or all-ignored-keys reports no configuration block at
    all (matching the TS behaviour of leaving `fileConfig` undefined in that case).
    """
    cfg: dict[str, Any] = {}

    for line in re.split(r"\r?\n", text):
        trimmed = line.strip()
        if not trimmed:
            continue  # allow empty lines
        if trimmed.startswith("#"):
            continue  # allow comments

        match = _KV_LINE_RE.match(trimmed)
        if not match:
            # Non key=value content is invalid before the first block.
            raise InvalidStartContent(f"Invalid line in configuration preamble: {trimmed}")

        key = match.group(1)
        value = match.group(2).strip()

        if key in FORBIDDEN_FILE_CONFIG_KEYS:
            raise ForbiddenInlineConfigKey(key)

        # Strip an inline "# comment" for unquoted values only -- a quoted value
        # may legitimately contain a "#" character.
        if not value.startswith('"') and not value.startswith("'"):
            hash_index = value.find("#")
            if hash_index >= 0:
                value = value[:hash_index].strip()

        # Remove surrounding quotes, if the (possibly comment-stripped) value has
        # matching ones.
        if (value.startswith('"') and value.endswith('"')) or (
            value.startswith("'") and value.endswith("'")
        ):
            value = value[1:-1]

        if key not in ALLOWED_FILE_CONFIG_KEYS:
            continue

        if key in ("maxTokens", "maxThinkingTokens"):
            parsed_int = _parse_int_loose(value)
            if parsed_int is not None:
                cfg[key] = parsed_int
            # else: invalid numeric value, ignored (no error)
        else:
            cfg[key] = value

    return cfg, len(cfg) > 0
