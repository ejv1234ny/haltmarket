"""Unit tests for the reason-code → halt_kind classifier."""

from __future__ import annotations

import pytest

from haltmarket_monitor.classify import (
    REASON_CODES,
    halt_kind_for_reason,
    is_supported_reason,
)


@pytest.mark.parametrize(
    ("code", "expected_kind"),
    [
        ("LUDP", "volatility"),
        ("T1", "news"),
        ("T12", "news"),
        ("H10", "regulatory"),
    ],
)
def test_supported_codes_map_to_kind(code: str, expected_kind: str) -> None:
    assert is_supported_reason(code) is True
    assert halt_kind_for_reason(code) == expected_kind


@pytest.mark.parametrize("code", ["ludp", "t1", "t12", "h10"])
def test_lowercase_codes_are_normalized(code: str) -> None:
    assert is_supported_reason(code) is True
    assert halt_kind_for_reason(code) in {"volatility", "news", "regulatory"}


@pytest.mark.parametrize("code", ["T3", "M1", "", "UNKNOWN"])
def test_unsupported_codes_rejected(code: str) -> None:
    assert is_supported_reason(code) is False
    with pytest.raises(ValueError):
        halt_kind_for_reason(code)


def test_reason_codes_frozen_set_matches_documentation() -> None:
    assert {"LUDP", "T1", "T12", "H10"} == REASON_CODES
