"""
HaltPredict v2 — RSS Reader

Parses NASDAQ halt/resume RSS feed.
Returns structured halt and resumption data.
Source: halt_monitor_v61.py (lines 1285-1341, 597-625)
"""

import re
import feedparser
from dataclasses import dataclass, field
from datetime import datetime
from typing import List, Tuple

from ..config import RSS_URL


@dataclass
class RssHalt:
    """A new halt detected from the RSS feed."""
    symbol: str
    halt_date: str          # MM/DD/YYYY
    halt_time: str          # HH:MM:SS
    halt_datetime: datetime
    reason_code: str        # e.g. "LUDP"
    halt_id: str            # "{symbol}_{date}_{time}" for dedup


@dataclass
class RssResumption:
    """A halt resumption detected from the RSS feed (trade time populated)."""
    symbol: str
    halt_date: str
    halt_time: str
    resumption_time: str    # HH:MM:SS from RSS field [9] (trade time)
    halt_id: str


@dataclass
class RssQuoteResumption:
    """Quote-only resumption — quoting resumed but trading has NOT yet resumed."""
    symbol: str
    halt_date: str
    halt_time: str
    quote_time: str         # HH:MM:SS from RSS field [8]
    halt_id: str


# Regex to extract <td> contents from RSS summary HTML
_TD_PATTERN = re.compile(r'<td[^>]*>([^<]*)</td>')

# Allowed reason codes — LULD volatility pauses + IPO halts only.
#   LUDP — Volatility Trading Pause (NASDAQ-listed)
#   LUDS — Volatility Trading Pause - Straddle Condition
#   IPO  — IPO first-day trading halt
# NOTE: 'M' is the Market Wide Circuit Breaker code (market-wide halt), NOT a
# single-stock LULD pause. It was incorrectly included prior to 2026-04-14 and
# caused non-LULD halts (e.g. QETH, WSO.B) to leak into the pipeline.
_LULD_REASON_CODES = {"LUDP", "LUDS", "IPO"}


def parse_rss_feed() -> Tuple[List[RssHalt], List[RssResumption], List[RssQuoteResumption]]:
    """
    Parse the NASDAQ halt RSS feed.

    Returns:
        (halts, resumptions, quote_resumptions) — separate lists.
        resumptions = trade time populated (safe to resolve).
        quote_resumptions = quote time only, no trade time (do NOT resolve).
    """
    halts = []
    resumptions = []
    quote_resumptions = []

    try:
        feed = feedparser.parse(RSS_URL)
    except Exception as e:
        print(f"  [RSS] Feed parse error: {e}")
        return halts, resumptions, quote_resumptions

    for entry in feed.entries:
        try:
            summary = entry.get('summary', '')
            matches = _TD_PATTERN.findall(summary)

            if len(matches) < 6:
                continue

            halt_date = matches[0].strip()                  # MM/DD/YYYY
            halt_time_raw = matches[1].strip()               # HH:MM:SS or HH:MM:SS.fff
            # NASDAQ now publishes halt_time with milliseconds (e.g. "08:25:00.000").
            # Strip them so all downstream IDs / parsing match the historical format.
            halt_time = halt_time_raw.split('.')[0]
            symbol = matches[2].strip()
            reason_code = matches[5].strip()

            # Filter to LULD volatility pauses (LUDP, LUDS, IPO)
            if reason_code not in _LULD_REASON_CODES:
                continue

            halt_id = f"{symbol}_{halt_date}_{halt_time}"

            # Field [8] = Resumption Quote Time (quoting resumes, NOT trading)
            # Field [9] = Resumption Trade Time (trading resumes — THIS is the real end)
            # Only resolve on TRADE resumption, never on quote-only
            resumption_quote_raw = matches[8].strip() if len(matches) >= 9 else ""
            resumption_trade_raw = matches[9].strip() if len(matches) >= 10 else ""
            quote_time = resumption_quote_raw.split('.')[0] if resumption_quote_raw else ""
            trade_time = resumption_trade_raw.split('.')[0] if resumption_trade_raw else ""

            # Diagnostic: surface what NASDAQ is actually publishing in the
            # resumption fields. Helps debug cases where trade_time never
            # populates despite NASDAQ showing a resume on the public page.
            if quote_time or trade_time:
                print(f"[RSS] {symbol} field[8]={quote_time!r} field[9]={trade_time!r}")

            if trade_time:
                # Trade has resumed — safe to resolve
                resumptions.append(RssResumption(
                    symbol=symbol,
                    halt_date=halt_date,
                    halt_time=halt_time,
                    resumption_time=trade_time,
                    halt_id=halt_id,
                ))
            elif quote_time:
                # Quote only — do NOT resolve, just log
                quote_resumptions.append(RssQuoteResumption(
                    symbol=symbol,
                    halt_date=halt_date,
                    halt_time=halt_time,
                    quote_time=quote_time,
                    halt_id=halt_id,
                ))

            datetime_str = f"{halt_date} {halt_time}"
            halt_datetime = datetime.strptime(datetime_str, "%m/%d/%Y %H:%M:%S")

            halts.append(RssHalt(
                symbol=symbol,
                halt_date=halt_date,
                halt_time=halt_time,
                halt_datetime=halt_datetime,
                reason_code=reason_code,
                halt_id=halt_id,
            ))

        except Exception as e:
            # Don't silently swallow — log so future format changes are visible
            print(f"  [RSS] parse error: {type(e).__name__}: {e}")
            continue

    return halts, resumptions, quote_resumptions
