"""Minimal /metrics endpoint for the resolver.

Exposes Prometheus-style text metrics for Railway health probes + eyeball
debugging. Mirrors the monitor's pattern so ops can reuse the same
scraping config.
"""

from __future__ import annotations

import logging
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Final

logger = logging.getLogger(__name__)


class MetricsState:
    """Thread-safe counters + gauges surfaced on /metrics."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.resolves_total: int = 0
        self.refunds_total: int = 0
        self.resolve_errors_total: int = 0
        self.polygon_empty_total: int = 0
        self.last_settlement_ms: float = 0.0
        self.max_settlement_ms: float = 0.0
        self.invariant_failures_total: int = 0
        self.is_leader: int = 0

    def record_resolve(self, settlement_ms: float) -> None:
        with self._lock:
            self.resolves_total += 1
            self.last_settlement_ms = settlement_ms
            if settlement_ms > self.max_settlement_ms:
                self.max_settlement_ms = settlement_ms

    def record_refund(self) -> None:
        with self._lock:
            self.refunds_total += 1

    def record_resolve_error(self) -> None:
        with self._lock:
            self.resolve_errors_total += 1

    def record_polygon_empty(self) -> None:
        with self._lock:
            self.polygon_empty_total += 1

    def record_invariant_failure(self) -> None:
        with self._lock:
            self.invariant_failures_total += 1

    def set_leader(self, leader: bool) -> None:
        with self._lock:
            self.is_leader = 1 if leader else 0

    def render(self) -> str:
        with self._lock:
            return "\n".join(
                (
                    "# TYPE haltmarket_resolver_is_leader gauge",
                    f"haltmarket_resolver_is_leader {self.is_leader}",
                    "# TYPE haltmarket_resolver_resolves_total counter",
                    f"haltmarket_resolver_resolves_total {self.resolves_total}",
                    "# TYPE haltmarket_resolver_refunds_total counter",
                    f"haltmarket_resolver_refunds_total {self.refunds_total}",
                    "# TYPE haltmarket_resolver_resolve_errors_total counter",
                    f"haltmarket_resolver_resolve_errors_total {self.resolve_errors_total}",
                    "# TYPE haltmarket_resolver_polygon_empty_total counter",
                    f"haltmarket_resolver_polygon_empty_total {self.polygon_empty_total}",
                    "# TYPE haltmarket_resolver_last_settlement_ms gauge",
                    f"haltmarket_resolver_last_settlement_ms {self.last_settlement_ms:.3f}",
                    "# TYPE haltmarket_resolver_max_settlement_ms gauge",
                    f"haltmarket_resolver_max_settlement_ms {self.max_settlement_ms:.3f}",
                    "# TYPE haltmarket_resolver_invariant_failures_total counter",
                    f"haltmarket_resolver_invariant_failures_total {self.invariant_failures_total}",
                    "",
                )
            )


def _make_handler(state: MetricsState) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        ROUTES: Final = {"/metrics", "/healthz"}

        def do_GET(self) -> None:  # noqa: N802 — BaseHTTPRequestHandler contract
            if self.path == "/healthz":
                self._write(200, b"ok\n", "text/plain")
                return
            if self.path == "/metrics":
                self._write(200, state.render().encode(), "text/plain; version=0.0.4")
                return
            self._write(404, b"not found\n", "text/plain")

        def log_message(self, format: str, *args: object) -> None:  # noqa: A002
            return

        def _write(self, status: int, body: bytes, content_type: str) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    return Handler


class MetricsServer:
    def __init__(self, state: MetricsState, port: int) -> None:
        self._state = state
        self._port = port
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        handler = _make_handler(self._state)
        self._server = ThreadingHTTPServer(("0.0.0.0", self._port), handler)  # noqa: S104
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        logger.info("resolver metrics server listening on :%d", self._port)

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None
        if self._thread is not None:
            self._thread.join(timeout=2.0)
            self._thread = None
