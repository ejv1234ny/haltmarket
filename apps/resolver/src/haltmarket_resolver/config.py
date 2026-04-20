"""Runtime configuration for the resolution worker.

Every knob is env-driven with a sensible default so the service is one
`uv sync && uv run haltmarket-resolver` away from running. Tests build
`Settings` directly to avoid touching os.environ.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

DEFAULT_POLL_INTERVAL_SECONDS = 5.0
DEFAULT_METRICS_PORT = 8081
# Cooldown after halt_end_time before Polygon has the opening-cross print.
# Phase 5 brief: 5 seconds.
DEFAULT_POST_REOPEN_COOLDOWN_SECONDS = 5
# Fallback window: if no opening-cross within 2 minutes of halt_end_time,
# take the first regular trade instead (Phase 5 brief step 3).
DEFAULT_OPENING_CROSS_WINDOW_SECONDS = 120
# Refund deadline: if no reopen data within 15 minutes, refund all bets.
DEFAULT_REFUND_DEADLINE_MINUTES = 15
# Extended refund deadline when a re-halt is detected (Phase 5 brief).
DEFAULT_REHALT_EXTENSION_MINUTES = 5
# int8 advisory-lock key, unique across the cluster. 'HALTMKT2' in ASCII hex.
DEFAULT_LEADER_LOCK_KEY = 0x48414C544D4B5432


@dataclass(frozen=True)
class Settings:
    database_url: str
    polygon_api_key: str | None
    poll_interval_seconds: float
    metrics_port: int
    post_reopen_cooldown_seconds: int
    opening_cross_window_seconds: int
    refund_deadline_minutes: int
    rehalt_extension_minutes: int
    leader_lock_key: int
    discord_webhook_url: str | None

    @classmethod
    def from_env(cls) -> Settings:
        database_url = os.environ.get("DATABASE_URL")
        if not database_url:
            raise RuntimeError("DATABASE_URL is required for the resolver service")
        return cls(
            database_url=database_url,
            polygon_api_key=os.environ.get("POLYGON_API_KEY") or None,
            poll_interval_seconds=float(
                os.environ.get(
                    "RESOLVER_POLL_INTERVAL_SECONDS", DEFAULT_POLL_INTERVAL_SECONDS
                )
            ),
            metrics_port=int(os.environ.get("RESOLVER_METRICS_PORT", DEFAULT_METRICS_PORT)),
            post_reopen_cooldown_seconds=int(
                os.environ.get(
                    "RESOLVER_POST_REOPEN_COOLDOWN_SECONDS",
                    DEFAULT_POST_REOPEN_COOLDOWN_SECONDS,
                )
            ),
            opening_cross_window_seconds=int(
                os.environ.get(
                    "RESOLVER_OPENING_CROSS_WINDOW_SECONDS",
                    DEFAULT_OPENING_CROSS_WINDOW_SECONDS,
                )
            ),
            refund_deadline_minutes=int(
                os.environ.get(
                    "RESOLVER_REFUND_DEADLINE_MINUTES", DEFAULT_REFUND_DEADLINE_MINUTES
                )
            ),
            rehalt_extension_minutes=int(
                os.environ.get(
                    "RESOLVER_REHALT_EXTENSION_MINUTES", DEFAULT_REHALT_EXTENSION_MINUTES
                )
            ),
            leader_lock_key=int(
                os.environ.get("RESOLVER_LEADER_LOCK_KEY", DEFAULT_LEADER_LOCK_KEY)
            ),
            discord_webhook_url=os.environ.get("DISCORD_WEBHOOK_URL") or None,
        )
