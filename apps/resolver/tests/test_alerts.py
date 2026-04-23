"""Tests for DiscordAlertSink retry/backoff + payload shape.

No network — httpx is patched via `httpx.MockTransport`.
"""

from __future__ import annotations

import httpx
import pytest

from haltmarket_resolver.alerts import (
    DiscordAlertSink,
    NullAlertSink,
    build_alert_sink,
)


def _sink_with_handler(handler, **kwargs) -> DiscordAlertSink:
    transport = httpx.MockTransport(handler)
    sink = DiscordAlertSink(
        "https://discord.test/webhook",
        timeout_s=1.0,
        **kwargs,
    )
    # Replace the real client with one wired to the mock transport.
    sink._client.close()
    sink._client = httpx.Client(transport=transport, timeout=1.0)
    return sink


def test_null_sink_is_default_when_url_missing() -> None:
    sink = build_alert_sink(None)
    assert isinstance(sink, NullAlertSink)


def test_build_returns_discord_sink_when_url_present() -> None:
    sink = build_alert_sink("https://discord.test/webhook")
    assert isinstance(sink, DiscordAlertSink)
    sink.close()


def test_info_posts_single_embed_on_happy_path() -> None:
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(204)

    sink = _sink_with_handler(handler)
    try:
        sink.info("hello world")
    finally:
        sink.close()

    assert len(calls) == 1
    body = calls[0].read()
    assert b'"embeds"' in body
    assert b"hello world" in body


def test_retries_on_5xx_and_succeeds() -> None:
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(len(calls) + 1)
        if len(calls) < 3:
            return httpx.Response(500, text="boom")
        return httpx.Response(204)

    sink = _sink_with_handler(handler, max_attempts=3, max_backoff_s=0.01)
    try:
        sink.warn("transient")
    finally:
        sink.close()

    assert len(calls) == 3


def test_gives_up_after_max_attempts_on_5xx(caplog: pytest.LogCaptureFixture) -> None:
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(503, text="unavailable")

    sink = _sink_with_handler(handler, max_attempts=2, max_backoff_s=0.01)
    try:
        sink.critical("persistent failure")
    finally:
        sink.close()

    assert len(calls) == 2


def test_429_respects_retry_after_header() -> None:
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        if len(calls) == 1:
            return httpx.Response(429, headers={"Retry-After": "0"})
        return httpx.Response(204)

    sink = _sink_with_handler(handler, max_attempts=3, max_backoff_s=0.01)
    try:
        sink.info("rate-limited")
    finally:
        sink.close()

    assert len(calls) == 2


def test_non_retryable_4xx_aborts_immediately(caplog: pytest.LogCaptureFixture) -> None:
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(400, text="bad webhook url")

    sink = _sink_with_handler(handler, max_attempts=5, max_backoff_s=0.01)
    try:
        sink.critical("won't retry")
    finally:
        sink.close()

    assert len(calls) == 1


def test_transport_error_retried() -> None:
    attempts = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        attempts["n"] += 1
        if attempts["n"] < 2:
            raise httpx.ConnectError("network")
        return httpx.Response(204)

    sink = _sink_with_handler(handler, max_attempts=3, max_backoff_s=0.01)
    try:
        sink.warn("flaky network")
    finally:
        sink.close()

    assert attempts["n"] == 2


def test_payload_color_matches_level() -> None:
    levels: list[str] = []
    colors: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        import json

        body = json.loads(request.read())
        levels.append(body["embeds"][0]["title"])
        colors.append(body["embeds"][0]["color"])
        return httpx.Response(204)

    sink = _sink_with_handler(handler)
    try:
        sink.info("a")
        sink.warn("b")
        sink.critical("c")
    finally:
        sink.close()

    assert levels == ["Resolver info", "Resolver warning", "Resolver CRITICAL"]
    # Distinct colors per level.
    assert len(set(colors)) == 3
