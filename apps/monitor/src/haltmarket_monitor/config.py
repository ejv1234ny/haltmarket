"""Runtime configuration, loaded from env vars.

All knobs live here so tests can build a `Settings` directly without touching
os.environ. Production runs read via `Settings.from_env()`.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

DEFAULT_RSS_URL = "https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts"
DEFAULT_POLL_INTERVAL = 3.0
DEFAULT_METRICS_PORT = 8080
# int8 value shared across the hot-standby pair. Unique within the cluster so
# it won't collide with any other advisory-lock callers.
DEFAULT_LEADER_LOCK_KEY = 0x48414C544D4B5431  # 'HALTMKT1' as ascii hex


@dataclass(frozen=True)
class Settings:
    database_url: str
    polygon_api_key: str | None
    rss_url: str
    poll_interval_seconds: float
    metrics_port: int
    leader_lock_key: int
    unresolved_refund_after_minutes: int

    @classmethod
    def from_env(cls) -> Settings:
        database_url = os.environ.get("DATABASE_URL")
        if not database_url:
            raise RuntimeError("DATABASE_URL is required for the monitor service")
        return cls(
            database_url=database_url,
            polygon_api_key=os.environ.get("POLYGON_API_KEY") or None,
            rss_url=os.environ.get("NASDAQ_HALT_RSS_URL", DEFAULT_RSS_URL),
            poll_interval_seconds=float(
                os.environ.get("MONITOR_POLL_INTERVAL_SECONDS", DEFAULT_POLL_INTERVAL)
            ),
            metrics_port=int(os.environ.get("MONITOR_METRICS_PORT", DEFAULT_METRICS_PORT)),
            leader_lock_key=int(
                os.environ.get("MONITOR_LEADER_LOCK_KEY", DEFAULT_LEADER_LOCK_KEY)
            ),
            unresolved_refund_after_minutes=int(
                os.environ.get("MONITOR_UNRESOLVED_REFUND_AFTER_MIN", "15")
            ),
        )
