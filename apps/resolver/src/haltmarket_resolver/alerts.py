"""Discord webhook alerts for resolver events.

Phase 5 brief requires paging on:
  * refunds (info level)
  * settlement latency > 120s (warning)
  * SUM != 0 after a resolve (CRITICAL — page)

The client is a thin wrapper around httpx so tests can swap a fake.
"""

from __future__ import annotations

import logging
from typing import Protocol

import httpx

logger = logging.getLogger(__name__)


class AlertSink(Protocol):
    def warn(self, message: str) -> None: ...
    def critical(self, message: str) -> None: ...
    def info(self, message: str) -> None: ...


class NullAlertSink:
    """Default when DISCORD_WEBHOOK_URL isn't set — logs only."""

    def warn(self, message: str) -> None:
        logger.warning("[alert] %s", message)

    def critical(self, message: str) -> None:
        logger.error("[alert CRITICAL] %s", message)

    def info(self, message: str) -> None:
        logger.info("[alert] %s", message)


class DiscordAlertSink:
    """Posts JSON `{content: ...}` to a Discord webhook URL."""

    def __init__(self, webhook_url: str, timeout: float = 3.0) -> None:
        self._url = webhook_url
        self._client = httpx.Client(timeout=timeout)

    def close(self) -> None:
        self._client.close()

    def _post(self, content: str, level: str) -> None:
        try:
            res = self._client.post(
                self._url,
                json={"content": content},
                headers={
                    "User-Agent": "haltmarket-resolver/1.0 (+https://haltmarket.com)",
                },
            )
            if not res.is_success:
                logger.warning(
                    "discord webhook returned %d: %s", res.status_code, res.text[:300]
                )
        except httpx.HTTPError as e:
            logger.warning("discord webhook failed (%s): %s", level, e)

    def info(self, message: str) -> None:
        logger.info("[alert] %s", message)
        self._post(f":information_source: {message}", "info")

    def warn(self, message: str) -> None:
        logger.warning("[alert] %s", message)
        self._post(f":warning: {message}", "warning")

    def critical(self, message: str) -> None:
        logger.error("[alert CRITICAL] %s", message)
        self._post(f":rotating_light: **CRITICAL** {message}", "critical")


def build_alert_sink(webhook_url: str | None) -> AlertSink:
    if webhook_url:
        return DiscordAlertSink(webhook_url)
    return NullAlertSink()
