"""
HaltPredict v2 — Halt Tracker

Deduplication, halt counting, price tracking, and persistence.
Source: halt_monitor_v61.py (lines 217-330, 426-458)
"""

import json
import sqlite3
import requests
from datetime import datetime, timedelta
from typing import Optional, Set
from zoneinfo import ZoneInfo

_ET = ZoneInfo("America/New_York")

from ..config import (
    DB_FILE, SEEN_HALTS_FILE, LAST_HALT_FILE,
    BACKLOG_WINDOW_MINUTES, MAX_HALT_AGE_SECONDS,
    SUPABASE_URL, get_supabase_headers,
    TRADE_THRESHOLD,
)


class HaltTracker:
    """
    Tracks halt state: deduplication, halt numbering, price history.
    Persists to disk + SQLite for restart resilience.
    On Railway (ephemeral FS), rebuilds from Supabase on startup.
    """

    def __init__(self, db_path: str = DB_FILE):
        self.db_path = db_path
        self.seen_halts: Set[str] = set()
        self.halt_counts: dict = {}          # "{symbol}_{date}" -> count
        self.last_halt_prices: dict = {}     # "{symbol}_{date}" -> price
        self.last_halt_cutoff: Optional[datetime] = None
        # Per-symbol latest halt datetime (for RSS replay detection on restart)
        self.latest_halt_by_symbol: dict = {}  # symbol -> naive datetime

    # =================================================================
    # Deduplication
    # =================================================================

    def is_new(self, halt_id: str) -> bool:
        """Check if a halt ID has NOT been seen before."""
        return halt_id not in self.seen_halts

    def mark_seen(self, halt_id: str):
        """Mark a halt ID as seen and persist to disk."""
        self.seen_halts.add(halt_id)
        self._save_seen_to_disk()

    # =================================================================
    # Halt numbering
    # =================================================================

    def _ensure_halt_count_loaded(self, symbol: str):
        """Populate halt_counts[key] from SQLite if not already cached."""
        today = datetime.now(_ET).strftime("%Y-%m-%d")
        key = f"{symbol}_{today}"
        if key not in self.halt_counts:
            count = 0
            try:
                conn = sqlite3.connect(self.db_path, timeout=5)
                cursor = conn.cursor()
                cursor.execute(
                    "SELECT COUNT(*) FROM halts WHERE symbol = ? AND halt_datetime LIKE ?",
                    (symbol, f"{today}%")
                )
                count = cursor.fetchone()[0]
                conn.close()
            except Exception:
                pass
            self.halt_counts[key] = count
        return key

    def peek_halt_number(self, symbol: str) -> int:
        """Return what the next halt_number WOULD be, without incrementing."""
        key = self._ensure_halt_count_loaded(symbol)
        return self.halt_counts[key] + 1

    def get_halt_number(self, symbol: str) -> int:
        """
        Get the next halt number for this symbol today.
        Increments the counter and returns the new value.

        On first call for a symbol, checks in-memory cache first (populated
        by rebuild_from_supabase on startup), then falls back to local SQLite.
        """
        key = self._ensure_halt_count_loaded(symbol)
        self.halt_counts[key] += 1
        return self.halt_counts[key]

    def rebuild_from_supabase(self) -> int:
        """
        Rebuild halt counts and seen_halts from Supabase for today.
        Critical for Railway where local SQLite is empty on restart.
        Returns total halt count loaded.
        """
        if not SUPABASE_URL:
            return 0

        today = datetime.now(_ET).strftime("%Y-%m-%d")
        headers = get_supabase_headers()

        try:
            # Fetch today's halts from Supabase
            url = (
                f"{SUPABASE_URL}/rest/v1/halts"
                f"?halt_datetime=gte.{today}T00:00:00"
                f"&halt_datetime=lt.{today}T23:59:59"
                f"&select=symbol,halt_datetime,halt_price,halt_number_today"
                f"&order=halt_datetime.asc"
            )
            r = requests.get(url, headers=headers, timeout=15)
            if r.status_code != 200:
                print(f"  [SUPABASE] Rebuild failed: {r.status_code} - {r.text[:100]}")
                return 0

            rows = r.json()
            if not rows:
                return 0

            # Rebuild per-symbol halt counts
            symbol_counts = {}
            for row in rows:
                sym = row.get("symbol", "")
                if not sym:
                    continue
                key = f"{sym}_{today}"
                symbol_counts[key] = symbol_counts.get(key, 0) + 1

                # Also rebuild last halt prices
                price = row.get("halt_price")
                if price:
                    self.last_halt_prices[key] = price

                # Rebuild seen_halts using halt_id format: {symbol}-{date}-{halt_number}
                halt_num = row.get("halt_number_today") or symbol_counts[key]
                halt_id = f"{sym}-{today}-{halt_num}"
                self.seen_halts.add(halt_id)

                # Track latest halt datetime per symbol — used to detect RSS replays
                halt_dt = row.get("halt_datetime", "")
                if halt_dt:
                    try:
                        dt = datetime.strptime(halt_dt.replace('T', ' ')[:19], "%Y-%m-%d %H:%M:%S")
                        prev = self.latest_halt_by_symbol.get(sym)
                        if not prev or dt > prev:
                            self.latest_halt_by_symbol[sym] = dt
                    except Exception:
                        pass

            self.halt_counts.update(symbol_counts)
            total = sum(symbol_counts.values())

            # Set cutoff to latest halt loaded — prevents reprocessing on restart
            # and ensures new halts (after this timestamp) are detected correctly.
            last_dt = rows[-1].get("halt_datetime", "") if rows else ""
            if last_dt:
                try:
                    latest = datetime.strptime(last_dt.replace('T', ' ')[:19], "%Y-%m-%d %H:%M:%S")
                    self.last_halt_cutoff = latest
                    print(f"  [SUPABASE] Cutoff set to latest halt: {latest}")
                except Exception:
                    pass

            print(f"  [SUPABASE] Rebuilt {total} halts for {len(symbol_counts)} symbols from Supabase")
            return total

        except Exception as e:
            print(f"  [SUPABASE] Rebuild error: {e}")
            return 0

    def rebuild_pending_trades_from_supabase(self) -> dict:
        """
        Reconstitute the in-flight trade queue from Supabase after a restart.

        Returns a dict {symbol: halt_data} of today's TRADE-rec halts that:
          - have prediction_score >= TRADE_THRESHOLD
          - have prediction_recommendation = 'TRADE'
          - have NOT been resumed yet (reopen_price IS NULL)
          - are still within MAX_HALT_AGE_SECONDS (otherwise stale, won't trade)

        Without this, every Railway container restart wipes pending_trades
        (an in-memory dict) and orphans all in-flight trades. Halts that were
        queued by the previous container can never trade because the new
        container's pending_trades is empty when their resumption fires.

        Called from monitor.main() startup right after rebuild_from_supabase().
        """
        if not SUPABASE_URL:
            return {}

        et_now = datetime.now(_ET)
        today = et_now.strftime("%Y-%m-%d")
        # Halts older than this are stale and would be blocked anyway
        cutoff_dt = et_now - timedelta(seconds=MAX_HALT_AGE_SECONDS)
        cutoff_str = cutoff_dt.strftime("%Y-%m-%dT%H:%M:%S")

        headers = get_supabase_headers()

        try:
            url = (
                f"{SUPABASE_URL}/rest/v1/halts"
                f"?halt_datetime=gte.{cutoff_str}"
                f"&prediction_recommendation=eq.TRADE"
                f"&prediction_score=gte.{TRADE_THRESHOLD}"
                f"&reopen_price=is.null"
                f"&select=symbol,halt_datetime,halt_price,halt_number_today,"
                f"prediction_score,prediction_recommendation,pct_5min_before,"
                f"momentum_15min,momentum_30min,volume_at_halt,dna_cascade_rate,"
                f"matrix_up_rate,v61_scoring_method,ai_prediction,ai_confidence"
                f"&order=halt_datetime.desc"
            )
            r = requests.get(url, headers=headers, timeout=15)
            if r.status_code != 200:
                print(f"  [SUPABASE] Pending-trades rebuild failed: {r.status_code} - {r.text[:200]}")
                return {}

            rows = r.json()
            recovered = {}
            for row in rows:
                sym = row.get("symbol", "")
                if not sym:
                    continue
                # Only one in-flight trade per symbol; the most recent halt wins
                # (rows are ordered halt_datetime.desc, so first occurrence is newest)
                if sym in recovered:
                    continue
                halt_data = dict(row)
                # The monitor's process_halt() also stores 'score' and 'recommendation'
                # at the top level for the trade execution path
                halt_data["score"] = row.get("prediction_score")
                halt_data["recommendation"] = row.get("prediction_recommendation")
                recovered[sym] = halt_data

            if recovered:
                print(f"  [SUPABASE] Recovered {len(recovered)} pending TRADE-rec halts: {list(recovered.keys())[:10]}")
            else:
                print(f"  [SUPABASE] No pending trades to recover (since {cutoff_str} ET)")
            return recovered

        except Exception as e:
            print(f"  [SUPABASE] Pending-trades rebuild error: {e}")
            return {}

    def backfill_todays_pending_trades(self) -> dict:
        """
        Backfill pending_trades with ANY of today's halts that are eligible to
        trade but were missed (e.g. fired while ENABLE_TRADING=False, or before
        the bot was fully armed). Unlike rebuild_pending_trades_from_supabase,
        this widens the window to the full trading day rather than only the
        MAX_HALT_AGE_SECONDS stale window — stale halts will still be blocked
        at execution time by is_halt_stale(), but any halt that resumes late
        (still within the stale window when it reopens) becomes tradeable.

        Filters: today's halts, prediction_recommendation = 'TRADE',
        prediction_score >= TRADE_THRESHOLD, reopen_price IS NULL (unresolved).

        Called from monitor.main() startup when ENABLE_TRADING=True.
        """
        if not SUPABASE_URL:
            return {}

        et_now = datetime.now(_ET)
        today_start = et_now.strftime("%Y-%m-%dT00:00:00")

        headers = get_supabase_headers()
        try:
            url = (
                f"{SUPABASE_URL}/rest/v1/halts"
                f"?halt_datetime=gte.{today_start}"
                f"&prediction_recommendation=eq.TRADE"
                f"&prediction_score=gte.{TRADE_THRESHOLD}"
                f"&reopen_price=is.null"
                f"&select=symbol,halt_datetime,halt_price,halt_number_today,"
                f"prediction_score,prediction_recommendation,pct_5min_before,"
                f"momentum_15min,momentum_30min,volume_at_halt,dna_cascade_rate,"
                f"matrix_up_rate,v61_scoring_method,ai_prediction,ai_confidence"
                f"&order=halt_datetime.desc"
            )
            r = requests.get(url, headers=headers, timeout=15)
            if r.status_code != 200:
                print(f"  [SUPABASE] Backfill pending-trades failed: {r.status_code} - {r.text[:200]}")
                return {}

            recovered = {}
            for row in r.json():
                sym = row.get("symbol", "")
                if not sym or sym in recovered:
                    continue
                halt_data = dict(row)
                halt_data["score"] = row.get("prediction_score")
                halt_data["recommendation"] = row.get("prediction_recommendation")
                recovered[sym] = halt_data
                print(f"  [BACKFILL] {sym} score={halt_data['score']} halt_dt={row.get('halt_datetime')} halt_price={row.get('halt_price')}")

            if recovered:
                print(f"  [SUPABASE] Backfilled {len(recovered)} eligible pending TRADE halts for today: {list(recovered.keys())[:10]}")
            else:
                print(f"  [SUPABASE] No eligible pending TRADE halts to backfill for today")
            return recovered

        except Exception as e:
            print(f"  [SUPABASE] Backfill pending-trades error: {e}")
            return {}

    def lookup_pending_halt(self, symbol: str) -> Optional[dict]:
        """Look up ANY unresolved halt for `symbol` today (regardless of score
        or recommendation). Used by handle_rss_resumptions() to recover halts
        that were detected by a prior container but whose in-memory
        pending_halts entry was wiped by a restart. Returns halt_data dict or
        None if no unresolved halt found.
        """
        if not SUPABASE_URL:
            return None
        today = datetime.now(_ET).strftime("%Y-%m-%d")
        headers = get_supabase_headers()
        try:
            url = (
                f"{SUPABASE_URL}/rest/v1/halts"
                f"?symbol=eq.{symbol}"
                f"&halt_datetime=gte.{today}T00:00:00"
                f"&reopen_price=is.null"
                f"&select=*"
                f"&order=halt_datetime.desc&limit=1"
            )
            r = requests.get(url, headers=headers, timeout=10)
            if r.status_code != 200 or not r.json():
                return None
            row = r.json()[0]
            halt_data = dict(row)
            halt_data["score"] = row.get("prediction_score")
            halt_data["recommendation"] = row.get("prediction_recommendation")
            return halt_data
        except Exception as e:
            print(f"  [SUPABASE] lookup_pending_halt error for {symbol}: {e}")
            return None

    def lookup_tradeable_halt(self, symbol: str) -> Optional[dict]:
        """Look up a single halt in Supabase that's eligible for trading right now.

        Used as a runtime fallback by _try_execute_pending_trade() when the
        symbol isn't in the in-memory pending_trades dict (e.g. because a
        container restart wiped it). Returns the halt_data dict ready for
        trader.handle_new_halt(), or None if no eligible halt found.
        """
        if not SUPABASE_URL:
            return None

        et_now = datetime.now(_ET)
        cutoff_dt = et_now - timedelta(seconds=MAX_HALT_AGE_SECONDS)
        cutoff_str = cutoff_dt.strftime("%Y-%m-%dT%H:%M:%S")

        headers = get_supabase_headers()
        try:
            url = (
                f"{SUPABASE_URL}/rest/v1/halts"
                f"?symbol=eq.{symbol}"
                f"&halt_datetime=gte.{cutoff_str}"
                f"&prediction_recommendation=eq.TRADE"
                f"&prediction_score=gte.{TRADE_THRESHOLD}"
                f"&reopen_price=is.null"
                f"&select=*"
                f"&order=halt_datetime.desc&limit=1"
            )
            r = requests.get(url, headers=headers, timeout=10)
            if r.status_code != 200 or not r.json():
                return None
            row = r.json()[0]
            halt_data = dict(row)
            halt_data["score"] = row.get("prediction_score")
            halt_data["recommendation"] = row.get("prediction_recommendation")
            return halt_data
        except Exception:
            return None

    # =================================================================
    # Price tracking (for differential calc)
    # =================================================================

    def get_last_halt_price(self, symbol: str) -> Optional[float]:
        """Get price from previous halt today for differential calculation."""
        today = datetime.now(_ET).strftime("%Y-%m-%d")
        key = f"{symbol}_{today}"
        return self.last_halt_prices.get(key)

    def set_last_halt_price(self, symbol: str, price: float):
        """Store halt price for next halt's differential calculation."""
        today = datetime.now(_ET).strftime("%Y-%m-%d")
        key = f"{symbol}_{today}"
        self.last_halt_prices[key] = price

    # =================================================================
    # Stale halt check
    # =================================================================

    def is_halt_stale(self, halt_datetime_str: str) -> bool:
        """Check if a halt is too old to trade (> MAX_HALT_AGE_SECONDS).
        Halt datetimes are stored as ET (no timezone suffix). Compare in ET."""
        try:
            halt_time = datetime.strptime(
                halt_datetime_str.replace('T', ' ')[:19], "%Y-%m-%d %H:%M:%S"
            ).replace(tzinfo=_ET)
            age_seconds = (datetime.now(_ET) - halt_time).total_seconds()
            return age_seconds > MAX_HALT_AGE_SECONDS
        except Exception:
            return True  # If we can't parse the time, it's stale

    # =================================================================
    # Restart cutoff
    # =================================================================

    def get_cutoff(self) -> datetime:
        """Get the timestamp cutoff — halts before this are skipped."""
        if self.last_halt_cutoff is None:
            self.last_halt_cutoff = self._load_last_halt_timestamp()
        return self.last_halt_cutoff

    def update_cutoff(self, halt_datetime: datetime):
        """Update the cutoff timestamp after processing a halt."""
        self.last_halt_cutoff = halt_datetime
        self._save_last_halt_timestamp(halt_datetime)

    def is_before_cutoff(self, halt_datetime: datetime) -> bool:
        """Check if a halt is before our restart cutoff."""
        return halt_datetime <= self.get_cutoff()

    # =================================================================
    # Persistence — seen halts
    # =================================================================

    def load_from_disk(self) -> int:
        """Load persisted seen_halts from JSON file. Returns count loaded."""
        today_str = datetime.now(_ET).strftime("%Y-%m-%d")
        try:
            with open(SEEN_HALTS_FILE, 'r') as f:
                data = json.load(f)
                if data.get('date') == today_str:
                    self.seen_halts = set(data.get('halts', []))
                    return len(self.seen_halts)
        except (FileNotFoundError, json.JSONDecodeError):
            pass
        return 0

    def load_from_db(self) -> int:
        """Load today's halt IDs from SQLite into seen_halts. Returns count loaded."""
        try:
            today = datetime.now(_ET).strftime("%Y-%m-%d")
            conn = sqlite3.connect(self.db_path, timeout=5)
            cursor = conn.cursor()
            cursor.execute(
                "SELECT symbol, halt_datetime, halt_number_today FROM halts WHERE halt_datetime LIKE ?",
                (f"{today}%",)
            )
            for row in cursor.fetchall():
                symbol, halt_dt, halt_num = row[0], row[1], row[2] or 1
                halt_id = f"{symbol}-{today}-{halt_num}"
                self.seen_halts.add(halt_id)
                try:
                    dt = datetime.strptime(halt_dt.replace('T', ' ')[:19], "%Y-%m-%d %H:%M:%S")
                    prev = self.latest_halt_by_symbol.get(symbol)
                    if not prev or dt > prev:
                        self.latest_halt_by_symbol[symbol] = dt
                except Exception:
                    pass
            conn.close()
            return len(self.seen_halts)
        except Exception:
            return 0

    def _save_seen_to_disk(self):
        """Persist seen_halts to JSON file."""
        try:
            today_str = datetime.now(_ET).strftime("%Y-%m-%d")
            with open(SEEN_HALTS_FILE, 'w') as f:
                json.dump({'date': today_str, 'halts': list(self.seen_halts)}, f)
        except Exception:
            pass

    # =================================================================
    # Persistence — last halt timestamp
    # =================================================================

    def _load_last_halt_timestamp(self) -> datetime:
        """Load timestamp of last processed halt from file.

        On fresh container start (Railway ephemeral FS), the file won't exist.
        Fall back to start-of-day ET so all of today's halts are eligible —
        seen_halts (rebuilt from Supabase) handles dedup so this won't cause
        reprocessing. Returns a NAIVE datetime in ET to match RSS halt times.
        """
        try:
            with open(LAST_HALT_FILE, 'r') as f:
                ts = f.read().strip()
                return datetime.strptime(ts, "%Y-%m-%d %H:%M:%S")
        except (FileNotFoundError, ValueError):
            pass
        # Fresh start: cutoff = start of today in ET (NAIVE for RSS comparison)
        et_now = datetime.now(_ET)
        return et_now.replace(hour=0, minute=0, second=0, microsecond=0, tzinfo=None)

    def _save_last_halt_timestamp(self, halt_time: datetime):
        """Persist timestamp of last processed halt."""
        try:
            with open(LAST_HALT_FILE, 'w') as f:
                f.write(halt_time.strftime("%Y-%m-%d %H:%M:%S"))
        except Exception:
            pass

    # =================================================================
    # Session management
    # =================================================================

    def clear_session(self):
        """Clear all in-memory state for a new trading day."""
        self.seen_halts.clear()
        self.halt_counts.clear()
        self.last_halt_prices.clear()
        self.latest_halt_by_symbol.clear()
        self.last_halt_cutoff = None
