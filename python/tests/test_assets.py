"""Tests for chatmd.assets."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from chatmd.assets import (
    TOOL_RESULT_LINE_THRESHOLD,
    asset_file_name,
    assets_dir,
    assets_relative_path,
    ensure_chat_md_gitignore,
    extension_for_mime_type,
    timestamp_string,
    write_binary_asset,
    write_tool_result_file,
)

_STAMP_RE = r"\d{8}-\d{6}"
_BASE36_RE = r"[0-9a-z]{6}"


# --------------------------------------------------------------------------- #
# assets_dir / assets_relative_path
# --------------------------------------------------------------------------- #


def test_assets_dir_relative_resolves_against_doc_dir(tmp_path: Path) -> None:
    doc_dir = tmp_path / "docs"
    doc_dir.mkdir()
    assert assets_dir(doc_dir, "cmdassets") == doc_dir / "cmdassets"


def test_assets_dir_default_argument_is_cmdassets(tmp_path: Path) -> None:
    doc_dir = tmp_path / "docs"
    doc_dir.mkdir()
    assert assets_dir(doc_dir) == doc_dir / "cmdassets"


def test_assets_dir_absolute_path_used_as_is(tmp_path: Path) -> None:
    doc_dir = tmp_path / "docs"
    doc_dir.mkdir()
    absolute = tmp_path / "elsewhere" / "assets"
    assert assets_dir(doc_dir, str(absolute)) == absolute


def test_assets_dir_tilde_expands_to_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    fake_home = tmp_path / "home"
    fake_home.mkdir()
    monkeypatch.setenv("HOME", str(fake_home))
    doc_dir = tmp_path / "docs"
    doc_dir.mkdir()

    result = assets_dir(doc_dir, "~/myassets")

    assert result == fake_home / "myassets"


def test_assets_relative_path_uses_forward_slashes(tmp_path: Path) -> None:
    doc_dir = tmp_path / "docs"
    doc_dir.mkdir()
    rel = assets_relative_path(doc_dir, "foo.txt", "cmdassets")
    assert rel == "cmdassets/foo.txt"


def test_assets_relative_path_with_absolute_assets_dir(tmp_path: Path) -> None:
    doc_dir = tmp_path / "docs"
    doc_dir.mkdir()
    absolute_assets = tmp_path / "shared-assets"
    rel = assets_relative_path(doc_dir, "img.png", str(absolute_assets))
    assert rel == "../shared-assets/img.png"


# --------------------------------------------------------------------------- #
# timestamp_string / asset_file_name
# --------------------------------------------------------------------------- #


def test_timestamp_string_shape() -> None:
    assert re.fullmatch(_STAMP_RE, timestamp_string())


def test_asset_file_name_shape_and_extension() -> None:
    name = asset_file_name("report", ".png")
    assert re.fullmatch(rf"report-{_STAMP_RE}-{_BASE36_RE}\.png", name)


def test_asset_file_name_sanitizes_disallowed_characters() -> None:
    name = asset_file_name("Weird Label!! (v2)", ".png")
    assert name.endswith(".png")
    assert " " not in name
    assert "!" not in name
    assert "(" not in name
    assert ")" not in name
    assert re.fullmatch(rf"[A-Za-z0-9_-]+-{_STAMP_RE}-{_BASE36_RE}\.png", name)


def test_asset_file_name_preserves_allowed_characters() -> None:
    name = asset_file_name("abcXYZ_09-report", ".txt")
    assert name.startswith("abcXYZ_09-report-")


def test_asset_file_name_is_randomized_across_calls() -> None:
    names = {asset_file_name("label", ".txt") for _ in range(20)}
    # Collisions are possible in principle but astronomically unlikely across 20 calls.
    assert len(names) == 20


# --------------------------------------------------------------------------- #
# extension_for_mime_type
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("mime_type", "expected"),
    [
        ("image/png", ".png"),
        ("image/jpeg", ".jpg"),
        ("image/jpg", ".jpg"),
        ("image/gif", ".gif"),
        ("image/webp", ".webp"),
        ("audio/mp3", ".mp3"),
        ("audio/wav", ".wav"),
        ("audio/ogg", ".ogg"),
        ("application/json", ".json"),
        ("application/xml", ".xml"),
        ("text/html", ".html"),
        ("application/pdf", ".pdf"),
        ("text/markdown", ".md"),
        ("text/plain", ".txt"),
        ("IMAGE/PNG", ".png"),  # normalized to lowercase before matching
    ],
)
def test_extension_for_mime_type_known(mime_type: str, expected: str) -> None:
    assert extension_for_mime_type(mime_type, ".bin") == expected


def test_extension_for_mime_type_falls_back_to_default() -> None:
    assert extension_for_mime_type("application/octet-stream", ".bin") == ".bin"
    assert extension_for_mime_type("application/octet-stream", ".dat") == ".dat"


# --------------------------------------------------------------------------- #
# write_tool_result_file / TOOL_RESULT_LINE_THRESHOLD
# --------------------------------------------------------------------------- #


def test_tool_result_line_threshold_is_30() -> None:
    assert TOOL_RESULT_LINE_THRESHOLD == 30


def test_write_tool_result_file_over_threshold_writes_and_returns_relative_path(
    tmp_path: Path,
) -> None:
    doc_dir = tmp_path / "docs"
    doc_dir.mkdir()
    content = "\n".join(f"line {i}" for i in range(TOOL_RESULT_LINE_THRESHOLD + 1))
    assert len(content.split("\n")) > TOOL_RESULT_LINE_THRESHOLD

    rel_path = write_tool_result_file(doc_dir, content)

    assert re.fullmatch(rf"cmdassets/tool-result-{_STAMP_RE}-{_BASE36_RE}\.txt", rel_path)
    assert (doc_dir / rel_path).read_text(encoding="utf-8") == content


def test_write_tool_result_file_under_threshold_still_writes_when_called(
    tmp_path: Path,
) -> None:
    # write_tool_result_file itself does not gate on the threshold -- the caller
    # decides whether to inline the result or call this; verify it still works
    # for short content, since the decision lives one layer up.
    doc_dir = tmp_path / "docs"
    doc_dir.mkdir()
    rel_path = write_tool_result_file(doc_dir, "short result")
    assert (doc_dir / rel_path).read_text(encoding="utf-8") == "short result"


def test_write_tool_result_file_respects_extension_for_rich_results(tmp_path: Path) -> None:
    doc_dir = tmp_path / "docs"
    doc_dir.mkdir()
    rel_path = write_tool_result_file(doc_dir, "# rich markdown", extension=".md")
    assert rel_path.endswith(".md")
    assert (doc_dir / rel_path).read_text(encoding="utf-8") == "# rich markdown"


def test_write_tool_result_file_creates_assets_dir(tmp_path: Path) -> None:
    doc_dir = tmp_path / "docs"
    doc_dir.mkdir()
    assert not (doc_dir / "cmdassets").exists()
    write_tool_result_file(doc_dir, "content")
    assert (doc_dir / "cmdassets").is_dir()


# --------------------------------------------------------------------------- #
# write_binary_asset
# --------------------------------------------------------------------------- #


def test_write_binary_asset_writes_bytes_and_maps_extension(tmp_path: Path) -> None:
    doc_dir = tmp_path / "docs"
    doc_dir.mkdir()
    data = b"\x89PNG\r\n\x1a\nrest-of-file"

    rel_path = write_binary_asset(doc_dir, data, "image/png", "screenshot")

    assert rel_path.startswith("cmdassets/screenshot-")
    assert rel_path.endswith(".png")
    assert (doc_dir / rel_path).read_bytes() == data


def test_write_binary_asset_unknown_mime_falls_back_to_bin(tmp_path: Path) -> None:
    doc_dir = tmp_path / "docs"
    doc_dir.mkdir()
    rel_path = write_binary_asset(doc_dir, b"\x00\x01", "application/x-unknown", "blob")
    assert rel_path.endswith(".bin")


def test_write_binary_asset_respects_custom_assets_path(tmp_path: Path) -> None:
    doc_dir = tmp_path / "docs"
    doc_dir.mkdir()
    rel_path = write_binary_asset(doc_dir, b"\x00", "image/gif", "img", assets_path="other-dir")
    assert rel_path.startswith("other-dir/img-")
    assert (doc_dir / "other-dir").is_dir()


# --------------------------------------------------------------------------- #
# ensure_chat_md_gitignore
# --------------------------------------------------------------------------- #


def test_ensure_chat_md_gitignore_no_git_root_is_noop(tmp_path: Path) -> None:
    target = tmp_path / "no_git" / "sub"
    target.mkdir(parents=True)

    ensure_chat_md_gitignore(target)

    assert not (target / ".gitignore").exists()
    assert not (tmp_path / "no_git" / ".gitignore").exists()
    assert not (tmp_path / ".gitignore").exists()


def test_ensure_chat_md_gitignore_creates_file_with_header(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    (repo / ".git").mkdir(parents=True)
    sub = repo / "a" / "b"
    sub.mkdir(parents=True)

    ensure_chat_md_gitignore(sub)  # walks up from a nested dir to find the git root

    gitignore = repo / ".gitignore"
    assert gitignore.exists()
    content = gitignore.read_text(encoding="utf-8")
    assert "# chat.md generated files" in content
    assert ".cmd_history/" in content
    assert "cmdassets/" in content
    # No .gitignore should appear anywhere except at the git root.
    assert not (sub / ".gitignore").exists()


def test_ensure_chat_md_gitignore_appends_missing_entries_only(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    (repo / ".git").mkdir(parents=True)
    gitignore = repo / ".gitignore"
    gitignore.write_text("node_modules/\ncmdassets/\n", encoding="utf-8")

    ensure_chat_md_gitignore(repo)

    content = gitignore.read_text(encoding="utf-8")
    assert content.startswith("node_modules/\ncmdassets/\n")
    assert content.count("cmdassets/") == 1
    assert ".cmd_history/" in content


def test_ensure_chat_md_gitignore_noop_when_all_entries_present(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    (repo / ".git").mkdir(parents=True)
    gitignore = repo / ".gitignore"
    original = "cmdassets/\n.cmd_history/\n"
    gitignore.write_text(original, encoding="utf-8")

    ensure_chat_md_gitignore(repo)

    assert gitignore.read_text(encoding="utf-8") == original


def test_ensure_chat_md_gitignore_is_idempotent(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    (repo / ".git").mkdir(parents=True)

    ensure_chat_md_gitignore(repo)
    first = (repo / ".gitignore").read_text(encoding="utf-8")
    ensure_chat_md_gitignore(repo)
    second = (repo / ".gitignore").read_text(encoding="utf-8")

    assert first == second


def test_ensure_chat_md_gitignore_never_raises_on_unwritable_path(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    (repo / ".git").mkdir(parents=True)
    # A directory where ensure_chat_md_gitignore expects to write a file: any
    # attempt to read/write it as a file raises OSError, which must be swallowed.
    (repo / ".gitignore").mkdir()

    ensure_chat_md_gitignore(repo)  # must not raise
