"""Reason-code → halt_kind classifier.

Mirrors supabase/migrations/0002_halts.sql::halt_kind_for_reason so the monitor
can attach halt_kind metadata for logging/metrics without round-tripping to DB.
The DB remains the source of truth via the stored generated column.
"""

from __future__ import annotations

from typing import Final

REASON_CODES: Final[frozenset[str]] = frozenset({"LUDP", "T1", "T12", "H10"})

_KIND_FOR_REASON: Final[dict[str, str]] = {
    "LUDP": "volatility",
    "T1": "news",
    "T12": "news",
    "H10": "regulatory",
}


def is_supported_reason(code: str) -> bool:
    """True when `code` is one of the halt reasons haltmarket runs markets for."""
    return code.upper() in REASON_CODES


def halt_kind_for_reason(code: str) -> str:
    """Classify a reason code into a halt_kind label.

    Raises ValueError for unsupported codes so callers fail loudly rather than
    inserting a misclassified halt.
    """
    normalized = code.upper()
    try:
        return _KIND_FOR_REASON[normalized]
    except KeyError as e:
        raise ValueError(f"unsupported reason code: {code!r}") from e
