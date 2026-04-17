"""Nasdaq Trader trade-halt RSS feed parser.

The feed is an RSS 2.0 document whose <item> elements carry halt metadata in an
`ndaq:` namespace. We parse with xml.etree.ElementTree (stdlib) so the exact
field shape is explicit and tests can drive it via fixtures.

Shape of one item (abridged):

    <item>
      <title>AAPL - T1</title>
      <ndaq:IssueSymbol>AAPL</ndaq:IssueSymbol>
      <ndaq:ReasonCode>T1</ndaq:ReasonCode>
      <ndaq:HaltDate>04/17/2026</ndaq:HaltDate>
      <ndaq:HaltTime>14:30:00</ndaq:HaltTime>
      <ndaq:ResumptionDate>04/17/2026</ndaq:ResumptionDate>
      <ndaq:ResumptionTradeTime>14:35:00</ndaq:ResumptionTradeTime>
    </item>

Times are Eastern; we attach a fixed US/Eastern zone and convert to UTC.
"""

from __future__ import annotations

import logging
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING
from zoneinfo import ZoneInfo

from haltmarket_monitor.classify import is_supported_reason

if TYPE_CHECKING:
    from collections.abc import Iterable

logger = logging.getLogger(__name__)

NDAQ_NS = "http://www.nasdaqtrader.com/"
EASTERN = ZoneInfo("US/Eastern")


@dataclass(frozen=True)
class HaltEvent:
    """A single halt parsed from the RSS feed."""

    symbol: str
    reason_code: str
    halt_time: datetime
    halt_end_time: datetime | None


def _field(item: ET.Element, local_name: str) -> str | None:
    """Return text of `<ndaq:local_name>` inside item, or None. Also tolerates
    the field being present without the namespace prefix in certain fixtures.
    """
    for tag in (f"{{{NDAQ_NS}}}{local_name}", local_name):
        el = item.find(tag)
        if el is not None and el.text and el.text.strip():
            return el.text.strip()
    return None


def _parse_eastern(date_s: str, time_s: str) -> datetime:
    """Combine MM/DD/YYYY + HH:MM:SS (Eastern) into a UTC-aware datetime."""
    naive = datetime.strptime(f"{date_s} {time_s}", "%m/%d/%Y %H:%M:%S")
    return naive.replace(tzinfo=EASTERN)


def parse_feed(xml_bytes: bytes) -> list[HaltEvent]:
    """Parse a raw RSS payload into HaltEvents.

    Items that fail to parse or use unsupported reason codes are logged and
    skipped so a single bad entry cannot stop the poll.
    """
    root = ET.fromstring(xml_bytes)
    out: list[HaltEvent] = []
    for item in root.iter("item"):
        try:
            event = _parse_item(item)
        except Exception as e:  # noqa: BLE001 — best-effort per-item tolerance
            logger.warning("skipping malformed RSS item: %s", e)
            continue
        if event is not None:
            out.append(event)
    return out


def _parse_item(item: ET.Element) -> HaltEvent | None:
    symbol = _field(item, "IssueSymbol")
    reason_code = _field(item, "ReasonCode")
    halt_date = _field(item, "HaltDate")
    halt_time_s = _field(item, "HaltTime")
    if not (symbol and reason_code and halt_date and halt_time_s):
        return None
    if not is_supported_reason(reason_code):
        return None

    halt_time = _parse_eastern(halt_date, halt_time_s)

    resumption_date = _field(item, "ResumptionDate")
    resumption_time = _field(item, "ResumptionTradeTime")
    halt_end_time: datetime | None = None
    if resumption_date and resumption_time:
        try:
            halt_end_time = _parse_eastern(resumption_date, resumption_time)
        except ValueError:
            halt_end_time = None

    return HaltEvent(
        symbol=symbol.upper(),
        reason_code=reason_code.upper(),
        halt_time=halt_time,
        halt_end_time=halt_end_time,
    )


def count_by_kind(events: Iterable[HaltEvent]) -> dict[str, int]:
    """Small helper for metrics labelling."""
    from haltmarket_monitor.classify import halt_kind_for_reason

    counts: dict[str, int] = {}
    for ev in events:
        kind = halt_kind_for_reason(ev.reason_code)
        counts[kind] = counts.get(kind, 0) + 1
    return counts
