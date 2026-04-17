"""Polygon last-trade lookup for halt enrichment.

Best-effort: if the API key is missing or the request fails, we log and return
None so the halt row still lands in DB with last_price = NULL. Phase 5
resolution doesn't depend on this field, it's for UI ladder centering only.
"""

from __future__ import annotations

import logging
from decimal import Decimal

import httpx

logger = logging.getLogger(__name__)

LAST_TRADE_URL = "https://api.polygon.io/v2/last/trade/{symbol}"
REQUEST_TIMEOUT_SECONDS = 2.0


class PolygonClient:
    def __init__(self, api_key: str | None, timeout: float = REQUEST_TIMEOUT_SECONDS) -> None:
        self._api_key = api_key
        self._client = httpx.Client(timeout=timeout)

    def close(self) -> None:
        self._client.close()

    def last_price(self, symbol: str) -> Decimal | None:
        """Return the last trade price or None. Swallows network errors."""
        if not self._api_key:
            return None
        try:
            resp = self._client.get(
                LAST_TRADE_URL.format(symbol=symbol),
                params={"apiKey": self._api_key},
            )
            resp.raise_for_status()
            body = resp.json()
        except (httpx.HTTPError, ValueError) as e:
            logger.warning("polygon last-trade lookup failed for %s: %s", symbol, e)
            return None

        price = body.get("results", {}).get("p")
        if price is None:
            return None
        try:
            return Decimal(str(price)).quantize(Decimal("0.0001"))
        except (ValueError, ArithmeticError):
            logger.warning("polygon returned non-numeric price for %s: %r", symbol, price)
            return None
