"""Parsing of the ``# %% settings`` block: a small TOML-like format.

Port of ``parseSettingsBlock`` in ``src/parser.ts``. Per ``ParsedDocument``'s
docstring the result is accepted for tolerance and never consumed elsewhere in
this port, so this stays a deliberately best-effort parser: any error returns
``None`` rather than raising, exactly like the TS ``try``/``catch``.

The array-item regexes below are ported character for character, including a
quirk they carry: none of the three patterns tried for an array item can match a
line containing a comma anywhere (`[^,]*$` requires *no* comma before the end of
the line, and the quoted-string patterns require the closing quote to be the very
last character). So the "strip a trailing comma" logic just below is reachable
only for a value that itself contains no comma -- i.e. never actually strips
anything. This is preserved as-is rather than "fixed", since a fix would silently
change what a real ``settings`` block parses to.
"""

from __future__ import annotations

import re
from typing import Any

_SECTION_RE = re.compile(r"^\[([^\]]+)\]$")
_ARRAY_START_RE = re.compile(r"^[\w\-_]+ *= *\[$")
_ARRAY_KEY_RE = re.compile(r"^([\w\-_]+) *= *\[$")
_ARRAY_ITEM_DQUOTE_RE = re.compile(r'^"([^"]*)"$')
_ARRAY_ITEM_SQUOTE_RE = re.compile(r"^'([^']*)'$")
_ARRAY_ITEM_PLAIN_RE = re.compile(r"^([^,]*)$")
_KV_RE = re.compile(r"^([\w\-_]+) *= *(.+)$")
_DQUOTE_STRING_RE = re.compile(r'^".*"$')
_SQUOTE_STRING_RE = re.compile(r"^'.*'$")

# JS `Number()` grammar, decimal/hex forms only -- the forms a settings value is
# realistically written in. Octal/binary literal prefixes and exotic whitespace
# are not reproduced.
_DECIMAL_NUMBER_RE = re.compile(r"^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$")
_HEX_NUMBER_RE = re.compile(r"^0[xX][0-9a-fA-F]+$")


def _js_number(value: str) -> float | None:
    """Approximates JS `Number(value)`. Returns ``None`` where JS produces NaN."""
    stripped = value.strip()
    if stripped == "":
        return 0.0  # JS `Number("")` is 0, not NaN.
    if stripped in ("Infinity", "+Infinity"):
        return float("inf")
    if stripped == "-Infinity":
        return float("-inf")
    if _HEX_NUMBER_RE.match(stripped):
        return float(int(stripped, 16))
    if _DECIMAL_NUMBER_RE.match(stripped):
        return float(stripped)
    return None


def parse_settings_block(settings_text: str) -> dict[str, Any] | None:
    """Parse a ``# %% settings`` block's text, or ``None`` on any parse error."""
    try:
        settings: dict[str, Any] = {}
        current_section = ""
        current_array: list[Any] | None = None
        current_array_key = ""

        for line in settings_text.split("\n"):
            trimmed = line.strip()

            if trimmed == "" or trimmed.startswith("#"):
                continue

            section_match = _SECTION_RE.match(trimmed)
            if section_match:
                current_section = section_match.group(1)
                if not settings.get(current_section):
                    settings[current_section] = {}
                current_array = None  # Exit array mode when entering a new section
                continue

            if _ARRAY_START_RE.match(trimmed):
                key_match = _ARRAY_KEY_RE.match(trimmed)
                if key_match:
                    current_array_key = key_match.group(1)
                    current_array = []
                    if current_section:
                        settings[current_section][current_array_key] = current_array
                    else:
                        settings[current_array_key] = current_array
                continue

            if trimmed == "]" and current_array is not None:
                current_array = None
                continue

            if current_array is not None:
                value_match = (
                    _ARRAY_ITEM_DQUOTE_RE.match(trimmed)
                    or _ARRAY_ITEM_SQUOTE_RE.match(trimmed)
                    or _ARRAY_ITEM_PLAIN_RE.match(trimmed)
                )
                if value_match:
                    item_value = value_match.group(1).strip()
                    if item_value.endswith(","):
                        current_array.append(item_value[:-1].strip())
                    else:
                        current_array.append(item_value.strip())
                continue

            kv_match = _KV_RE.match(trimmed)
            if kv_match:
                key = kv_match.group(1).strip()
                raw_value = kv_match.group(2).strip()
                value: Any = raw_value

                if _DQUOTE_STRING_RE.match(raw_value) or _SQUOTE_STRING_RE.match(raw_value):
                    value = raw_value[1:-1]
                elif raw_value in ("true", "false"):
                    value = raw_value == "true"
                else:
                    number = _js_number(raw_value)
                    if number is not None:
                        value = int(number) if number.is_integer() else number

                if current_section:
                    settings[current_section][key] = value
                else:
                    settings[key] = value

        return settings
    except Exception:
        # Mirrors the TS `catch (error) { log(...); return null; }`.
        return None
