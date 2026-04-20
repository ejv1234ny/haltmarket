"""Unit tests for the Polygon trades parser.

Covers the five Phase 5 brief fixtures in a pure-data form — the parser
is factored out of the HTTP client so these tests don't need httpx or a
network round-trip.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

from haltmarket_resolver.polygon import (
    EXCLUDED_CONDITION_CODES,
    OPENING_CROSS_CONDITION_CODE,
    parse_reopen_from_polygon,
)

SYMBOL = "HMKT"
SINCE = datetime(2026, 4, 14, 14, 30, 0, tzinfo=UTC)


def _trade(ts_delta_seconds: float, price: float, conditions: list[int]) -> dict:
    ts_ns = int((SINCE + timedelta(seconds=ts_delta_seconds)).timestamp() * 1_000_000_000)
    return {
        "sip_timestamp": ts_ns,
        "price": price,
        "conditions": conditions,
    }


def test_opening_cross_within_window_is_preferred() -> None:
    """Fixture 1: opening-cross trade 10s after halt_end_time."""
    body = {
        "results": [
            _trade(2, 41.5, []),  # regular trade before the cross
            _trade(10, 42.87, [OPENING_CROSS_CONDITION_CODE]),
            _trade(12, 43.0, []),  # later regular trade
        ]
    }
    res = parse_reopen_from_polygon(body, SYMBOL, SINCE, opening_cross_window_seconds=120)
    assert res is not None
    assert res.price == Decimal("42.8700")
    assert res.source == "polygon:opening_cross"


def test_first_trade_fallback_when_no_cross_in_window() -> None:
    """Fixture 2: no opening-cross code, first regular trade wins."""
    body = {
        "results": [
            _trade(3, 41.79, []),
            _trade(10, 42.0, []),
        ]
    }
    res = parse_reopen_from_polygon(body, SYMBOL, SINCE, opening_cross_window_seconds=120)
    assert res is not None
    assert res.price == Decimal("41.7900")
    assert res.source == "polygon:first_trade"


def test_empty_results_returns_none() -> None:
    """Fixture 3: Polygon returns no trades yet (pre-cross silence)."""
    body = {"results": []}
    assert parse_reopen_from_polygon(body, SYMBOL, SINCE, 120) is None


def test_opening_cross_outside_window_falls_through_to_first_trade() -> None:
    """Fixture 4: opening-cross appears AFTER 2-min window → ignored."""
    body = {
        "results": [
            _trade(5, 41.5, []),
            _trade(150, 42.87, [OPENING_CROSS_CONDITION_CODE]),  # 2.5 min — out
        ]
    }
    res = parse_reopen_from_polygon(body, SYMBOL, SINCE, opening_cross_window_seconds=120)
    assert res is not None
    # Window rule: the out-of-window cross is ignored; the earlier regular
    # trade becomes the first-trade fallback.
    assert res.price == Decimal("41.5000")
    assert res.source == "polygon:first_trade"


def test_excluded_conditions_skipped_for_fallback() -> None:
    """Fixture 5: leading trade carries an excluded condition code (e.g. a
    correction). The fallback should skip it and pick the next clean one."""
    first_excluded = next(iter(EXCLUDED_CONDITION_CODES))
    body = {
        "results": [
            _trade(2, 41.0, [first_excluded]),  # skip
            _trade(5, 41.5, []),  # take this one as fallback
        ]
    }
    res = parse_reopen_from_polygon(body, SYMBOL, SINCE, opening_cross_window_seconds=120)
    assert res is not None
    assert res.price == Decimal("41.5000")
    assert res.source == "polygon:first_trade"


def test_trades_before_since_are_ignored() -> None:
    """Defensive: Polygon might return trades slightly before the filter."""
    body = {
        "results": [
            _trade(-5, 40.0, [OPENING_CROSS_CONDITION_CODE]),  # before since
            _trade(8, 42.0, [OPENING_CROSS_CONDITION_CODE]),
        ]
    }
    res = parse_reopen_from_polygon(body, SYMBOL, SINCE, 120)
    assert res is not None
    assert res.price == Decimal("42.0000")
    assert res.source == "polygon:opening_cross"


def test_malformed_trade_is_skipped_not_fatal() -> None:
    body = {
        "results": [
            {"sip_timestamp": None, "price": 42.0, "conditions": []},  # no ts
            _trade(3, 41.79, []),
        ]
    }
    res = parse_reopen_from_polygon(body, SYMBOL, SINCE, 120)
    assert res is not None
    assert res.price == Decimal("41.7900")


def test_price_rounded_to_four_decimals() -> None:
    body = {"results": [_trade(2, 42.123456, [OPENING_CROSS_CONDITION_CODE])]}
    res = parse_reopen_from_polygon(body, SYMBOL, SINCE, 120)
    assert res is not None
    assert res.price == Decimal("42.1235")  # banker's rounding to 4 dp


def test_invalid_price_falls_through_to_next_trade() -> None:
    # Polygon rarely returns a non-numeric price, but defensively we skip
    # malformed entries and pick the next valid trade rather than crashing.
    body = {
        "results": [
            {
                "sip_timestamp": int(SINCE.timestamp() * 1e9) + int(2e9),
                "price": "nope",
                "conditions": [],
            },
            _trade(5, 41.5, []),
        ]
    }
    res = parse_reopen_from_polygon(body, SYMBOL, SINCE, 120)
    assert res is not None
    assert res.price == Decimal("41.5000")
