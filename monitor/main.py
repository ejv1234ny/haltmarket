#!/usr/bin/env python3
"""
HaltMarket Monitor — alpha
Async RSS polling loop. Detects NASDAQ LULD halts, writes to Supabase,
detects trade resumptions, fetches reopen prices from Polygon.
Self-contained — no relative imports, runs as `python main.py`.
"""

import asyncio
import http.server
import os
import re
import sys
import threading
from datetime import datetime, timedelta, timezone
from typing import Optional
from zoneinfo import ZoneInfo

import feedparser
import httpx
from dotenv import load_dotenv

load_dotenv()

# ──────────────────────────────────────────────────────────────────────────────
# Config
# ──────────────────────────────────────────────────────────────────────────────

ET = ZoneInfo("America/New_York")
RSS_URL = "https://nasdaqtrader.com/rss.aspx?feed=tradehalts"
ALLOWED_CODES = {"LUDP", "LUDS", "IPO"}
POLL_INTERVAL = 30  # seconds

SUPABASE_URL = (os.getenv("SUPABASE_URL") or os.getenv("NEXT_PUBLIC_SUPABASE_URL", "")).rstrip("/")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
POLYGON_API_KEY = os.getenv("POLYGON_API_KEY", "")

# ──────────────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────────────

def now_utc() -> str:
    return datetime.now(timezone.utc).isoformat()


def supabase_headers(prefer: str = "return=representation") -> dict:
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
        "Prefer": prefer,
    }


def is_market_hours() -> bool:
    et = datetime.now(ET)
    if et.weekday() >= 5:
        return False
    h, m = et.hour, et.minute
    return (4, 0) <= (h, m) <= (20, 0)  # 4am–8pm ET covers pre/after-hours


# ──────────────────────────────────────────────────────────────────────────────
# RSS parsing (inlined so main.py is fully self-contained)
# ──────────────────────────────────────────────────────────────────────────────

_TD = re.compile(r"<td[^>]*>([^<]*)</td>")


def parse_rss_feed():
    """Returns (halts, trade_resumptions, quote_resumptions) as lists of dicts."""
    halts, trade_resumes, quote_resumes = [], [], []
    try:
        feed = feedparser.parse(RSS_URL)
    except Exception as e:
        print(f"[RSS] parse error: {e}")
        return halts, trade_resumes, quote_resumes

    for entry in feed.entries:
        try:
            matches = _TD.findall(entry.get("summary", ""))
            if len(matches) < 6:
                continue

            halt_date = matches[0].strip()                          # MM/DD/YYYY
            halt_time = matches[1].strip().split(".")[0]            # HH:MM:SS
            symbol = matches[2].strip()
            reason_code = matches[5].strip()

            if reason_code not in ALLOWED_CODES:
                continue

            rss_id = f"{symbol}_{halt_date}_{halt_time}"

            # field[8] = quote resumption (DO NOT resolve)
            # field[9] = trade resumption (TRIGGERS resolve)
            quote_raw = matches[8].strip() if len(matches) >= 9 else ""
            trade_raw = matches[9].strip() if len(matches) >= 10 else ""
            quote_time = quote_raw.split(".")[0] if quote_raw else ""
            trade_time = trade_raw.split(".")[0] if trade_raw else ""

            if trade_time:
                trade_resumes.append({"symbol": symbol, "rss_id": rss_id})
            elif quote_time:
                quote_resumes.append({"symbol": symbol, "rss_id": rss_id})

            halts.append({
                "symbol": symbol,
                "halt_date": halt_date,
                "halt_time": halt_time,
                "reason_code": reason_code,
                "rss_id": rss_id,
                "halt_datetime_naive": datetime.strptime(
                    f"{halt_date} {halt_time}", "%m/%d/%Y %H:%M:%S"
                ),
            })
        except Exception as e:
            print(f"[RSS] entry error: {type(e).__name__}: {e}")

    return halts, trade_resumes, quote_resumes


# ──────────────────────────────────────────────────────────────────────────────
# Supabase operations
# ──────────────────────────────────────────────────────────────────────────────

async def pipeline_update(client: httpx.AsyncClient, halt_id: str, **fields):
    resp = await client.patch(
        f"{SUPABASE_URL}/rest/v1/active_halts",
        params={"halt_id": f"eq.{halt_id}"},
        json={**fields, "updated_at": now_utc()},
        headers=supabase_headers(),
        timeout=10,
    )
    if resp.status_code >= 400:
        print(f"[PIPELINE ERROR] {halt_id} HTTP {resp.status_code}: {resp.text[:300]}")


async def count_halts_today(client: httpx.AsyncClient, symbol: str) -> int:
    """Count existing active_halts rows for this symbol today (ET)."""
    today_et = datetime.now(ET).strftime("%Y-%m-%d")
    resp = await client.get(
        f"{SUPABASE_URL}/rest/v1/active_halts",
        params={
            "symbol": f"eq.{symbol}",
            "select": "halt_id",
            "order": "halt_time.asc",
        },
        headers={**supabase_headers(), "Range-Unit": "items"},
        timeout=10,
    )
    if resp.status_code != 200:
        return 0
    return sum(1 for r in resp.json() if f"-{today_et}-" in r.get("halt_id", ""))


async def get_polygon_price(client: httpx.AsyncClient, symbol: str) -> Optional[float]:
    if not POLYGON_API_KEY:
        return None
    try:
        resp = await client.get(
            f"https://api.polygon.io/v2/last/trade/{symbol}",
            params={"apiKey": POLYGON_API_KEY},
            timeout=10,
        )
        if resp.status_code == 200:
            return resp.json().get("results", {}).get("p")
    except Exception as e:
        print(f"[POLYGON] {symbol}: {type(e).__name__}: {e}")
    return None


async def write_heartbeat(client: httpx.AsyncClient, halts_today: int):
    try:
        await client.patch(
            f"{SUPABASE_URL}/rest/v1/monitor_heartbeats",
            params={"id": "eq.1"},
            json={"last_seen": now_utc(), "halts_today": halts_today, "status": "running"},
            headers=supabase_headers(prefer="return=minimal"),
            timeout=5,
        )
    except Exception:
        pass


async def rebuild_seen(client: httpx.AsyncClient) -> set:
    """Rebuild seen halt_ids from Supabase on startup — prevents reprocessing after restart."""
    resp = await client.get(
        f"{SUPABASE_URL}/rest/v1/active_halts",
        params={"select": "halt_id"},
        headers=supabase_headers(),
        timeout=15,
    )
    seen = set()
    if resp.status_code == 200:
        for row in resp.json():
            seen.add(row["halt_id"])
    print(f"[STARTUP] Rebuilt {len(seen)} seen halt_ids from Supabase")
    return seen


# ──────────────────────────────────────────────────────────────────────────────
# Halt lifecycle
# ──────────────────────────────────────────────────────────────────────────────

async def process_halt(client: httpx.AsyncClient, rss_halt: dict,
                       halt_id: str, halt_time_utc: str):
    symbol = rss_halt["symbol"]
    closes_at = (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat()
    row = {
        "halt_id": halt_id,
        "symbol": symbol,
        "halt_number": int(halt_id.rsplit("-", 1)[-1]),
        "halt_time": halt_time_utc,
        "reason_code": rss_halt["reason_code"],
        "pipeline_status": "detected",
        "is_active": True,
        "t_halt_detected": now_utc(),
        "prediction_closes_at": closes_at,
        "created_at": now_utc(),
        "updated_at": now_utc(),
    }
    resp = await client.post(
        f"{SUPABASE_URL}/rest/v1/active_halts",
        json=row,
        headers={**supabase_headers(), "Prefer": "return=minimal"},
        timeout=10,
    )
    if resp.status_code not in (200, 201):
        print(f"[INSERT ERROR] {halt_id}: HTTP {resp.status_code}: {resp.text[:300]}")
        return
    print(f"[HALT] {halt_id} inserted — fetching Polygon price")

    halt_price = await get_polygon_price(client, symbol)
    if halt_price:
        await pipeline_update(client, halt_id,
            halt_price=halt_price,
            t_halt_price_set=now_utc(),
            pipeline_status="gate_open",
            t_prediction_gate_open=now_utc(),
        )
        print(f"[HALT] {halt_id} price=${halt_price} → gate_open")
    else:
        print(f"[HALT] {halt_id} no Polygon price — gate stays closed")


async def resolve_halt(client: httpx.AsyncClient, halt_id: str, symbol: str):
    print(f"[RESOLVE] {symbol} — waiting 30s for price discovery")
    await asyncio.sleep(30)

    resume_price = await get_polygon_price(client, symbol)
    if not resume_price:
        print(f"[RESOLVE ERROR] {symbol}: no Polygon price after wait")
        return

    resp = await client.get(
        f"{SUPABASE_URL}/rest/v1/active_halts",
        params={"halt_id": f"eq.{halt_id}", "select": "halt_price"},
        headers=supabase_headers(),
        timeout=10,
    )
    if resp.status_code != 200 or not resp.json():
        print(f"[RESOLVE ERROR] {halt_id}: can't fetch halt row")
        return

    halt_price = resp.json()[0].get("halt_price") or resume_price
    direction = "UP" if resume_price > halt_price else "DOWN"
    gap_pct = round((resume_price - halt_price) / halt_price * 100, 2)

    await pipeline_update(client, halt_id,
        resume_price=resume_price,
        reopen_direction=direction,
        reopen_gap_pct=gap_pct,
        t_reopen_price_set=now_utc(),
        is_active=False,
        pipeline_status="resolved",
    )
    print(f"[RESOLVE] {halt_id} {direction} {gap_pct:+.1f}% ${halt_price}→${resume_price}")


# ──────────────────────────────────────────────────────────────────────────────
# Health endpoint (Railway healthcheck)
# ──────────────────────────────────────────────────────────────────────────────

def start_health_server(port: int = 8080):
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ok")

        def log_message(self, *args):
            pass  # silence access logs

    server = http.server.HTTPServer(("0.0.0.0", port), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    print(f"[HEALTH] Listening on :{port}")


# ──────────────────────────────────────────────────────────────────────────────
# Main loop
# ──────────────────────────────────────────────────────────────────────────────

async def main():
    if not SUPABASE_URL or not SUPABASE_KEY:
        sys.exit("[FATAL] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required")

    start_health_server()
    print(f"[MONITOR] HaltMarket alpha monitor — polling every {POLL_INTERVAL}s")

    async with httpx.AsyncClient() as client:
        seen_halt_ids: set = await rebuild_seen(client)
        rss_seen: set = set()      # rss_id (symbol_date_time) dedup across polls
        resolved_set: set = set()  # halt_ids where resolve task already launched

        while True:
            if not is_market_hours():
                await asyncio.sleep(60)
                continue

            try:
                halts, trade_resumes, _ = parse_rss_feed()
                today_et = datetime.now(ET).strftime("%Y-%m-%d")

                # ── New halts ──────────────────────────────────────────────
                new_halts = [h for h in halts if h["rss_id"] not in rss_seen]
                if new_halts:
                    tasks, id_pairs = [], []
                    for rss_halt in new_halts:
                        symbol = rss_halt["symbol"]
                        count = await count_halts_today(client, symbol)
                        halt_id = f"{symbol}-{today_et}-{count + 1}"
                        aware_et = rss_halt["halt_datetime_naive"].replace(tzinfo=ET)
                        halt_time_utc = aware_et.astimezone(timezone.utc).isoformat()
                        tasks.append(process_halt(client, rss_halt, halt_id, halt_time_utc))
                        id_pairs.append((rss_halt, halt_id))

                    results = await asyncio.gather(*tasks, return_exceptions=True)
                    for (rss_halt, halt_id), result in zip(id_pairs, results):
                        if isinstance(result, Exception):
                            print(f"[ERROR] {halt_id}: {type(result).__name__}: {result}")
                        rss_seen.add(rss_halt["rss_id"])
                        seen_halt_ids.add(halt_id)

                # ── Trade resumptions ──────────────────────────────────────
                for r in trade_resumes:
                    symbol = r["symbol"]
                    matching = sorted(
                        hid for hid in seen_halt_ids
                        if hid.startswith(f"{symbol}-{today_et}-")
                    )
                    if not matching:
                        print(f"[RESUME] {symbol}: no matching halt in seen set")
                        continue
                    halt_id = matching[-1]  # most recent halt for this symbol today
                    if halt_id in resolved_set:
                        continue
                    resolved_set.add(halt_id)
                    await pipeline_update(client, halt_id,
                        t_trade_resumption=now_utc(),
                        pipeline_status="trade_resumed",
                    )
                    asyncio.create_task(resolve_halt(client, halt_id, symbol))
                    print(f"[RESUME] {halt_id} trade resumed — resolve task launched")

                await write_heartbeat(client, len(seen_halt_ids))

            except Exception as e:
                import traceback
                print(f"[POLL ERROR] {type(e).__name__}: {e}")
                traceback.print_exc()

            await asyncio.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    asyncio.run(main())
