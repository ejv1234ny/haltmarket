"""RSS fixture parsing tests — the integration-level acceptance for Phase 2."""

from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

from haltmarket_monitor.feed import count_by_kind, parse_feed

EASTERN = ZoneInfo("US/Eastern")


def test_parses_all_supported_reason_codes(halts_rss_bytes: bytes) -> None:
    events = parse_feed(halts_rss_bytes)
    codes = {e.reason_code for e in events}
    assert codes == {"LUDP", "T1", "T12", "H10"}


def test_symbols_match_fixture(halts_rss_bytes: bytes) -> None:
    events = parse_feed(halts_rss_bytes)
    by_code = {e.reason_code: e.symbol for e in events}
    assert by_code == {
        "LUDP": "HMKT",
        "T1": "ACME",
        "T12": "BIOX",
        "H10": "PENNY",
    }


def test_halt_time_is_timezone_aware(halts_rss_bytes: bytes) -> None:
    events = parse_feed(halts_rss_bytes)
    for e in events:
        assert e.halt_time.tzinfo is not None


def test_halt_time_parsed_in_eastern(halts_rss_bytes: bytes) -> None:
    events = parse_feed(halts_rss_bytes)
    ludp = next(e for e in events if e.reason_code == "LUDP")
    expected = datetime(2026, 4, 17, 10, 30, 0, tzinfo=EASTERN)
    assert ludp.halt_time == expected


def test_resumption_time_populated_when_present(halts_rss_bytes: bytes) -> None:
    events = parse_feed(halts_rss_bytes)
    ludp = next(e for e in events if e.reason_code == "LUDP")
    t1 = next(e for e in events if e.reason_code == "T1")
    assert ludp.halt_end_time == datetime(2026, 4, 17, 10, 35, 0, tzinfo=EASTERN)
    # T1 item has no resumption in the fixture
    assert t1.halt_end_time is None


def test_unsupported_reason_codes_skipped(halts_rss_bytes: bytes) -> None:
    events = parse_feed(halts_rss_bytes)
    assert all(e.reason_code in {"LUDP", "T1", "T12", "H10"} for e in events)
    # T3 item in fixture should not be emitted
    assert "T3" not in {e.reason_code for e in events}


def test_malformed_items_skipped(halts_rss_bytes: bytes) -> None:
    events = parse_feed(halts_rss_bytes)
    # Fixture has one LUDP item missing HaltTime (BADCO) — it must be dropped
    # so we get exactly 4 supported events.
    assert len(events) == 4


def test_count_by_kind_labels(halts_rss_bytes: bytes) -> None:
    events = parse_feed(halts_rss_bytes)
    counts = count_by_kind(events)
    assert counts == {"volatility": 1, "news": 2, "regulatory": 1}


def test_empty_feed_parses_to_empty_list() -> None:
    minimal = (
        b'<?xml version="1.0"?>'
        b'<rss version="2.0" xmlns:ndaq="http://www.nasdaqtrader.com/">'
        b"<channel><title>empty</title></channel></rss>"
    )
    assert parse_feed(minimal) == []
