"""Minimal /metrics HTTP server.

Exposes prometheus-style line-based metrics about the monitor process. We don't
pull in the prometheus_client library because a) the shape is trivial and
b) this service ships alongside a Supabase-native observability story, so the
endpoint is primarily for Railway health probes + eyeball debugging.
"""

from __future__ import annotations

import logging
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Final

logger = logging.getLogger(__name__)


class MetricsState:
    """Thread-safe in-memory counters/gauges surfaced on /metrics."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.halts_seen_total: dict[str, int] = {
            "volatility": 0,
            "news": 0,
            "regulatory": 0,
        }
        self.halts_inserted_total: dict[str, int] = {
            "volatility": 0,
            "news": 0,
            "regulatory": 0,
        }
        self.poll_cycles_total: int = 0
        self.poll_errors_total: int = 0
        self.last_poll_ms: float = 0.0
        self.last_halt_to_db_ms: float = 0.0
        self.is_leader: int = 0

    def record_seen(self, kind: str) -> None:
        with self._lock:
            self.halts_seen_total[kind] = self.halts_seen_total.get(kind, 0) + 1

    def record_inserted(self, kind: str) -> None:
        with self._lock:
            self.halts_inserted_total[kind] = self.halts_inserted_total.get(kind, 0) + 1

    def record_poll_cycle(self, duration_ms: float) -> None:
        with self._lock:
            self.poll_cycles_total += 1
            self.last_poll_ms = duration_ms

    def record_poll_error(self) -> None:
        with self._lock:
            self.poll_errors_total += 1

    def record_halt_to_db(self, ms: float) -> None:
        with self._lock:
            self.last_halt_to_db_ms = ms

    def set_leader(self, leader: bool) -> None:
        with self._lock:
            self.is_leader = 1 if leader else 0

    def render(self) -> str:
        with self._lock:
            lines: list[str] = []
            lines.append("# TYPE haltmarket_monitor_is_leader gauge")
            lines.append(f"haltmarket_monitor_is_leader {self.is_leader}")
            lines.append("# TYPE haltmarket_monitor_poll_cycles_total counter")
            lines.append(f"haltmarket_monitor_poll_cycles_total {self.poll_cycles_total}")
            lines.append("# TYPE haltmarket_monitor_poll_errors_total counter")
            lines.append(f"haltmarket_monitor_poll_errors_total {self.poll_errors_total}")
            lines.append("# TYPE haltmarket_monitor_last_poll_ms gauge")
            lines.append(f"haltmarket_monitor_last_poll_ms {self.last_poll_ms:.3f}")
            lines.append("# TYPE haltmarket_monitor_last_halt_to_db_ms gauge")
            lines.append(f"haltmarket_monitor_last_halt_to_db_ms {self.last_halt_to_db_ms:.3f}")
            lines.append("# TYPE haltmarket_monitor_halts_seen_total counter")
            for kind, n in self.halts_seen_total.items():
                lines.append(f'haltmarket_monitor_halts_seen_total{{kind="{kind}"}} {n}')
            lines.append("# TYPE haltmarket_monitor_halts_inserted_total counter")
            for kind, n in self.halts_inserted_total.items():
                lines.append(f'haltmarket_monitor_halts_inserted_total{{kind="{kind}"}} {n}')
            lines.append("")
            return "\n".join(lines)


def _make_handler(state: MetricsState) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        # Route-map so future additions don't need a giant do_GET.
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
            # Silence default BaseHTTPRequestHandler stderr spam.
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
        logger.info("metrics server listening on :%d", self._port)

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None
        if self._thread is not None:
            self._thread.join(timeout=2.0)
            self._thread = None
