"""Storage for provider reasoning payloads.

Port of ``src/utils/thinkingMap.ts``. A document's thinking sections only carry
``qualified_model_name::hash8`` at the end of a thinking block; the payload itself
(Anthropic signature, OpenAI encrypted content, OpenRouter ``reasoning_details``,
...) lives in ``<assets_dir>/thinking_map.json``, shared by every ``.chat.md`` file
that resolves to that assets directory.

Entries are never garbage collected, and a missing or corrupt map degrades
gracefully: the thinking section is then treated as display-only raw text rather
than breaking the chat.
"""

from __future__ import annotations

import hashlib
import json
import math
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from chatmd.fileio import ensure_dir, read_text, write_text
from chatmd.types import ThinkingPayload

MAP_FILE_NAME = "thinking_map.json"


def thinking_map_path(assets_dir: Path) -> Path:
    """Absolute path of the map file inside an assets directory."""
    return assets_dir / MAP_FILE_NAME


def _format_js_number(value: float) -> str:
    """Mirror ``Number.prototype.toString()`` for the finite values a payload can hold.

    Payload fields are strings/lists/dicts in practice, so this only has to cover
    integral floats (print as ``"1"``, never ``"1.0"``) and ordinary decimals; the
    exotic exponential-notation thresholds JS uses for magnitudes beyond ~1e21 or
    below ~1e-6 are not reproduced bit-for-bit, since no such values ever reach this
    hash.
    """
    if math.isnan(value) or math.isinf(value):
        return "null"  # JSON.stringify(NaN/Infinity) -> "null"
    if value == 0:
        return "0"  # JSON.stringify(-0) -> "0", not "-0"
    if value.is_integer() and abs(value) < 1e21:
        return str(int(value))
    text = repr(value)
    if "e" in text:
        # Python pads the exponent with a leading zero (1e-07); JS never does (1e-7).
        mantissa, exponent = text.split("e")
        sign = exponent[0] if exponent[0] in "+-" else "+"
        digits = exponent.lstrip("+-").lstrip("0") or "0"
        text = f"{mantissa}e{sign}{digits}"
    return text


def stable_stringify(value: Any) -> str:
    """Deterministic JSON matching TS ``stableStringify`` byte-for-byte.

    Object keys are sorted so the same payload always serializes (and hashes) the
    same way regardless of dict insertion order.
    """
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return _format_js_number(value)
    if isinstance(value, str):
        # ensure_ascii=False: JSON.stringify does not escape non-ASCII characters.
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        return "[" + ",".join(stable_stringify(item) for item in value) + "]"
    if isinstance(value, dict):
        # Python's default string sort is code-point order, which matches JS's
        # UTF-16 code-unit order for every key this package ever produces (all
        # ASCII); it only diverges for keys containing astral-plane characters.
        keys = sorted(value.keys())
        parts = [
            json.dumps(key, ensure_ascii=False) + ":" + stable_stringify(value[key]) for key in keys
        ]
        return "{" + ",".join(parts) + "}"
    # JSON.stringify(value) returning undefined (functions, symbols) falls back to
    # "null"; nothing else reaches this branch given JSON-safe payload data.
    return "null"


def compute_thinking_hash(entry: dict[str, Any]) -> str:
    """First 8 hex chars of sha256(stable_stringify(entry minus createdAt))."""
    hashable = {key: value for key, value in entry.items() if key != "createdAt"}
    digest = hashlib.sha256(stable_stringify(hashable).encode("utf-8")).hexdigest()
    return digest[:8]


def read_thinking_map(assets_dir: Path) -> dict[str, dict[str, Any]]:
    """Read ``thinking_map.json``'s entries, or ``{}`` if missing/corrupt."""
    raw = read_text(thinking_map_path(assets_dir))
    if raw is None:
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        # Corrupt or unreadable map: behave as if empty rather than breaking the chat.
        return {}
    if isinstance(parsed, dict) and isinstance(parsed.get("entries"), dict):
        return parsed["entries"]
    return {}


def _write_thinking_map(assets_dir: Path, entries: dict[str, dict[str, Any]]) -> bool:
    try:
        ensure_dir(assets_dir)
        content = json.dumps({"version": 1, "entries": entries}, indent=2)
        write_text(thinking_map_path(assets_dir), content)
        return True
    except OSError:
        return False


def put_thinking_entry(assets_dir: Path, model: str, payload: ThinkingPayload) -> str:
    """Store a payload and return its hash.

    Idempotent: the hash is derived from the payload itself, so storing the same
    payload twice under the same model is a no-op (only the first ``createdAt``
    sticks).
    """
    entry: dict[str, Any] = {**payload.to_map_dict(), "model": model, "createdAt": _now_iso()}
    entry_hash = compute_thinking_hash(entry)

    entries = read_thinking_map(assets_dir)
    if entry_hash not in entries:
        entries[entry_hash] = entry
        _write_thinking_map(assets_dir, entries)
    return entry_hash


def get_thinking_entry(assets_dir: Path, hash_: str) -> tuple[str, ThinkingPayload] | None:
    """Look up ``(model, payload)`` by hash, or ``None`` when unknown."""
    entry = read_thinking_map(assets_dir).get(hash_)
    if entry is None:
        return None
    model = entry.get("model")
    if not isinstance(model, str):
        return None
    return model, ThinkingPayload.from_map_dict(entry)


def _now_iso() -> str:
    """UTC timestamp shaped like JS ``new Date().toISOString()`` (millisecond precision)."""
    now = datetime.now(UTC)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"
