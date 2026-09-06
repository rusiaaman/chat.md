"""Filesystem primitives shared by the parser, the providers and the engine.

Port of the generic half of ``src/utils/fileUtils.ts``. Asset-directory and
tool-result handling live in :mod:`chatmd.assets` instead.
"""

from __future__ import annotations

import os
from collections import OrderedDict
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


#: Attachment contents keyed by path, valid only while mtime and size are unchanged.
#:
#: Parsing a document inlines every attached file, and a long chat re-attaches the
#: same handful of files turn after turn, so one parse was doing thousands of reads
#: of a few distinct files -- and an agentic run reparses on every round. A stat is
#: far cheaper than the read and still notices an edit made outside this process.
_text_cache: "OrderedDict[Path, tuple[int, int, str]]" = OrderedDict()

_TEXT_CACHE_MAX_BYTES = 32 * 1024 * 1024
#: A file larger than this is never cached: one of them would evict everything else.
_TEXT_CACHE_MAX_FILE_BYTES = 4 * 1024 * 1024

_text_cache_bytes = 0


def clear_text_cache() -> None:
    """Drop every cached attachment. For tests, and for a long-lived daemon."""
    global _text_cache_bytes
    _text_cache.clear()
    _text_cache_bytes = 0


def read_text_cached(path: str | Path) -> str | None:
    """Read UTF-8 text, reusing the last read while the file is unchanged.

    Use this for content that is read repeatedly and only displayed or sent onward.
    Anything that must observe a write it just made should call :func:`read_text`.
    """
    global _text_cache_bytes
    key = Path(path)
    try:
        info = key.stat()
    except OSError:
        return read_text(key)
    stamp = (info.st_mtime_ns, info.st_size)

    cached = _text_cache.get(key)
    if cached is not None and cached[:2] == stamp:
        _text_cache.move_to_end(key)
        return cached[2]

    content = read_text(key)
    if content is None:
        return None

    if cached is not None:
        _text_cache_bytes -= len(cached[2])
        del _text_cache[key]
    if len(content) <= _TEXT_CACHE_MAX_FILE_BYTES:
        _text_cache[key] = (stamp[0], stamp[1], content)
        _text_cache_bytes += len(content)
        while _text_cache_bytes > _TEXT_CACHE_MAX_BYTES and _text_cache:
            _, evicted = _text_cache.popitem(last=False)
            _text_cache_bytes -= len(evicted[2])
    return content


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
