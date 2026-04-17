"""Shared pytest fixtures for the monitor test suite."""

from __future__ import annotations

from pathlib import Path

import pytest

FIXTURES_DIR = Path(__file__).parent / "fixtures"


@pytest.fixture
def halts_rss_bytes() -> bytes:
    return (FIXTURES_DIR / "halts_rss.xml").read_bytes()
