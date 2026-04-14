"""
HaltPredict v2 — Order Manager

Fill polling, bracket placement, trade execution logic.
Source: alpaca_trader.py (lines 269-524, 991-1135)
"""

import time
import sqlite3
from datetime import datetime
from typing import Optional, Dict
from zoneinfo import ZoneInfo

_ET = ZoneInfo("America/New_York")

from ..config import (
    DB_FILE, DAILY_ENTRY_LIMIT, COOLDOWN_SECONDS,
    POSITION_SIZE_USD, MAX_HALT_AGE_SECONDS,
    ENTRY_SLIPPAGE_PCT, STOP_LOSS_PCT,
)
from .alpaca_client import AlpacaClient


class OrderManager:
    """
    Trade execution logic: entry, fill polling, brackets, cooldowns, limits.

    Safety rails (in order):
    1. Stale halt check (>5 min)
    2. Asset tradability
    3. Per-ticker cooldown (30s)
    4. Daily entry limit (from Alpaca fills)
    5. Existing position check
    6. Max positions check
    7. Buying power check
    """

    def __init__(self, client: AlpacaClient, db_path: str = DB_FILE):
        self.client = client
        self.db_path = db_path
        self._order_cooldowns: Dict[str, float] = {}  # {symbol: timestamp}
        self._init_trades_table()

        # Trading parameters — V2 values per CLAUDE.md
        # V1 was -8%/+25% (too tight, caused stop-outs before real moves)
        # V2 is -15%/+40% (gives price room to breathe)
        self.max_position_size = POSITION_SIZE_USD
        self.stop_loss_pct = 0.15     # V2: -15% (was 0.08)
        self.take_profit_pct = 0.40   # V2: +40% (was 0.25)
        self.entry_limit_pct = 0.01   # V2: +1% IOC slippage (was +2% via ENTRY_SLIPPAGE_PCT)
        self.entry_delay_seconds = 30 # V2: 30s wait after resume for price discovery
        self.max_positions = 3
        self.min_score = 52  # V6.1 threshold
        self.trade_halt_numbers = list(range(1, 11))  # All halt numbers

    def _init_trades_table(self):
        """Create automated_trades table if not exists, add columns if missing."""
        conn = sqlite3.connect(self.db_path)
        conn.execute('''
            CREATE TABLE IF NOT EXISTS automated_trades (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                symbol TEXT NOT NULL,
                halt_datetime TEXT NOT NULL,
                halt_number INTEGER,
                entry_order_id TEXT,
                exit_order_id TEXT,
                oco_order_id TEXT,
                entry_price REAL,
                exit_price REAL,
                filled_qty INTEGER,
                avg_fill_price REAL,
                stop_price REAL,
                target_price REAL,
                shares INTEGER,
                side TEXT,
                score INTEGER,
                recommendation TEXT,
                status TEXT DEFAULT 'pending',
                pnl REAL,
                pnl_pct REAL,
                entry_time TEXT,
                exit_time TEXT,
                exit_reason TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        # Add columns to existing tables that predate this schema
        for col, coltype in [
            ('oco_order_id', 'TEXT'),
            ('filled_qty', 'INTEGER'),
            ('avg_fill_price', 'REAL'),
            ('stop_price', 'REAL'),
            ('target_price', 'REAL'),
        ]:
            try:
                conn.execute(f'ALTER TABLE automated_trades ADD COLUMN {col} {coltype}')
            except sqlite3.OperationalError:
                pass  # column already exists
        conn.commit()
        conn.close()

    # =================================================================
    # Trade eligibility checks
    # =================================================================

    def should_trade(self, halt_data: dict) -> tuple:
        """
        Run all safety checks. Returns (can_trade: bool, reason: str).
        """
        symbol = halt_data.get('symbol', '')
        score = halt_data.get('score', 0)
        recommendation = halt_data.get('recommendation', '')
        halt_number = halt_data.get('halt_number_today', 1)
        is_short = recommendation == 'SHORT'

        # 1. Asset tradability
        if not self.client.is_asset_tradable(symbol):
            return False, f"{symbol} is not tradable on Alpaca"

        # 1b. Short-specific: check shortable + price floor
        if is_short:
            halt_price = halt_data.get('halt_price', 0)
            if halt_price and halt_price <= 2.0:
                return False, f"Cannot short {symbol}: price ${halt_price:.2f} ≤ $2.00"
            if not self.client.is_asset_shortable(symbol):
                return False, f"{symbol} is not shortable on Alpaca"

        # 2. Per-ticker cooldown
        can_cd, elapsed = self._check_cooldown(symbol)
        if not can_cd:
            return False, f"{symbol} in cooldown ({elapsed:.0f}s since last order)"

        # 3. Daily entry limit
        count = self.client.get_todays_filled_buys()
        if count >= DAILY_ENTRY_LIMIT:
            return False, f"Daily limit ({DAILY_ENTRY_LIMIT}) reached ({count} fills)"

        # 4. Score threshold
        if score < self.min_score:
            return False, f"Score {score} below threshold {self.min_score}"

        # 5. Recommendation
        if recommendation in ('AVOID', 'BLOCKED', 'WATCH'):
            return False, f"Recommendation is {recommendation}"

        # 6. Halt number
        if halt_number not in self.trade_halt_numbers:
            return False, f"Halt #{halt_number} not in tradeable range"

        # 7. Existing position
        existing = self.client.get_position(symbol)
        if existing:
            return False, f"Already holding {existing.get('qty', '?')} shares of {symbol}"

        # 8. Max positions
        positions = self.client.get_positions()
        if len(positions) >= self.max_positions:
            return False, f"Max positions ({self.max_positions}) reached"

        # 9. Buying power
        buying_power = self.client.get_buying_power()
        if buying_power < self.max_position_size:
            return False, f"Insufficient buying power: ${buying_power:.2f}"

        return True, "All checks passed"

    # =================================================================
    # Trade execution
    # =================================================================

    def execute_halt_trade(self, halt_data: dict) -> Optional[str]:
        """
        Execute a trade for a halt. Returns trade_id or None.
        """
        symbol = halt_data.get('symbol', '')
        score = halt_data.get('score', 0)
        recommendation = halt_data.get('recommendation', '')
        halt_number = halt_data.get('halt_number_today', 1)
        halt_datetime = halt_data.get('halt_datetime', '')
        reopen_price = halt_data.get('reopen_price') or halt_data.get('halt_price', 0)

        # Stale halt check — LAST line of defense
        if halt_datetime:
            try:
                ht = datetime.strptime(halt_datetime.replace('T', ' ')[:19], "%Y-%m-%d %H:%M:%S").replace(tzinfo=_ET)
                age = (datetime.now(_ET) - ht).total_seconds()
                if age > MAX_HALT_AGE_SECONDS:
                    print(f"[STALE-BLOCK] {symbol}: halt is {age/60:.1f} min old — REFUSING")
                    return None
            except Exception:
                print(f"[STALE-BLOCK] {symbol}: could not parse halt_datetime — REFUSING")
                return None

        # Safety checks
        should, reason = self.should_trade(halt_data)
        if not should:
            print(f"[SKIP] {symbol}: {reason}")
            return None

        # Calculate position size
        shares = self._calculate_shares(reopen_price)
        if shares == 0:
            print(f"[SKIP] {symbol}: Could not calculate position size")
            return None

        is_short = recommendation == 'SHORT'
        side_label = "SHORT" if is_short else "LONG"

        print(f"\n{'='*50}")
        print(f"EXECUTING {side_label}: {symbol}")
        print(f"  Halt #{halt_number} | Score: {score} | Rec: {recommendation}")
        print(f"  Price: ${reopen_price:.2f} | Shares: {shares}")
        print(f"{'='*50}")

        # Execute entry + bracket (short or long)
        if is_short:
            result = self._short_entry_then_bracket(
                symbol, shares, halt_number, reopen_price
            )
        else:
            result = self._entry_then_bracket(
                symbol, shares, halt_number, reopen_price
            )

        if result and result.get('fill_price'):
            side = 'sell' if is_short else 'buy'
            trade_id = self._record_trade(
                symbol=symbol,
                halt_datetime=halt_datetime,
                halt_number=halt_number,
                order_id=result['entry_order']['id'],
                shares=result['filled_qty'],
                score=score,
                recommendation=recommendation,
                entry_price=result['fill_price'],
                filled_qty=result['filled_qty'],
                avg_fill_price=result['fill_price'],
                stop_price=result.get('stop'),
                target_price=result.get('target'),
                oco_order_id=result.get('oco_order_id'),
                side=side,
            )
            return trade_id
        elif result and result.get('missed'):
            return None
        else:
            print(f"[FAILED] Could not place {side_label} order for {symbol}")
            return None

    def _entry_then_bracket(
        self, symbol: str, qty: int, halt_number: int, resume_price: float
    ) -> Optional[dict]:
        """
        Entry flow:
        1. Generate client_order_id
        2. Place limit IOC at resume_price + 2%
        3. Poll 5x at 1s for fill
        4. On timeout: cancel + final check
        5. On fill: place OCO bracket
        6. On OCO rejection: emergency stop fallback
        """
        # Step 1: Generate unique ID
        client_order_id = f"HP61-{symbol}-H{halt_number}-{int(time.time())}"

        # Step 2: Place limit IOC (V2: +1%, was +2%)
        limit_price = round(resume_price * (1 + self.entry_limit_pct), 2)
        print(f"  [LIMIT] Placing IOC at ${limit_price:.2f} (resume ${resume_price:.2f} + {self.entry_limit_pct*100:.1f}%)")

        entry_order = self.client.place_limit_ioc(
            symbol, qty, limit_price, side='buy', client_order_id=client_order_id
        )

        # Fallback to market if IOC placement failed
        if not entry_order:
            print(f"  [FALLBACK] IOC failed, using market order")
            entry_order = self.client.place_market_order(
                symbol, qty, side='buy', client_order_id=client_order_id
            )

        if not entry_order:
            return None

        # Record cooldown
        self._order_cooldowns[symbol] = time.time()

        order_id = entry_order['id']

        # Step 3: Poll for fill
        fill_price = None
        filled_qty = 0

        for attempt in range(5):
            time.sleep(1)
            order = self.client.get_order(order_id)
            if not order:
                continue

            status = order.get('status', '')

            if status == 'filled':
                fill_price = float(order.get('filled_avg_price', 0))
                filled_qty = int(float(order.get('filled_qty', qty)))
                print(f"[FILLED] {filled_qty} shares of {symbol} at ${fill_price:.2f}")
                break

            elif status == 'partially_filled':
                partial_qty = int(float(order.get('filled_qty', 0)))
                if partial_qty > 0:
                    fill_price = float(order.get('filled_avg_price', 0))
                    filled_qty = partial_qty
                    print(f"[FILLED] {filled_qty} shares of {symbol} at ${fill_price:.2f} (partial)")
                    break

            elif status in ('canceled', 'expired'):
                partial_qty = int(float(order.get('filled_qty', 0)))
                if partial_qty > 0:
                    fill_price = float(order.get('filled_avg_price', 0))
                    filled_qty = partial_qty
                    print(f"[FILLED] {filled_qty} shares at ${fill_price:.2f} (IOC expired, partial)")
                    break
                else:
                    print(f"[MISSED] Limit IOC expired — no fill for {symbol}")
                    return {'missed': True, 'symbol': symbol}

            elif status == 'rejected':
                print(f"[REJECTED] Order rejected for {symbol}: {order.get('reject_reason', 'unknown')}")
                return {'missed': True, 'symbol': symbol, 'rejected': True}

        # Step 4: Timeout — cancel and check for late fill
        if not fill_price:
            print(f"[TIMEOUT] Order unresolved for {symbol} — canceling")
            self.client.cancel_order(order_id)
            time.sleep(0.5)
            order = self.client.get_order(order_id)
            if order:
                partial_qty = int(float(order.get('filled_qty', 0)))
                if partial_qty > 0:
                    fill_price = float(order.get('filled_avg_price', 0))
                    filled_qty = partial_qty
                    print(f"[FILLED] {filled_qty} shares at ${fill_price:.2f} (found after cancel)")

        if not fill_price or fill_price <= 0:
            print(f"[MISSED] No fill detected for {symbol}")
            return {'missed': True, 'symbol': symbol}

        # Step 5: Calculate brackets from ACTUAL fill price
        stop_loss = round(fill_price * (1 - self.stop_loss_pct), 2)
        take_profit = round(fill_price * (1 + self.take_profit_pct), 2)
        print(f"  Setting brackets: TP ${take_profit:.2f} / SL ${stop_loss:.2f}")

        oco_client_id = f"{client_order_id}-OCO"
        oco_order = self.client.place_oco_order(
            symbol, filled_qty, take_profit, stop_loss,
            client_order_id=oco_client_id
        )

        # Step 6: Verify bracket — emergency stop fallback
        if oco_order:
            oco_id = oco_order.get('id')
            if oco_id:
                time.sleep(0.5)
                oco_status = self.client.get_order(oco_id)
                if oco_status and oco_status.get('status') == 'rejected':
                    print(f"[DANGER] Bracket rejected, placing emergency stop")
                    oco_order = self._place_emergency_stop(symbol, filled_qty, stop_loss)
        else:
            # OCO placement failed entirely — emergency stop
            print(f"[DANGER] OCO failed, placing emergency stop at ${stop_loss:.2f}")
            oco_order = self._place_emergency_stop(symbol, filled_qty, stop_loss)

        # Extract OCO order ID for tracking exit fills
        oco_order_id = None
        if oco_order:
            if isinstance(oco_order, dict):
                oco_order_id = oco_order.get('id') or oco_order.get('emergency_stop', {}).get('id')

        return {
            'entry_order': entry_order,
            'fill_price': fill_price,
            'filled_qty': filled_qty,
            'oco_order': oco_order,
            'oco_order_id': oco_order_id,
            'target': take_profit,
            'stop': stop_loss,
            'client_order_id': client_order_id,
        }

    def _short_entry_then_bracket(
        self, symbol: str, qty: int, halt_number: int, resume_price: float
    ) -> Optional[dict]:
        """
        Short entry flow:
        1. Place limit IOC sell at resume_price * 0.98 (2% below)
        2. Poll for fill
        3. On fill: place OCO cover bracket (TP lower, SL higher)
        """
        client_order_id = f"HP61-{symbol}-H{halt_number}-S-{int(time.time())}"

        # Short entry: sell at 1% below resume price (V2: was 2%)
        limit_price = round(resume_price * (1 - self.entry_limit_pct), 2)
        print(f"  [SHORT] Placing IOC sell at ${limit_price:.2f} (resume ${resume_price:.2f} - {self.entry_limit_pct*100:.1f}%)")

        entry_order = self.client.place_limit_ioc(
            symbol, qty, limit_price, side='sell', client_order_id=client_order_id
        )

        if not entry_order:
            print(f"  [FALLBACK] Short IOC failed, using market sell")
            entry_order = self.client.place_market_order(
                symbol, qty, side='sell', client_order_id=client_order_id
            )

        if not entry_order:
            return None

        self._order_cooldowns[symbol] = time.time()
        order_id = entry_order['id']

        # Poll for fill
        fill_price = None
        filled_qty = 0

        for attempt in range(5):
            time.sleep(1)
            order = self.client.get_order(order_id)
            if not order:
                continue

            status = order.get('status', '')

            if status == 'filled':
                fill_price = float(order.get('filled_avg_price', 0))
                filled_qty = int(float(order.get('filled_qty', qty)))
                print(f"[SHORT-FILLED] {filled_qty} shares of {symbol} at ${fill_price:.2f}")
                break
            elif status == 'partially_filled':
                partial_qty = int(float(order.get('filled_qty', 0)))
                if partial_qty > 0:
                    fill_price = float(order.get('filled_avg_price', 0))
                    filled_qty = partial_qty
                    print(f"[SHORT-FILLED] {filled_qty} shares of {symbol} at ${fill_price:.2f} (partial)")
                    break
            elif status in ('canceled', 'expired'):
                partial_qty = int(float(order.get('filled_qty', 0)))
                if partial_qty > 0:
                    fill_price = float(order.get('filled_avg_price', 0))
                    filled_qty = partial_qty
                    break
                else:
                    print(f"[MISSED] Short IOC expired — no fill for {symbol}")
                    return {'missed': True, 'symbol': symbol}
            elif status == 'rejected':
                print(f"[REJECTED] Short order rejected for {symbol}: {order.get('reject_reason', 'unknown')}")
                return {'missed': True, 'symbol': symbol, 'rejected': True}

        # Timeout — cancel and check for late fill
        if not fill_price:
            print(f"[TIMEOUT] Short order unresolved for {symbol} — canceling")
            self.client.cancel_order(order_id)
            time.sleep(0.5)
            order = self.client.get_order(order_id)
            if order:
                partial_qty = int(float(order.get('filled_qty', 0)))
                if partial_qty > 0:
                    fill_price = float(order.get('filled_avg_price', 0))
                    filled_qty = partial_qty

        if not fill_price or fill_price <= 0:
            print(f"[MISSED] No short fill detected for {symbol}")
            return {'missed': True, 'symbol': symbol}

        # Cover bracket: TP = price drops further, SL = price reverses up
        # V2: -40%/+15% (was -25%/+8%)
        take_profit = round(fill_price * (1 - self.take_profit_pct), 2)  # TP: -40% from entry
        stop_loss = round(fill_price * (1 + self.stop_loss_pct), 2)      # SL: +15% from entry
        print(f"  Setting cover brackets: TP ${take_profit:.2f} / SL ${stop_loss:.2f}")

        oco_client_id = f"{client_order_id}-OCO"
        oco_order = self.client.place_oco_cover_order(
            symbol, filled_qty, take_profit, stop_loss,
            client_order_id=oco_client_id
        )

        # Emergency stop fallback — buy stop above entry
        if oco_order:
            oco_id = oco_order.get('id')
            if oco_id:
                time.sleep(0.5)
                oco_status = self.client.get_order(oco_id)
                if oco_status and oco_status.get('status') == 'rejected':
                    print(f"[DANGER] Cover bracket rejected, placing emergency buy stop")
                    oco_order = self._place_emergency_cover_stop(symbol, filled_qty, stop_loss)
        else:
            print(f"[DANGER] Cover OCO failed, placing emergency buy stop at ${stop_loss:.2f}")
            oco_order = self._place_emergency_cover_stop(symbol, filled_qty, stop_loss)

        oco_order_id = None
        if oco_order:
            if isinstance(oco_order, dict):
                oco_order_id = oco_order.get('id') or oco_order.get('emergency_stop', {}).get('id')

        return {
            'entry_order': entry_order,
            'fill_price': fill_price,
            'filled_qty': filled_qty,
            'oco_order': oco_order,
            'oco_order_id': oco_order_id,
            'target': take_profit,
            'stop': stop_loss,
            'client_order_id': client_order_id,
        }

    def _place_emergency_cover_stop(self, symbol: str, qty: int, stop_price: float) -> Optional[dict]:
        """Place emergency buy-stop to cover a short if OCO bracket fails."""
        order_data = {
            'symbol': symbol,
            'qty': str(qty),
            'side': 'buy',
            'type': 'stop',
            'stop_price': str(round(stop_price, 2)),
            'time_in_force': 'gtc',
        }
        emergency = self.client._place_order(order_data, f"Emergency cover-stop {qty} {symbol} @ ${stop_price:.2f}")
        if emergency:
            print(f"[PROTECTED] Emergency cover-stop placed at ${stop_price:.2f}")
            return {'emergency_stop': emergency, 'oco_failed': True}
        else:
            print(f"[CRITICAL] Short position {symbol} UNPROTECTED — manual intervention required")
            return None

    def _place_emergency_stop(self, symbol: str, qty: int, stop_price: float) -> Optional[dict]:
        """Place emergency stop order as bracket fallback."""
        emergency = self.client.place_stop_order(symbol, qty, stop_price, time_in_force='gtc')
        if emergency:
            print(f"[PROTECTED] Emergency stop placed at ${stop_price:.2f}")
            return {'emergency_stop': emergency, 'oco_failed': True}
        else:
            print(f"[CRITICAL] Position {symbol} UNPROTECTED — manual intervention required")
            return None

    # =================================================================
    # Cooldown
    # =================================================================

    def _check_cooldown(self, symbol: str) -> tuple:
        """Check per-ticker cooldown. Returns (can_trade, elapsed)."""
        if symbol not in self._order_cooldowns:
            return True, float('inf')
        elapsed = time.time() - self._order_cooldowns[symbol]
        if elapsed < COOLDOWN_SECONDS:
            return False, elapsed
        return True, elapsed

    # =================================================================
    # Position size
    # =================================================================

    def _calculate_shares(self, price: float) -> int:
        """Calculate number of shares from max position size."""
        if price <= 0:
            return 0
        return max(1, int(self.max_position_size / price))

    # =================================================================
    # Trade recording
    # =================================================================

    def _record_trade(
        self, symbol: str, halt_datetime: str, halt_number: int,
        order_id: str, shares: int, score: float, recommendation: str,
        entry_price: float, filled_qty: int = None, avg_fill_price: float = None,
        stop_price: float = None, target_price: float = None,
        oco_order_id: str = None, side: str = 'buy',
    ) -> str:
        """Record trade in local SQLite + Supabase alpaca_trades.

        Local SQLite is the source of truth for the running container (used by
        update_trade_exit, EOD reconciliation, etc.). Supabase mirror exists so
        the trade is durable across Railway container restarts (the local file
        is wiped on every restart).
        """
        entry_time_iso = datetime.now(_ET).isoformat()

        # 1. Local SQLite
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        cursor.execute(
            '''INSERT INTO automated_trades
            (symbol, halt_datetime, halt_number, entry_order_id, oco_order_id,
             shares, filled_qty, avg_fill_price, stop_price, target_price,
             score, recommendation, status, entry_price, entry_time, side)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'filled', ?, ?, ?)''',
            (symbol, halt_datetime, halt_number, order_id, oco_order_id,
             shares, filled_qty or shares, avg_fill_price or entry_price,
             stop_price, target_price,
             int(score), recommendation, entry_price, entry_time_iso, side)
        )
        trade_id = cursor.lastrowid
        conn.commit()
        conn.close()

        # 2. Supabase mirror (durable across restarts)
        try:
            from ..data.supabase_writer import SupabaseWriter
            sb = SupabaseWriter()
            date_part = (halt_datetime or "").replace("T", " ").split(" ")[0]
            halt_id = f"{symbol}-{date_part}-{halt_number}"
            sb.insert_alpaca_trade({
                "symbol": symbol,
                "halt_id": halt_id,
                "halt_datetime": halt_datetime,
                "halt_number": halt_number,
                "order_id": order_id,
                "oco_order_id": oco_order_id,
                "side": side,
                "qty": shares,
                "filled_qty": filled_qty or shares,
                "avg_fill_price": avg_fill_price or entry_price,
                "entry_price": entry_price,
                "stop_price": stop_price,
                "target_price": target_price,
                "v61_score": int(score) if score else None,
                "status": "filled",
                "entry_time": entry_time_iso,
            })
        except Exception as e:
            print(f"  [WARN] alpaca_trades Supabase mirror failed: {e}")

        return str(trade_id)

    def update_trade_exit(self, symbol: str, exit_price: float, exit_reason: str):
        """Update trade record on exit with P&L (local SQLite + Supabase mirror).

        exit_reason drives the status:
          - contains 'tp' or 'take profit' → 'closed_tp'
          - contains 'sl' or 'stop loss'   → 'closed_sl'
          - contains 'eod' or 'liquidat'   → 'closed_eod'
          - otherwise                       → 'closed'
        """
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        cursor.execute(
            '''SELECT id, entry_price, shares, entry_order_id, side FROM automated_trades
            WHERE symbol = ? AND status IN ('open', 'filled', 'short_open')
            ORDER BY created_at DESC LIMIT 1''',
            (symbol,)
        )
        row = cursor.fetchone()

        if row:
            trade_id, entry_price, shares, entry_order_id, trade_side = row
            if trade_side == 'sell':
                # Short: profit when price drops
                pnl = (entry_price - exit_price) * shares
                pnl_pct = ((entry_price - exit_price) / entry_price) * 100
            else:
                pnl = (exit_price - entry_price) * shares
                pnl_pct = ((exit_price - entry_price) / entry_price) * 100
            exit_time_iso = datetime.now(_ET).isoformat()

            # Derive granular status from exit_reason
            reason_lower = (exit_reason or '').lower()
            is_short_trade = trade_side == 'sell'
            if 'tp' in reason_lower or 'take profit' in reason_lower or 'target' in reason_lower:
                status = 'short_covered_tp' if is_short_trade else 'closed_tp'
            elif 'sl' in reason_lower or 'stop loss' in reason_lower or 'stop' in reason_lower:
                status = 'short_covered_sl' if is_short_trade else 'closed_sl'
            elif 'eod' in reason_lower or 'liquidat' in reason_lower or 'end of day' in reason_lower:
                status = 'closed_eod'
            else:
                status = 'closed'

            cursor.execute(
                '''UPDATE automated_trades
                SET status = ?, exit_price = ?, exit_time = ?,
                    exit_reason = ?, pnl = ?, pnl_pct = ?
                WHERE id = ?''',
                (status, exit_price, exit_time_iso, exit_reason,
                 round(pnl, 2), round(pnl_pct, 2), trade_id)
            )
            conn.commit()
            print(f"[CLOSED] {symbol}: ${entry_price:.2f} -> ${exit_price:.2f} | {pnl_pct:+.1f}% | ${pnl:+.2f} ({status})")

            # Mirror exit to Supabase alpaca_trades
            if entry_order_id:
                try:
                    from ..data.supabase_writer import SupabaseWriter
                    SupabaseWriter().update_alpaca_trade_exit(
                        order_id=entry_order_id,
                        exit_price=exit_price,
                        exit_time=exit_time_iso,
                        pnl=round(pnl, 2),
                        pnl_pct=round(pnl_pct, 2),
                        status=status,
                    )
                except Exception as e:
                    print(f"  [WARN] alpaca_trades exit Supabase mirror failed: {e}")

        conn.close()

    def handle_new_halt(self, halt_data: dict):
        """
        Main entry point for new halt: enter or manage existing position.
        """
        symbol = halt_data.get('symbol', '')
        halt_number = halt_data.get('halt_number_today', 1)

        position = self.client.get_position(symbol)

        if position:
            # Check exit signals (exhaustion at halt #5+)
            if halt_number >= 5:
                result = self.client.close_position(symbol)
                if result:
                    exit_price = float(position.get('current_price', 0))
                    self.update_trade_exit(symbol, exit_price, f"Halt #{halt_number} exhaustion")
        else:
            self.execute_halt_trade(halt_data)
