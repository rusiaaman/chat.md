"""Shared test fixtures."""

from __future__ import annotations

from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SAMPLES_DIR = REPO_ROOT / "samples"
TS_SRC_DIR = REPO_ROOT / "src"


@pytest.fixture
def samples_dir() -> Path:
    """Directory of real ``.chat.md`` files committed to this repo."""
    return SAMPLES_DIR


@pytest.fixture
def chat_dir(tmp_path: Path) -> Path:
    """An empty directory to hold a chat file and its ``cmdassets/``."""
    return tmp_path
