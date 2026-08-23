"""Filesystem primitives shared by the parser, the providers and the engine.

Port of the generic half of ``src/utils/fileUtils.ts``. Asset-directory and
tool-result handling live in :mod:`chatmd.assets` instead.
"""

from __future__ import annotations

import os
from pathlib import Path

IMAGE_EXTENSIONS = frozenset({".png", ".jpg", ".jpeg", ".gif", ".webp"})

_MIME_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
}


def resolve_file_path(file_path: str, base_dir: str | Path | None = None) -> Path:
    """Resolve a reference from a chat file: ``~``, absolute, or base-relative."""
    raw = file_path.strip()
    if raw.startswith("~"):
        return Path(os.path.expanduser(raw))
    candidate = Path(raw)
    if candidate.is_absolute():
        return candidate
    if base_dir is None:
        return candidate
    return (Path(base_dir) / candidate).resolve()


def file_exists(path: str | Path) -> bool:
    try:
        return os.access(path, os.R_OK) and Path(path).is_file()
    except OSError:
        return False


def read_text(path: str | Path) -> str | None:
    """Read UTF-8 text, or None when the file cannot be read."""
    try:
        return Path(path).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None


def read_bytes(path: str | Path) -> bytes | None:
    try:
        return Path(path).read_bytes()
    except OSError:
        return None


def write_text(path: str | Path, content: str) -> None:
    Path(path).write_text(content, encoding="utf-8")


def is_image_file(path: str | Path) -> bool:
    return Path(path).suffix.lower() in IMAGE_EXTENSIONS


def ensure_dir(path: str | Path) -> Path:
    target = Path(path)
    if target.exists() and not target.is_dir():
        raise NotADirectoryError(f"Path exists but is not a directory: {target}")
    target.mkdir(parents=True, exist_ok=True)
    return target


def get_mime_type(path: str | Path) -> str:
    return _MIME_TYPES.get(Path(path).suffix.lower(), "application/octet-stream")
