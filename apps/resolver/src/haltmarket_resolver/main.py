"""Entrypoint for the resolution worker.

Phase 0 ships a skeleton. Phase 5 implements the 5-second Polygon poll, opening-cross
preference + first-trade fallback, 15-minute refund deadline, and parimutuel payout
legs described in AGENTS.md §Phase 5.
"""

from __future__ import annotations

import sys


def run() -> int:
    """Placeholder runner. Returns 0 so CI and container health probes succeed."""
    sys.stdout.write("haltmarket-resolver: phase-0 skeleton ok\n")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(run())
