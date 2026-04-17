"""Smoke test preserved from Phase 0 — run() returns 0 without DATABASE_URL."""

from __future__ import annotations

from typing import TYPE_CHECKING

from haltmarket_monitor.main import run

if TYPE_CHECKING:
    import pytest


def test_run_returns_zero_without_database_url(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DATABASE_URL", raising=False)
    assert run() == 0
