"""Tests for the attachment read cache in :mod:`chatmd.fileio`.

Parsing a document inlines every attached file, and a long agentic run reparses
the whole document on every round, so the same handful of files were being read
thousands of times. The cache is validated by ``(mtime_ns, size)``; these pin that
it is actually used, that every kind of change invalidates it, and that it stays
inside its byte budget.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from chatmd import fileio
from chatmd.fileio import clear_text_cache, read_text, read_text_cached


@pytest.fixture(autouse=True)
def _clean_cache() -> None:
    clear_text_cache()


def test_returns_the_same_content_as_an_uncached_read(tmp_path: Path) -> None:
    target = tmp_path / "a.txt"
    target.write_text("hello éè\n", encoding="utf-8")
    assert read_text_cached(target) == read_text(target)


def test_second_read_does_not_touch_the_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    target = tmp_path / "a.txt"
    target.write_text("body", encoding="utf-8")
    assert read_text_cached(target) == "body"

    monkeypatch.setattr(fileio, "read_text", lambda _path: pytest.fail("re-read a cached file"))
    assert read_text_cached(target) == "body"


def test_rewriting_with_a_different_size_invalidates(tmp_path: Path) -> None:
    target = tmp_path / "a.txt"
    target.write_text("short", encoding="utf-8")
    assert read_text_cached(target) == "short"

    target.write_text("a good deal longer", encoding="utf-8")
    assert read_text_cached(target) == "a good deal longer"


def test_rewriting_with_the_same_size_invalidates(tmp_path: Path) -> None:
    target = tmp_path / "a.txt"
    target.write_text("aaaa", encoding="utf-8")
    assert read_text_cached(target) == "aaaa"

    before = target.stat().st_mtime_ns
    target.write_text("bbbb", encoding="utf-8")
    if target.stat().st_mtime_ns == before:
        pytest.skip("filesystem mtime is too coarse to distinguish these writes")

    assert read_text_cached(target) == "bbbb"


def test_missing_file_reads_as_none_and_is_not_cached(tmp_path: Path) -> None:
    target = tmp_path / "later.txt"
    assert read_text_cached(target) is None

    target.write_text("now here", encoding="utf-8")
    assert read_text_cached(target) == "now here"


def test_deleted_file_stops_being_served_from_cache(tmp_path: Path) -> None:
    target = tmp_path / "a.txt"
    target.write_text("body", encoding="utf-8")
    assert read_text_cached(target) == "body"

    target.unlink()
    assert read_text_cached(target) is None


def test_undecodable_file_reads_as_none(tmp_path: Path) -> None:
    target = tmp_path / "a.bin"
    target.write_bytes(b"\xff\xfe\x00binary")
    assert read_text_cached(target) is None


def test_a_file_over_the_per_file_cap_is_never_cached(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(fileio, "_TEXT_CACHE_MAX_FILE_BYTES", 8)
    target = tmp_path / "big.txt"
    target.write_text("x" * 64, encoding="utf-8")

    assert read_text_cached(target) == "x" * 64
    assert Path(target) not in fileio._text_cache


def test_cache_evicts_oldest_entries_to_stay_within_its_budget(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(fileio, "_TEXT_CACHE_MAX_BYTES", 30)
    paths = []
    for index in range(5):
        target = tmp_path / f"f{index}.txt"
        target.write_text("y" * 10, encoding="utf-8")
        paths.append(target)
        read_text_cached(target)

    assert fileio._text_cache_bytes <= 30
    # The three most recent survive; the earliest were evicted.
    assert [p.name for p in fileio._text_cache] == ["f2.txt", "f3.txt", "f4.txt"]
    # Evicted entries still read correctly, just from disk.
    assert read_text_cached(paths[0]) == "y" * 10
