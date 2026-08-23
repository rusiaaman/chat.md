"""Exceptions raised by the chat.md engine."""

from __future__ import annotations


class ChatmdError(Exception):
    """Base class for every error raised by this package."""


class InvalidStartContent(ChatmdError):
    """Content before the first ``# %%`` marker that is not ``key=value``.

    Mirrors the TypeScript ``INVALID_START_CONTENT`` error.
    """


class ForbiddenInlineConfigKey(ChatmdError):
    """A per-file preamble used a key that may only live in the global config."""

    def __init__(self, key: str) -> None:
        self.key = key
        super().__init__(
            f"Configuration key '{key}' is not allowed in .chat.md files. These keys "
            "(type, apiKey, base_url, model_name, apiConfigs) must be defined in the "
            "global config only. Use 'selectedConfig' to reference a named configuration."
        )


class ImageInSystemBlock(ChatmdError):
    """A ``# %% system`` block referenced an image, which is not supported."""


class ConfigError(ChatmdError):
    """The configuration is missing or unusable."""


class LockHeld(ChatmdError):
    """Another live process holds the lock for this chat file."""

    def __init__(self, path: str, owner: str | None = None, pid: int | None = None) -> None:
        self.path = path
        self.owner = owner
        self.pid = pid
        held_by = f" (held by {owner or 'unknown'}, pid {pid})" if owner or pid else ""
        super().__init__(f"Lock for {path} is already held{held_by}")


class StreamAborted(ChatmdError):
    """The streamer could no longer find its own text in the document."""
