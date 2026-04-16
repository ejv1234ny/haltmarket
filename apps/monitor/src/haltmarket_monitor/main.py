"""Entrypoint for the halt monitor.

Phase 0 ships a skeleton that imports cleanly and exits 0. Phase 2 implements the
3-second RSS poll, dedup cache, Polygon lookup, and leader election described in
AGENTS.md §Phase 2.
"""

from __future__ import annotations

import sys


def run() -> int:
    """Placeholder runner. Returns 0 so CI and container health probes succeed."""
    sys.stdout.write("haltmarket-monitor: phase-0 skeleton ok\n")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(run())
