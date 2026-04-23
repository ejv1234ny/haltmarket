"""Discord webhook alerts for resolver events.

Phase 5 brief requires paging on:
  * refunds (info level)
  * settlement latency > 120s (warning)
  * SUM != 0 after a resolve (CRITICAL — page)

Delivery rules:
  * Best effort. Alerts never block or fail resolve.
  * Retry 5xx and 429 with exponential backoff (respecting Retry-After).
  * Final failure is logged, not raised.
  * Discord embeds with per-level color so the on-call eye can triage fast.
"""

from __future__ import annotations

import logging
import os
import socket
import time
from typing import Protocol

import httpx

logger = logging.getLogger(__name__)

# Colors as Discord decimal ints. Chosen for contrast on dark theme.
_COLOR_INFO = 0x3498DB      # blue
_COLOR_WARN = 0xF1C40F      # yellow
_COLOR_CRITICAL = 0xE74C3C  # red


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
    """Posts Discord webhook embeds with retry/backoff.

    Retry policy: up to ``max_attempts`` (default 3), backing off 0.5s, 1s, 2s
    on transport errors and 5xx. On 429, honors the ``Retry-After`` header or
    the JSON ``retry_after`` field (seconds), capped at ``max_backoff_s``.
    """

    def __init__(
        self,
        webhook_url: str,
        *,
        timeout_s: float = 5.0,
        max_attempts: int = 3,
        max_backoff_s: float = 10.0,
    ) -> None:
        self._url = webhook_url
        self._client = httpx.Client(timeout=timeout_s)
        self._max_attempts = max(1, max_attempts)
        self._max_backoff_s = max_backoff_s
        self._hostname = socket.gethostname()
        self._env = os.environ.get("DEPLOY_ENV", "")

    def close(self) -> None:
        self._client.close()

    def _source_suffix(self) -> str:
        bits = [b for b in (self._env, self._hostname) if b]
        return f" _(from {' · '.join(bits)})_" if bits else ""

    def _payload(self, message: str, level: str, color: int) -> dict[str, object]:
        title_prefix = {
            "info": "Resolver info",
            "warning": "Resolver warning",
            "critical": "Resolver CRITICAL",
        }[level]
        return {
            "embeds": [
                {
                    "title": title_prefix,
                    "description": f"{message}{self._source_suffix()}",
                    "color": color,
                }
            ]
        }

    def _post(self, message: str, level: str, color: int) -> None:
        payload = self._payload(message, level, color)
        headers = {
            "User-Agent": "haltmarket-resolver/1.0 (+https://haltmarket.com)",
        }
        backoff = 0.5
        for attempt in range(1, self._max_attempts + 1):
            try:
                res = self._client.post(self._url, json=payload, headers=headers)
            except httpx.HTTPError as e:
                logger.warning(
                    "discord webhook transport error attempt=%d level=%s: %s",
                    attempt,
                    level,
                    e,
                )
                if attempt >= self._max_attempts:
                    return
                time.sleep(min(backoff, self._max_backoff_s))
                backoff *= 2
                continue

            # 2xx — done.
            if res.is_success:
                return

            # 429 — honor Retry-After or body.retry_after.
            if res.status_code == 429:
                wait = self._parse_retry_after(res)
                logger.warning(
                    "discord webhook rate limited level=%s retry_after=%.2fs",
                    level,
                    wait,
                )
                if attempt >= self._max_attempts:
                    return
                time.sleep(min(wait, self._max_backoff_s))
                continue

            # 5xx — retryable server error.
            if res.status_code >= 500:
                logger.warning(
                    "discord webhook 5xx attempt=%d status=%d body=%s",
                    attempt,
                    res.status_code,
                    res.text[:300],
                )
                if attempt >= self._max_attempts:
                    return
                time.sleep(min(backoff, self._max_backoff_s))
                backoff *= 2
                continue

            # 4xx (other) — caller-side problem, don't retry.
            logger.error(
                "discord webhook non-retryable status=%d level=%s body=%s",
                res.status_code,
                level,
                res.text[:300],
            )
            return

    @staticmethod
    def _parse_retry_after(res: httpx.Response) -> float:
        header = res.headers.get("Retry-After")
        if header:
            try:
                return float(header)
            except ValueError:
                pass
        try:
            body = res.json()
            retry = body.get("retry_after")
            if isinstance(retry, (int, float)):
                # Discord returns milliseconds in JSON; header is seconds.
                # Treat values > 120 as milliseconds, everything else as seconds.
                return float(retry) / 1000.0 if retry > 120 else float(retry)
        except Exception:  # noqa: BLE001
            pass
        return 1.0

    def info(self, message: str) -> None:
        logger.info("[alert] %s", message)
        self._post(message, "info", _COLOR_INFO)

    def warn(self, message: str) -> None:
        logger.warning("[alert] %s", message)
        self._post(message, "warning", _COLOR_WARN)

    def critical(self, message: str) -> None:
        logger.error("[alert CRITICAL] %s", message)
        self._post(message, "critical", _COLOR_CRITICAL)


def build_alert_sink(webhook_url: str | None) -> AlertSink:
    if webhook_url:
        return DiscordAlertSink(webhook_url)
    return NullAlertSink()
