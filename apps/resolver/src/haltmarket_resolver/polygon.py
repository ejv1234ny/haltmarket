"""Polygon trades client — fetches reopen prices for halted symbols.

Phase 5 brief §Polling loop: prefer the trade with the opening-cross
condition code; fall back to the first regular trade within a 2-minute
window after `halt_end_time`. The condition code Polygon reports for
NASDAQ opening cross is 17 (documented at
polygon.io/docs/stocks/get_v3_trades__stockticker, 'conditions' array).

The client is intentionally a thin wrapper over httpx so tests can swap
in a fake via the `TradesFetcher` Protocol without touching the network.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any, Protocol, runtime_checkable

import httpx

logger = logging.getLogger(__name__)

TRADES_URL = "https://api.polygon.io/v3/trades/{symbol}"
REQUEST_TIMEOUT_SECONDS = 5.0
# Polygon condition code for NASDAQ opening cross. See docs link above.
OPENING_CROSS_CONDITION_CODE = 17
# Condition codes that should be skipped entirely (pre-market, corrections).
EXCLUDED_CONDITION_CODES = frozenset({4, 5, 7, 8, 11, 13, 15})


@dataclass(frozen=True)
class ReopenPrice:
    """A captured reopen price + its provenance.

    `source` is one of:
      * 'polygon:opening_cross' — the preferred authoritative print
      * 'polygon:first_trade'   — fallback when no opening-cross in window
    """

    symbol: str
    price: Decimal
    traded_at: datetime
    source: str


@runtime_checkable
class TradesFetcher(Protocol):
    """Abstract the Polygon call so tests can inject fixtures."""

    def fetch_reopen(
        self,
        symbol: str,
        since: datetime,
        opening_cross_window_seconds: int,
    ) -> ReopenPrice | None: ...


class PolygonTradesClient:
    """Production Polygon client implementing TradesFetcher."""

    def __init__(
        self,
        api_key: str | None,
        timeout: float = REQUEST_TIMEOUT_SECONDS,
    ) -> None:
        self._api_key = api_key
        self._client = httpx.Client(timeout=timeout)

    def close(self) -> None:
        self._client.close()

    def fetch_reopen(
        self,
        symbol: str,
        since: datetime,
        opening_cross_window_seconds: int,
    ) -> ReopenPrice | None:
        """Return the opening-cross print if present in the first 2 min, else
        the first regular trade, else None (Polygon had no data yet).

        Swallows HTTP errors — resolver retries on next poll tick.
        """
        if not self._api_key:
            logger.warning("polygon api key not set; cannot fetch reopen for %s", symbol)
            return None

        try:
            resp = self._client.get(
                TRADES_URL.format(symbol=symbol),
                params={
                    "apiKey": self._api_key,
                    "timestamp.gte": _iso_utc(since),
                    "order": "asc",
                    "limit": 100,
                },
            )
            resp.raise_for_status()
            body = resp.json()
        except (httpx.HTTPError, ValueError) as e:
            logger.warning("polygon trades fetch failed for %s: %s", symbol, e)
            return None

        return parse_reopen_from_polygon(
            body, symbol, since, opening_cross_window_seconds
        )


def parse_reopen_from_polygon(
    body: dict[str, Any],
    symbol: str,
    since: datetime,
    opening_cross_window_seconds: int,
) -> ReopenPrice | None:
    """Pure parser — factored out so tests can drive it with fixture payloads.

    Iterates the `results` array in time-ascending order. Returns the first
    opening-cross trade whose sip_timestamp is within the
    `opening_cross_window_seconds` window after `since`. If none found and
    any regular (non-excluded-condition) trade exists in the full window,
    return it marked as first_trade fallback.
    """
    results = body.get("results") or []
    if not results:
        return None

    opening_cross_deadline_ns = _to_ns(since) + opening_cross_window_seconds * 1_000_000_000
    fallback: ReopenPrice | None = None

    for trade in results:
        ts_ns = trade.get("sip_timestamp") or trade.get("participant_timestamp")
        if ts_ns is None:
            continue
        if ts_ns < _to_ns(since):
            continue
        conditions = set(trade.get("conditions") or [])

        if OPENING_CROSS_CONDITION_CODE in conditions and ts_ns <= opening_cross_deadline_ns:
            parsed = _build_reopen_price(trade, symbol, "polygon:opening_cross")
            if parsed is not None:
                return parsed
            continue

        if fallback is None and not (conditions & EXCLUDED_CONDITION_CODES):
            parsed = _build_reopen_price(trade, symbol, "polygon:first_trade")
            if parsed is not None:
                fallback = parsed

    return fallback


def _build_reopen_price(trade: dict[str, Any], symbol: str, source: str) -> ReopenPrice | None:
    price_raw = trade.get("price")
    ts_ns = trade.get("sip_timestamp") or trade.get("participant_timestamp")
    if price_raw is None or ts_ns is None:
        return None
    try:
        price = Decimal(str(price_raw)).quantize(Decimal("0.0001"))
    except (ValueError, ArithmeticError):
        return None
    traded_at = datetime.fromtimestamp(ts_ns / 1_000_000_000, tz=UTC)
    return ReopenPrice(symbol=symbol, price=price, traded_at=traded_at, source=source)


def _iso_utc(dt: datetime) -> str:
    """Polygon accepts RFC3339 / ISO-8601 timestamps in the `timestamp.gte` filter."""
    if dt.tzinfo is None:
        raise ValueError("since must be timezone-aware")
    return dt.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _to_ns(dt: datetime) -> int:
    if dt.tzinfo is None:
        raise ValueError("datetime must be timezone-aware")
    return int(dt.timestamp() * 1_000_000_000)
