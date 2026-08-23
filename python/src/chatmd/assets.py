"""Asset-directory resolution and file-writing helpers.

Port of the asset-related half of ``src/utils/fileUtils.ts``
(``getAssetsDirectory`` / ``getAssetsRelativePath``, but taking the assets path as
an explicit argument instead of reading a VS Code setting) and of
``src/utils/mcpResultFormatter.ts`` (``createAssetFileName``, ``getTimestampString``,
``getFileExtensionForMimeType``, ``saveBinaryAsset``), plus the ">30 lines -> write
to a file and link it" file-writing half of ``insertToolResult`` in
``src/listener.ts`` and ``ensureChatMdGitignore``/``findGitRoot`` from
``src/extension.ts``.
"""

from __future__ import annotations

import os
import random
import re
from datetime import UTC, datetime
from pathlib import Path

from chatmd.fileio import ensure_dir, read_text, write_text

#: Line count above which a tool result is written to an asset file and linked,
#: rather than inlined into the document (mirrors listener.ts's lineCountThreshold).
TOOL_RESULT_LINE_THRESHOLD = 30

_SANITIZE_LABEL_RE = re.compile(r"[^A-Za-z0-9_-]")

_BASE36_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz"


def _random_base36(length: int = 6) -> str:
    """6 base36 chars, matching ``Math.random().toString(36).slice(2, 8)``."""
    return "".join(random.choice(_BASE36_ALPHABET) for _ in range(length))


def assets_dir(doc_dir: Path, assets_path: str = "cmdassets") -> Path:
    """Resolve the configured assets directory.

    ``~`` expands to the home directory; an absolute path is used as-is (matching
    getAssetsDirectory's early return, with no further normalization); otherwise
    it resolves relative to ``doc_dir``. Uses lexical join/normalize (like Node's
    ``path.resolve``) rather than following symlinks, since the directory may not
    exist yet.
    """
    if assets_path.startswith("~"):
        return Path(os.path.abspath(os.path.expanduser(assets_path)))
    candidate = Path(assets_path)
    if candidate.is_absolute():
        return candidate
    return Path(os.path.abspath(os.path.join(str(doc_dir), assets_path)))


def assets_relative_path(doc_dir: Path, file_name: str, assets_path: str = "cmdassets") -> str:
    """Doc-relative, forward-slash path to ``file_name`` inside the assets dir."""
    target = os.path.join(str(assets_dir(doc_dir, assets_path)), file_name)
    return os.path.relpath(target, str(doc_dir)).replace(os.sep, "/")


def timestamp_string() -> str:
    """LOCAL-time ``YYYYMMDD-HHMMSS`` stamp.

    Port of ``getTimestampString`` in mcpResultFormatter.ts, which builds the
    string from the LOCAL-time ``Date`` accessors (getFullYear/getMonth/...).
    This is deliberately distinct from the UTC stamp ``write_tool_result_file``
    uses below -- the TS source keeps the two formats separate and this port
    preserves that.
    """
    now = datetime.now()
    return now.strftime("%Y%m%d-%H%M%S")


def _utc_tool_result_stamp() -> str:
    """UTC ``YYYYMMDD-HHMMSS`` stamp, mirroring insertToolResult's inline mangling
    of ``new Date().toISOString()`` (strip ``:`` and ``-``, ``T`` -> ``-``, drop
    fractional seconds and the trailing ``Z``)."""
    now = datetime.now(UTC)
    return now.strftime("%Y%m%d-%H%M%S")


def asset_file_name(label: str, extension: str) -> str:
    """``<sanitised label>-<local stamp>-<6 random base36 chars>.<ext>``.

    Port of ``createAssetFileName``: every character outside ``[A-Za-z0-9_-]`` in
    the label becomes ``-``.
    """
    sanitized = _SANITIZE_LABEL_RE.sub("-", label)
    return f"{sanitized}-{timestamp_string()}-{_random_base36()}{extension}"


# Order matters: mirrors getFileExtensionForMimeType's if-chain, first match wins.
_MIME_EXTENSIONS: tuple[tuple[str, str], ...] = (
    ("png", ".png"),
    ("jpeg", ".jpg"),
    ("jpg", ".jpg"),
    ("gif", ".gif"),
    ("webp", ".webp"),
    ("mp3", ".mp3"),
    ("wav", ".wav"),
    ("ogg", ".ogg"),
    ("json", ".json"),
    ("xml", ".xml"),
    ("html", ".html"),
    ("pdf", ".pdf"),
    ("markdown", ".md"),
    ("plain", ".txt"),
)


def extension_for_mime_type(mime_type: str, default: str) -> str:
    """Map a MIME type to a file extension by substring match, or ``default``."""
    normalized = mime_type.lower()
    for needle, extension in _MIME_EXTENSIONS:
        if needle in normalized:
            return extension
    return default


def write_tool_result_file(
    doc_dir: Path,
    content: str,
    *,
    extension: str = ".txt",
    assets_path: str = "cmdassets",
) -> str:
    """Write a tool result to the assets dir and return its doc-relative path.

    Port of the file-writing half of ``insertToolResult``'s over-threshold branch;
    the caller decides whether to invoke this (see ``TOOL_RESULT_LINE_THRESHOLD``)
    and owns the markdown link/wrapping around the returned path.
    """
    directory = assets_dir(doc_dir, assets_path)
    ensure_dir(directory)
    file_name = f"tool-result-{_utc_tool_result_stamp()}-{_random_base36()}{extension}"
    write_text(directory / file_name, content)
    return assets_relative_path(doc_dir, file_name, assets_path)


def write_binary_asset(
    doc_dir: Path,
    data: bytes,
    mime_type: str,
    label: str,
    assets_path: str = "cmdassets",
) -> str:
    """Write decoded binary data to the assets dir; return its doc-relative path.

    Port of ``saveBinaryAsset``, minus the base64 decode -- callers here already
    hold raw bytes, and minus the markdown formatting, which is another module's
    job.
    """
    directory = assets_dir(doc_dir, assets_path)
    ensure_dir(directory)
    extension = extension_for_mime_type(mime_type, ".bin")
    file_name = asset_file_name(label, extension)
    (directory / file_name).write_bytes(data)
    return assets_relative_path(doc_dir, file_name, assets_path)


def _find_git_root(start_dir: Path) -> Path | None:
    """Walk upward from ``start_dir`` looking for a ``.git`` directory."""
    current = Path(os.path.abspath(str(start_dir)))
    while True:
        if (current / ".git").exists():
            return current
        parent = current.parent
        if parent == current:
            return None
        current = parent


def ensure_chat_md_gitignore(start_dir: Path) -> None:
    """Add ``.cmd_history/`` and ``cmdassets/`` to the repo's ``.gitignore``.

    Walks up from ``start_dir`` for a ``.git`` directory; a no-op outside a git
    repo. Never raises -- an unwritable .gitignore must not break the chat, only
    skip the convenience.
    """
    try:
        git_root = _find_git_root(start_dir)
        if git_root is None:
            return

        gitignore_path = git_root / ".gitignore"
        entries = [".cmd_history/", "cmdassets/"]

        existing = read_text(gitignore_path) or ""
        lines = re.split(r"\r?\n", existing)
        missing_entries = [
            entry for entry in entries if not any(line.strip() == entry for line in lines)
        ]
        if not missing_entries:
            return

        updated = existing
        if len(updated) > 0 and not updated.endswith("\n"):
            updated += "\n"
        if len(updated) > 0 and not updated.endswith("\n\n"):
            updated += "\n"
        updated += "# chat.md generated files\n"
        updated += "\n".join(missing_entries) + "\n"
        write_text(gitignore_path, updated)
    except OSError:
        # Unwritable .gitignore is a lost convenience, not a reason to break the chat.
        pass
