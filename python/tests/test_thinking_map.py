"""Tests for chatmd.thinking_map.

The hash literals in `test_compute_thinking_hash_matches_node_*` and
`test_stable_stringify_*` were produced by running a verbatim copy of
`stableStringify`/`computeThinkingHash` (from src/utils/thinkingMap.ts) under
Node v22.23.1 -- see the scratch script used during development. They lock in
byte-for-byte compatibility between the TS and Python implementations: the same
8-char hash must resolve on both sides of a .chat.md document written by either.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from chatmd.thinking_map import (
    MAP_FILE_NAME,
    compute_thinking_hash,
    get_thinking_entry,
    put_thinking_entry,
    read_thinking_map,
    stable_stringify,
    thinking_map_path,
)
from chatmd.types import ThinkingPayload

# --------------------------------------------------------------------------- #
# stable_stringify: scalars, structure, node-verified number/string formatting
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (None, "null"),
        (True, "true"),
        (False, "false"),
        (1, "1"),
        (1.0, "1"),  # JS prints 1, never 1.0
        (1.5, "1.5"),
        (1e21, "1e+21"),
        (1e-7, "1e-7"),  # not Python's default "1e-07"
        (0, "0"),
        (0.0, "0"),
        (-0.0, "0"),  # JSON.stringify(-0) -> "0"
    ],
)
def test_stable_stringify_scalars_match_node(value: object, expected: str) -> None:
    assert stable_stringify(value) == expected


def test_stable_stringify_string_escaping() -> None:
    # Node: JSON.stringify('hello\nworld\t"quoted"') -> "hello\nworld\t\"quoted\""
    raw = 'hello\nworld\t"quoted"'
    bs = "\\"
    q = '"'
    expected = q + "hello" + bs + "n" + "world" + bs + "t" + bs + q + "quoted" + bs + q + q
    assert stable_stringify(raw) == expected


def test_stable_stringify_array_preserves_order() -> None:
    assert stable_stringify([1, 2, 3]) == "[1,2,3]"


def test_stable_stringify_object_sorts_keys() -> None:
    assert stable_stringify({"b": 1, "a": 2}) == '{"a":2,"b":1}'


def test_stable_stringify_nested_object_sorts_recursively() -> None:
    value = {"z": [{"y": 2, "x": 1}], "a": "s"}
    assert stable_stringify(value) == '{"a":"s","z":[{"x":1,"y":2}]}'


# --------------------------------------------------------------------------- #
# compute_thinking_hash: node-cross-checked golden hashes for the 4 payload kinds
# --------------------------------------------------------------------------- #


def test_compute_thinking_hash_anthropic_signature() -> None:
    entry = {
        "kind": "anthropic_signature",
        "signature": "sig-abc123==",
        "model": "claude-opus-4-20250514",
        "createdAt": "2024-01-01T00:00:00.000Z",
    }
    assert compute_thinking_hash(entry) == "2f31d1c3"


def test_compute_thinking_hash_anthropic_redacted() -> None:
    entry = {
        "kind": "anthropic_redacted",
        "data": "redacted-data-blob",
        "model": "claude-sonnet-4-20250514",
        "createdAt": "2024-06-15T12:30:45.123Z",
    }
    assert compute_thinking_hash(entry) == "883bcc03"


def test_compute_thinking_hash_openai_encrypted() -> None:
    entry = {
        "kind": "openai_encrypted",
        "itemId": "rs_abc123",
        "encryptedContent": "enc-content-xyz",
        "model": "o3-mini",
        "createdAt": "2025-02-20T08:00:00.000Z",
    }
    assert compute_thinking_hash(entry) == "520e6e88"


def test_compute_thinking_hash_reasoning_details_nested_array() -> None:
    entry = {
        "kind": "reasoning_details",
        "reasoningDetails": [
            {"type": "reasoning.text", "text": "some thought", "signature": "sig1"},
            {"type": "reasoning.encrypted", "data": "blob2", "index": 1},
        ],
        "field": "reasoning_content",
        "model": "deepseek-r1",
        "createdAt": "2025-03-01T00:00:00.000Z",
    }
    assert compute_thinking_hash(entry) == "c23769cd"


def test_compute_thinking_hash_ignores_created_at() -> None:
    # Same payload/model as the anthropic_signature case above, different createdAt.
    entry = {
        "kind": "anthropic_signature",
        "signature": "sig-abc123==",
        "model": "claude-opus-4-20250514",
        "createdAt": "2099-01-01T00:00:00.000Z",
    }
    assert compute_thinking_hash(entry) == "2f31d1c3"


# --------------------------------------------------------------------------- #
# thinking_map_path
# --------------------------------------------------------------------------- #


def test_thinking_map_path(tmp_path: Path) -> None:
    assert thinking_map_path(tmp_path) == tmp_path / MAP_FILE_NAME


# --------------------------------------------------------------------------- #
# read/put/get round trips
# --------------------------------------------------------------------------- #


def test_read_thinking_map_missing_file_is_empty(tmp_path: Path) -> None:
    assert read_thinking_map(tmp_path) == {}


def test_put_and_get_round_trip_anthropic_signature(tmp_path: Path) -> None:
    payload = ThinkingPayload(kind="anthropic_signature", signature="sig-abc123==")
    hash_ = put_thinking_entry(tmp_path, "claude-opus-4-20250514", payload)

    assert hash_ == "2f31d1c3"  # node-verified, createdAt-independent

    result = get_thinking_entry(tmp_path, hash_)
    assert result is not None
    model, roundtripped = result
    assert model == "claude-opus-4-20250514"
    assert roundtripped == payload


def test_put_and_get_round_trip_reasoning_details(tmp_path: Path) -> None:
    payload = ThinkingPayload(
        kind="reasoning_details",
        reasoning_details=[
            {"type": "reasoning.text", "text": "some thought", "signature": "sig1"},
            {"type": "reasoning.encrypted", "data": "blob2", "index": 1},
        ],
        reasoning_field="reasoning_content",
    )
    hash_ = put_thinking_entry(tmp_path, "deepseek-r1", payload)

    assert hash_ == "c23769cd"

    result = get_thinking_entry(tmp_path, hash_)
    assert result is not None
    model, roundtripped = result
    assert model == "deepseek-r1"
    assert roundtripped == payload


def test_get_thinking_entry_missing_hash_returns_none(tmp_path: Path) -> None:
    assert get_thinking_entry(tmp_path, "deadbeef") is None


def test_put_thinking_entry_is_idempotent(tmp_path: Path) -> None:
    payload = ThinkingPayload(kind="anthropic_redacted", data="redacted-data-blob")

    hash_1 = put_thinking_entry(tmp_path, "claude-sonnet-4-20250514", payload)
    entries_after_first = read_thinking_map(tmp_path)
    created_at_1 = entries_after_first[hash_1]["createdAt"]

    hash_2 = put_thinking_entry(tmp_path, "claude-sonnet-4-20250514", payload)
    entries_after_second = read_thinking_map(tmp_path)

    assert hash_1 == hash_2
    assert len(entries_after_second) == 1
    # Storing the same payload twice must not touch the original entry.
    assert entries_after_second[hash_1]["createdAt"] == created_at_1


def test_put_thinking_entry_writes_expected_shape_and_indent(tmp_path: Path) -> None:
    payload = ThinkingPayload(kind="anthropic_signature", signature="sig-abc123==")
    hash_ = put_thinking_entry(tmp_path, "claude-opus-4-20250514", payload)

    raw = (tmp_path / MAP_FILE_NAME).read_text(encoding="utf-8")
    assert raw == json.dumps(json.loads(raw), indent=2)  # confirms indent=2 formatting
    parsed = json.loads(raw)
    assert parsed["version"] == 1
    assert set(parsed["entries"].keys()) == {hash_}
    entry = parsed["entries"][hash_]
    assert entry["kind"] == "anthropic_signature"
    assert entry["signature"] == "sig-abc123=="
    assert entry["model"] == "claude-opus-4-20250514"
    assert "createdAt" in entry


def test_corrupt_map_file_behaves_as_empty(tmp_path: Path) -> None:
    (tmp_path / MAP_FILE_NAME).write_text("{not valid json", encoding="utf-8")

    assert read_thinking_map(tmp_path) == {}
    assert get_thinking_entry(tmp_path, "anything") is None


def test_map_file_missing_entries_key_behaves_as_empty(tmp_path: Path) -> None:
    (tmp_path / MAP_FILE_NAME).write_text(json.dumps({"version": 1}), encoding="utf-8")
    assert read_thinking_map(tmp_path) == {}


def test_map_file_not_a_json_object_behaves_as_empty(tmp_path: Path) -> None:
    (tmp_path / MAP_FILE_NAME).write_text(json.dumps([1, 2, 3]), encoding="utf-8")
    assert read_thinking_map(tmp_path) == {}


def test_put_thinking_entry_recovers_from_corrupt_map(tmp_path: Path) -> None:
    (tmp_path / MAP_FILE_NAME).write_text("garbage", encoding="utf-8")

    payload = ThinkingPayload(kind="anthropic_signature", signature="sig-abc123==")
    hash_ = put_thinking_entry(tmp_path, "claude-opus-4-20250514", payload)

    # The corrupt file is clobbered with a fresh, valid map containing just the new entry.
    entries = read_thinking_map(tmp_path)
    assert set(entries.keys()) == {hash_}
