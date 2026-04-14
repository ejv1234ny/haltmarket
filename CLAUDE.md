# HaltMarket — Complete Build Instructions for Claude Code
# Version: 1.0 | Created: April 14, 2026
# Author: Compiled from HaltPredict V1 learnings

---

## WHAT YOU ARE BUILDING

HaltMarket (haltmarket.com) is a CFTC-preliminary-approved, skill-based prediction exchange 
where users predict the exact reopen price of NASDAQ LULD (Limit Up Limit Down) trading halts.

Every LULD halt on NASDAQ automatically creates a live prediction market. Users enter a 
price prediction. Direction (UP/DOWN) is derived from their price vs the halt price — never 
selected directly. Markets resolve automatically via NASDAQ RSS + Polygon price data. 
ELO rating system tracks accuracy over time.

This platform is simultaneously:
1. A B2C prediction game (free + paid tiers)
2. A CFTC-regulated prediction exchange (pending final approval — build compliance layer)
3. A feeder into HaltMarket.com price bracket markets (future integration)
4. A data product (panel predictions as proprietary signal)

The sister platform HaltPredict.com (already exists, runs in parallel) provides:
- AI scoring (DNA profiles, 3303 tickers)
- Real-time halt detection feed
- Alpaca paper trading bot
- Subscriber edge intelligence

HaltMarket consumes HaltPredict's API for halt data and AI scores.

---

## TECH STACK

```
Frontend:   Next.js 14 (App Router), TypeScript, Tailwind CSS
Backend:    Next.js API routes + Python monitor service
Database:   Supabase (Postgres + Realtime subscriptions)
Hosting:    Vercel (frontend), Railway (Python monitor)
Trading:    Alpaca Markets API (paper → live)
Payments:   Stripe (subscriptions + KYC identity)
Alerts:     Telegram Bot API, Twitter API v2 OAuth 1.0a
            Discord Webhook, Web Push (VAPID)
Pricing:    Polygon.io API (halt prices, resume prices)
Halts:      NASDAQ RSS feed (https://nasdaqtrader.com/rss.aspx?feed=tradehalts)
Auth:       Supabase Auth (magic link + OAuth)
OG Images:  @vercel/og (dynamic per halt)
```

---

## ENVIRONMENT VARIABLES

```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# Polygon
POLYGON_API_KEY=

# Alpaca
ALPACA_API_KEY=
ALPACA_SECRET_KEY=
ALPACA_BASE_URL=https://paper-api.alpaca.markets/v2
ENABLE_TRADING=true

# Twitter OAuth 1.0a
TWITTER_API_KEY=
TWITTER_API_SECRET=
TWITTER_ACCESS_TOKEN=         # Must be generated AFTER enabling Read+Write permissions
TWITTER_ACCESS_TOKEN_SECRET=  # Same — regenerate if 401 errors appear

# Telegram
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHANNEL_ID=

# Discord
DISCORD_WEBHOOK_URL=

# Stripe
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=

# Internal auth
HALTMARKET_API_KEY=           # For monitor → Next.js server-to-server calls
CRON_SECRET=                  # For Vercel cron job authentication

# Web Push (VAPID)
NEXT_PUBLIC_VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
```

---

## DATABASE SCHEMA

Run all migrations in order. Every table matters.

```sql
-- ============================================================
-- CORE HALT LIFECYCLE
-- ============================================================

CREATE TABLE active_halts (
  halt_id text PRIMARY KEY,              -- SYMBOL-YYYY-MM-DD-N (e.g. AFJK-2026-04-14-4)
  symbol text NOT NULL,
  halt_number integer NOT NULL,          -- H1, H2, H3... for same symbol same day
  halt_time timestamptz NOT NULL,        -- ALWAYS UTC — never naive ET string
  halt_price numeric,                    -- from Polygon after detection
  resume_price numeric,                  -- from Polygon after trade resumption
  reopen_direction text,                 -- 'UP' | 'DOWN' | 'FLAT' — derived from prices
  reopen_gap_pct numeric,               -- ((resume - halt) / halt) * 100

  -- Pipeline timestamps (ALL UTC, ALL written by monitor)
  t_halt_detected timestamptz,          -- when monitor first saw this halt
  t_halt_price_set timestamptz,         -- when Polygon returned halt_price
  t_marketing_fired timestamptz,        -- when alerts sent to all channels
  t_prediction_gate_open timestamptz,   -- when prediction window opened
  t_first_prediction timestamptz,       -- when first user submitted a prediction
  t_quote_resumption timestamptz,       -- when RSS field[8] populated (quote only)
  t_trade_resumption timestamptz,       -- when RSS field[9] populated (TRIGGERS RESOLVE)
  t_reopen_price_set timestamptz,       -- when Polygon returned resume_price
  t_predictions_scored timestamptz,     -- when score_predictions() completed
  t_marketing_resolved timestamptz,     -- when resolve alerts sent

  -- Prediction window
  prediction_closes_at timestamptz,     -- halt_time + 10 minutes (set at detection)

  -- AI data (from HaltPredict API)
  ai_prediction text,                   -- 'UP' | 'DOWN' | 'NEUTRAL'
  ai_confidence integer,                -- 0-100
  ai_score numeric,                     -- V6.1 DNA score
  
  -- Status
  pipeline_status text DEFAULT 'detected'
    CHECK (pipeline_status IN (
      'detected','marketed','gate_open','quoted',
      'trade_resumed','resolved','scored','complete'
    )),
  is_active boolean DEFAULT true,       -- false after resume_price set
  
  -- Misc
  reason_code text,                     -- 'LUDP' | 'LUDS' | 'IPO' (only these 3 allowed)
  market text,                          -- 'NASDAQ' | 'NYSE' | 'BATS'
  issue_name text,
  moltbook_post_id text,
  
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- ============================================================
-- USER PREDICTIONS
-- ============================================================

CREATE TABLE user_predictions (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id),
  halt_id text NOT NULL REFERENCES active_halts(halt_id),
  symbol text NOT NULL,
  halt_number integer NOT NULL,
  
  -- The prediction
  halt_price numeric,                   -- snapshot of halt_price at submission time
  predicted_price numeric NOT NULL,     -- what user entered
  predicted_direction text NOT NULL,    -- derived: 'UP' if predicted > halt, else 'DOWN'
  
  -- Scoring (populated by score_predictions() after resolve)
  actual_reopen_price numeric,
  actual_direction text,
  was_direction_correct boolean,
  price_error numeric,                  -- abs(resume_price - predicted_price)
  price_error_pct numeric,              -- price_error / resume_price * 100
  
  -- ELO
  elo_before integer,
  elo_after integer,
  elo_change integer,                   -- +32 (sharp), +16 (correct), -16 (wrong)
  
  -- Tokens/prizes
  tokens_wagered integer DEFAULT 0,
  tokens_won integer DEFAULT 0,
  points_earned integer DEFAULT 0,
  
  -- Timestamps
  predicted_at timestamptz DEFAULT now(),
  resolved_at timestamptz,
  
  UNIQUE(user_id, halt_id)             -- one prediction per user per halt
);

-- ============================================================
-- ELO HISTORY
-- ============================================================

CREATE TABLE elo_history (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id),
  halt_id text NOT NULL,
  symbol text NOT NULL,
  elo_before integer NOT NULL,
  elo_after integer NOT NULL,
  elo_change integer NOT NULL,
  was_correct boolean NOT NULL,
  consensus_pct integer,               -- what % of users agreed with this call
  went_against_crowd boolean,          -- true if user was contrarian and correct
  created_at timestamptz DEFAULT now()
);

-- ============================================================
-- USERS (extends Supabase auth.users)
-- ============================================================

CREATE TABLE users (
  id uuid PRIMARY KEY REFERENCES auth.users(id),
  email text,
  username text UNIQUE,
  display_name text,
  
  -- Subscription
  subscription_tier text DEFAULT 'free'
    CHECK (subscription_tier IN ('free','trader','pro')),
  subscription_expires_at timestamptz,
  stripe_customer_id text,
  
  -- Gamification
  tokens_balance integer DEFAULT 100,
  daily_streak integer DEFAULT 0,
  last_daily_claim date,
  total_daily_claims integer DEFAULT 0,
  
  -- Admin
  is_admin boolean DEFAULT false,
  
  -- Compliance (CFTC)
  kyc_verified boolean DEFAULT false,
  kyc_verified_at timestamptz,
  kyc_provider text,
  position_limit_usd numeric DEFAULT 2500,     -- per outcome
  aggregate_exposure_cap_usd numeric DEFAULT 15000,  -- across all markets
  current_exposure_usd numeric DEFAULT 0,
  is_restricted boolean DEFAULT false,
  restriction_reason text,
  
  created_at timestamptz DEFAULT now(),
  last_login timestamptz
);

-- ============================================================
-- MARKETING / ALERTS
-- ============================================================

CREATE TABLE alerts (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  halt_id text,
  symbol text,
  halt_number integer,
  halt_datetime timestamptz,
  alert_type text,          -- 'halt_fire' | 'halt_resolve' | 'edge_alert' | 'cascade'
  channel text,             -- 'telegram' | 'twitter' | 'discord' | 'push' | 'email'
  message text,
  sent_at timestamptz DEFAULT now()
);

CREATE TABLE failed_notifications (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  halt_id text,
  channel text,
  error_message text,
  payload jsonb,
  created_at timestamptz DEFAULT now()
);

-- ============================================================
-- TRADING (Alpaca paper → live)
-- ============================================================

CREATE TABLE alpaca_trades (
  id bigserial PRIMARY KEY,
  symbol text NOT NULL,
  halt_id text,
  order_id text,
  oco_order_id text,
  side text CHECK (side IN ('buy','sell')),
  qty numeric,
  filled_qty numeric,
  avg_fill_price numeric,
  entry_price numeric,
  exit_price numeric,
  stop_price numeric,          -- SL: entry * 0.85 (-15%)
  target_price numeric,        -- TP: entry * 1.40 (+40%)
  pnl numeric,
  pnl_pct numeric,
  v61_score numeric,
  halt_number integer,
  status text DEFAULT 'open'
    CHECK (status IN (
      'open','filled','closed','closed_tp','closed_sl',
      'closed_eod','cancelled','partial',
      'short_open','short_covered_tp','short_covered_sl'
    )),
  halt_datetime timestamptz,
  entry_time timestamptz,
  exit_time timestamptz,
  created_at timestamptz DEFAULT now()
);

-- ============================================================
-- SYSTEM HEALTH
-- ============================================================

CREATE TABLE monitor_heartbeats (
  id integer DEFAULT 1 PRIMARY KEY,
  last_seen timestamptz DEFAULT now(),
  halts_today integer DEFAULT 0,
  status text DEFAULT 'running'
);

INSERT INTO monitor_heartbeats (id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE TABLE halt_issues (
  id bigserial PRIMARY KEY,
  halt_id text NOT NULL,
  symbol text,
  check_name text,
  severity text CHECK (severity IN ('critical','warning','info')),
  description text,
  detected_at timestamptz DEFAULT now()
);

-- ============================================================
-- LEADERBOARD / STATS
-- ============================================================

CREATE TABLE user_stats (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id),
  total_predictions integer DEFAULT 0,
  correct_predictions integer DEFAULT 0,
  current_elo integer DEFAULT 1000,
  peak_elo integer DEFAULT 1000,
  current_streak integer DEFAULT 0,
  best_streak integer DEFAULT 0,
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE prediction_leaderboard (
  user_id uuid PRIMARY KEY,
  username text,
  elo integer DEFAULT 1000,
  rank integer,
  accuracy_pct numeric,
  total_calls integer,
  correct_calls integer,
  updated_at timestamptz DEFAULT now()
);

-- ============================================================
-- PUSH SUBSCRIPTIONS
-- ============================================================

CREATE TABLE push_subscriptions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES auth.users(id),
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth text NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX idx_active_halts_date ON active_halts(DATE(halt_time));
CREATE INDEX idx_active_halts_status ON active_halts(pipeline_status);
CREATE INDEX idx_active_halts_symbol ON active_halts(symbol);
CREATE INDEX idx_user_predictions_user ON user_predictions(user_id);
CREATE INDEX idx_user_predictions_halt ON user_predictions(halt_id);
CREATE INDEX idx_user_predictions_unscored ON user_predictions(halt_id) 
  WHERE was_direction_correct IS NULL;
CREATE INDEX idx_elo_history_user ON elo_history(user_id);
CREATE INDEX idx_alerts_halt ON alerts(halt_id);
CREATE INDEX idx_alpaca_trades_date ON alpaca_trades(DATE(created_at));
```

---

## MONITOR ARCHITECTURE (Python — Railway)

### CRITICAL: Do This Differently From HaltPredict V1

The V1 monitor has a 1,400-line single-threaded loop with cascading silent failures.
V2 must be async-first with explicit error isolation.

```python
# v2/monitor.py — clean async architecture

import asyncio
from datetime import datetime, timezone
from typing import Optional
import os

# CRITICAL LESSON 1: Always store timestamps as UTC
def now_utc() -> str:
    return datetime.now(timezone.utc).isoformat()

# CRITICAL LESSON 2: Never store naive ET strings
# WRONG: halt_time = parsed_et.strftime("%Y-%m-%dT%H:%M:%S")
# RIGHT: halt_time = parsed_et_aware.astimezone(timezone.utc).isoformat()

async def main():
    """Main monitor loop."""
    while True:
        if not is_market_hours():
            await asyncio.sleep(60)
            continue
            
        try:
            halts = await rss.fetch_halts()
            new_halts = [h for h in halts 
                        if h['halt_id'] not in seen_halts
                        and h['reason_code'] in ALLOWED_CODES]
            
            if new_halts:
                # CRITICAL LESSON 3: Process ALL halts concurrently
                # Never let one halt's Polygon timeout kill others
                results = await asyncio.gather(
                    *[process_halt(h) for h in new_halts],
                    return_exceptions=True  # isolates failures
                )
                
                for halt, result in zip(new_halts, results):
                    if isinstance(result, Exception):
                        log(f"[HALT ERROR] {halt['halt_id']}: {result}")
                    else:
                        seen_halts.add(halt['halt_id'])
                
                # CRITICAL LESSON 4: Update cutoff AFTER full batch
                # Not inside the loop — causes same-timestamp halts to be skipped
                latest = max(h['halt_time'] for h in new_halts)
                update_cutoff(latest)
            
            # Write heartbeat every poll
            await write_heartbeat(halts_today=len(seen_halts))
            
        except Exception as e:
            log(f"[POLL ERROR] {e}")
        
        await asyncio.sleep(30)


async def process_halt(halt: dict):
    """Process a single halt through the full pipeline."""
    halt_id = halt['halt_id']
    symbol = halt['symbol']
    
    try:
        # Step 1: Ensure DB row exists
        await ensure_active_halt_row(halt)
        await pipeline_update(halt_id, t_halt_detected=now_utc())
        
        # Step 2: Fetch halt price from Polygon
        # Only fire alerts if we get a price
        halt_price = await polygon.get_halt_price(symbol)
        if halt_price and halt_price > 0:
            await pipeline_update(halt_id, 
                halt_price=halt_price,
                t_halt_price_set=now_utc()
            )
            
            # Step 3: Open prediction gate
            closes_at = (datetime.now(timezone.utc) + 
                        timedelta(minutes=10)).isoformat()
            await pipeline_update(halt_id,
                prediction_closes_at=closes_at,
                t_prediction_gate_open=now_utc(),
                pipeline_status='gate_open'
            )
            
            # Step 4: Fire marketing
            await fire_all_alerts(halt, halt_price)
            await pipeline_update(halt_id, 
                t_marketing_fired=now_utc(),
                pipeline_status='marketed'
            )
        else:
            log(f"[SKIP-ALERT] {symbol}: no price from Polygon")
            
    except Exception as e:
        log(f"[PROCESS ERROR] {halt_id}: {type(e).__name__}: {e}")
        raise  # re-raise so gather() captures it


async def pipeline_update(halt_id: str, **fields):
    """
    Update active_halts with pipeline timestamps.
    
    CRITICAL LESSONS from V1:
    1. ALWAYS check HTTP status code — requests returns 2xx on 400/403/500
    2. ALWAYS log errors — never bare except pass
    3. Check for 0 rows matched (halt row may not exist yet)
    """
    try:
        response = await supabase.patch(
            f'/rest/v1/active_halts?halt_id=eq.{halt_id}',
            json=fields,
            headers={'Prefer': 'return=representation'}
        )
        
        if response.status_code >= 400:
            log(f"[PIPELINE ERROR] {halt_id} HTTP {response.status_code}: "
                f"{response.text[:300]}")
            return
            
        rows = response.json()
        if not rows:
            log(f"[PIPELINE WARN] {halt_id}: PATCH matched 0 rows — "
                f"active_halts row missing for fields: {list(fields.keys())}")
            
    except Exception as e:
        log(f"[PIPELINE EXCEPTION] {halt_id} — "
            f"{type(e).__name__}: {e}")
        import traceback
        traceback.print_exc()


def handle_rss_resumptions(resumptions, quote_resumptions):
    """
    CRITICAL: RSS has two separate fields.
    field[8] = ResumptionQuoteTime  → DO NOT RESOLVE
    field[9] = ResumptionTradeTime  → TRIGGERS RESOLVE
    
    V1 bug: was resolving on quote time. 
    Caused premature resolves like AFJK showing UP 39% 
    before it actually reopened.
    """
    for r in quote_resumptions:
        # Quote only — just log it, do NOT resolve
        pipeline_update(r.halt_id, 
            t_quote_resumption=now_utc(),
            pipeline_status='quoted'
        )
        log(f"[QUOTE-RESUME] {r.symbol} — waiting for trade resumption")
    
    for r in resumptions:
        # Trade resumption — this triggers the resolve
        pipeline_update(r.halt_id,
            t_trade_resumption=now_utc(),
            pipeline_status='trade_resumed'
        )
        asyncio.create_task(resolve_halt(r))


async def resolve_halt(resumption):
    """Resolve a halt after trade resumption confirmed."""
    halt_id = resumption.halt_id
    symbol = resumption.symbol
    
    # Wait 30 seconds for price discovery before fetching
    # V1 lesson: entering immediately gets the chaotic first-print price
    log(f"[RESOLVE] {symbol} — waiting 30s for price discovery")
    await asyncio.sleep(30)
    
    resume_price = await polygon.get_last_trade(symbol)
    if not resume_price:
        log(f"[RESOLVE ERROR] {symbol}: no price from Polygon")
        return
    
    halt = await get_halt(halt_id)
    halt_price = halt['halt_price']
    
    direction = 'UP' if resume_price > halt_price else 'DOWN'
    gap_pct = round((resume_price - halt_price) / halt_price * 100, 2)
    
    await pipeline_update(halt_id,
        resume_price=resume_price,
        reopen_direction=direction,
        reopen_gap_pct=gap_pct,
        t_reopen_price_set=now_utc(),
        is_active=False,
        pipeline_status='resolved'
    )
    
    # Score predictions
    await score_predictions(halt_id)
    await pipeline_update(halt_id, 
        t_predictions_scored=now_utc(),
        pipeline_status='scored'
    )
    
    # Fire resolve marketing
    await fire_resolve_alerts(halt_id, symbol, direction, gap_pct, resume_price)
    await pipeline_update(halt_id,
        t_marketing_resolved=now_utc(),
        pipeline_status='complete'
    )
    
    # Run postmortem
    await run_postmortem(halt_id)
    
    # Update DNA profile
    await update_dna_profile(symbol, halt_id, direction, gap_pct)


# ALLOWED REASON CODES — only LULD halts
ALLOWED_CODES = {'LUDP', 'LUDS', 'IPO'}
# Filter out: M (market-wide), T1/T2/T3 (news), H11 (ops), etc.
```

---

## SCORING ENGINE

```python
# v2/scoring/score_predictions.py

def score_predictions(halt_id: str, supabase):
    """
    Score all unscored predictions for a halt.
    Called automatically after resume_price is set.
    """
    # Get halt result
    halt = supabase.table('active_halts')\
        .select('halt_price,resume_price,symbol,halt_number')\
        .eq('halt_id', halt_id).single().execute().data
    
    if not halt['resume_price'] or not halt['halt_price']:
        log(f"[SCORE] {halt_id} skipped — missing price data")
        return
    
    actual_direction = ('UP' if halt['resume_price'] > halt['halt_price'] 
                       else 'DOWN')
    
    # H1 carry-forward: if this is H2+, also score H1 predictions
    # Users who predicted on H1 should get scored on H2's result
    preds = supabase.table('user_predictions')\
        .select('*').eq('halt_id', halt_id)\
        .is_('was_direction_correct', None).execute().data
    
    halt_number = halt.get('halt_number', 1)
    if halt_number > 1:
        symbol = halt['symbol']
        date_str = halt_id.split('-')[1:4]  # extract YYYY-MM-DD
        h1_id = f"{symbol}-{'-'.join(date_str)}-1"
        h1_preds = supabase.table('user_predictions')\
            .select('*').eq('halt_id', h1_id)\
            .is_('was_direction_correct', None).execute().data
        preds = preds + h1_preds
    
    for pred in preds:
        try:
            correct = pred['predicted_direction'] == actual_direction
            price_error = abs(halt['resume_price'] - (pred['predicted_price'] or 0))
            price_error_pct = (price_error / halt['resume_price'] * 100 
                             if halt['resume_price'] else 999)
            
            # ELO calculation
            # +32: correct direction AND price within 5% of resume (sharp call)
            # +16: correct direction
            # -16: wrong direction
            sharp_call = correct and price_error_pct <= 5.0
            elo_change = 32 if sharp_call else (16 if correct else -16)
            
            # Get current ELO
            elo_row = supabase.table('elo_history')\
                .select('elo_after').eq('user_id', pred['user_id'])\
                .order('created_at', desc=True).limit(1).execute().data
            elo_before = elo_row[0]['elo_after'] if elo_row else 1000
            elo_after = max(100, elo_before + elo_change)
            
            # Update prediction
            supabase.table('user_predictions').update({
                'was_direction_correct': correct,
                'actual_reopen_price': halt['resume_price'],
                'actual_direction': actual_direction,
                'price_error': round(price_error, 4),
                'price_error_pct': round(price_error_pct, 2),
                'elo_change': elo_change,
                'elo_before': elo_before,
                'elo_after': elo_after,
                'resolved_at': now_utc()
            }).eq('id', pred['id']).execute()
            
            # Insert ELO history row
            # NOTE: column is 'was_correct' not 'correct' in elo_history table
            supabase.table('elo_history').insert({
                'user_id': pred['user_id'],
                'halt_id': halt_id,
                'symbol': halt['symbol'],
                'elo_before': elo_before,
                'elo_after': elo_after,
                'elo_change': elo_change,
                'was_correct': correct,  # NOT 'correct'
            }).execute()
            
        except Exception as e:
            log(f"[SCORE ERROR] prediction {pred['id']}: {e}")
            continue  # never let one bad prediction kill the batch
    
    log(f"[SCORE] {halt_id} — scored {len(preds)} predictions, "
        f"direction={actual_direction}")
```

---

## TRADING BOT

```python
# v2/trading/order_manager.py — key parameters

# STOP LOSS AND TAKE PROFIT
# V1 used -8%/+25% — too tight, caused stop-outs before real moves
# V2 uses -15%/+40% — gives price room to breathe
STOP_LOSS_PCT = 0.85    # entry * 0.85 = -15%
TAKE_PROFIT_PCT = 1.40  # entry * 1.40 = +40%
ENTRY_LIMIT_PCT = 1.01  # IOC limit at +1% above resume (was +2% in V1)

# ENTRY DELAY
# V1 entered immediately at trade resumption
# LULD halts have violent price oscillation in first 30 seconds
# V2 waits 30 seconds, then fetches fresh Polygon price
ENTRY_DELAY_SECONDS = 30

# POSITION SIZING
# Paper: $1,000 per trade
# Live: configurable via env var
POSITION_SIZE_USD = float(os.getenv('POSITION_SIZE_USD', '1000'))

# SAFETY GUARDS
# Never trade if:
# 1. Same symbol already has open position
# 2. Score below threshold (52)
# 3. STALE halt (fired > 480s ago)
# 4. After 15:45 ET (EOD cutoff)
# 5. T1/T2/T3 reason codes (news-pending — unpredictable)
# 6. Price < $1.00 (penny stocks — too volatile)
# 7. DOWN halts on penny stocks (hard to borrow)

SCORE_THRESHOLD = 52
STALE_HALT_SECONDS = 480
EOD_CUTOFF_HOUR = 15
EOD_CUTOFF_MINUTE = 45
MIN_PRICE_FOR_SHORT = 2.00
```

---

## FRONTEND ARCHITECTURE

### Route Structure
```
/                           Landing page
/live-feed                  Dashboard with live halt cards
/predict/[halt_id]          ← PRIMARY ACTION PAGE — prediction card
/halts/[symbol]             Halt detail + history
/my-predictions             User's prediction history + ELO chart
/leaderboard                Global ELO leaderboard
/track-record               Platform accuracy stats
/pricing                    Subscription tiers
/how-it-works               Education
/verify                     KYC (Stripe Identity)
/api/predict/[halt_id]      GET + POST prediction
/api/webhooks/haltpredict   Receives halt events from monitor
/api/og/[halt_id]           Dynamic OG image generation
```

### /predict/[halt_id] — THE MOST IMPORTANT PAGE

This is the primary user action. Every alert links here.
Three data-driven states — no conditional routing:

```typescript
// State derived entirely from DB — no client state management
type PredictionState = 
  | 'loading'
  | 'open'      // resume_price IS NULL AND no user prediction
  | 'locked'    // resume_price IS NULL AND user has prediction
  | 'resolving' // resume_price IS NOT NULL but not yet scored
  | 'result'    // was_direction_correct IS NOT NULL

// STATE: OPEN
// Shows price input with live direction preview
// User types: $52.00 → live preview: "↑ UP +24.4%"
// Submit → POST /api/predict/[halt_id]

// STATE: LOCKED  
// Shows user's locked prediction
// Polls every 10s for resume_price
// Supabase Realtime subscription for instant update

// STATE: RESOLVING
// Shows "Calculating result..." for ~5-10s
// Waits for was_direction_correct to populate

// STATE: RESULT
// Shows result card with ELO change
// Share button with pre-filled tweet
```

### Prediction Submission API
```typescript
// POST /api/predict/[halt_id]
// Body: { predicted_price: number }

// Server derives direction — never trust client
const direction = predicted_price > halt_price ? 'UP' : 'DOWN'

// Validates:
// 1. predicted_price > 0
// 2. halt_price exists (not null)
// 3. predicted_price !== halt_price (no FLAT)
// 4. User hasn't predicted this halt (UNIQUE constraint)
// 5. Prediction window open OR fallback allow

// On duplicate (user double-clicks):
// Handle 23505 unique violation → return existing prediction
// Show LOCKED state — idempotent
```

### Alert URLs — ALWAYS /predict/[halt_id]
```python
# marketing_agent.py — ALL alerts link here
PREDICT_URL = f"https://haltmarket.com/predict/{halt_id}"

# Telegram button
{"text": "🎯 Make Your Call", "url": PREDICT_URL}

# Twitter tweet
f"🔴 {SYMBOL} halted at ${halt_price}\nLock in your reopen prediction:\n{PREDICT_URL}"

# Push notification
{"click_action": PREDICT_URL}

# Discord embed
{"url": PREDICT_URL}

# NEVER link to /dashboard — this was a major V1 bug
```

### AI Lean — Hidden Until After Prediction
```typescript
// V1 showed AI lean before user submitted
// This undermines skill-based mechanic
// V2: only show after user has locked prediction

{prediction && aiLean && (
  <div>
    Your call: {prediction.predicted_price} | 
    AI says: {aiLean.direction}
  </div>
)}
```

### isHaltResolved — Multi-Signal Check
```typescript
// V1 only checked resume_price — missed halts where
// Polygon failed to return price after resumption
function isHaltResolved(halt: ActiveHalt): boolean {
  if (halt.resume_price != null) return true
  if (halt.pipeline_status === 'complete') return true
  if (halt.t_trade_resumption) return true
  if (halt.t_quote_resumption) {
    const ageMs = Date.now() - parseHaltTime(halt.halt_time).getTime()
    if (ageMs > 20 * 60 * 1000) return true  // 20min stale
  }
  return false
}
```

### Halt Time Display — Parse as ET Wall Clock
```typescript
// CRITICAL V1 BUG: monitor stores naive ET string without timezone
// e.g. "2026-04-14T09:36:18" — Postgres treats as UTC
// new Date("2026-04-14T09:36:18") parses as UTC = 5:36 AM ET (wrong)
// new Date("2026-04-14T09:36:18+00:00") also UTC = 5:36 AM ET (wrong)

// Fix: treat the stored string as ET wall clock
function parseHaltTime(haltTimeStr: string): Date {
  const naive = haltTimeStr.replace(/\+00:00$/, '').replace('Z', '')
  // Determine ET offset (EDT=-4, EST=-5)
  const ref = new Date(naive + 'Z')
  const edtRef = new Date('2026-03-08T07:00:00Z') // DST start 2026
  const offset = ref >= edtRef ? '-04:00' : '-05:00'
  return new Date(naive + offset)
}

// NOTE: The REAL fix is in the monitor — store UTC properly
// This is belt-and-suspenders for historical data
```

---

## DYNAMIC OG IMAGES

```typescript
// /api/og/[halt_id]/route.tsx — @vercel/og

// While halt is open:
// ┌─────────────────────────────┐
// │  🔴 LIVE HALT               │
// │  AFJK    H4   NASDAQ        │
// │  $41.79  LUDP               │
// │  haltmarket.com             │
// └─────────────────────────────┘

// After resolve:
// ┌─────────────────────────────┐
// │  ✅ RESOLVED  +44.8%        │
// │  AFJK  $41.79 → $60.51     │
// │  ↑ UP  Aimei Health Tech    │
// │  haltmarket.com             │
// └─────────────────────────────┘

// Used in <meta og:image> on /predict/[halt_id]
// Makes every shared link unfurl into a rich card
// Drives organic viral sharing when users share results
```

---

## MARKETING CADENCE

For each halt, fire 3 posts across all channels:

```python
# POST 1 — at halt detection (T+0)
f"""🔴 {SYMBOL} HALTED at ${halt_price}
Halt #{halt_number} today

Where does it reopen?
Lock in your price prediction:
haltmarket.com/predict/{halt_id}"""

# POST 2 — at T+8 minutes (60s before window closes)
f"""⏰ 60 seconds left on {SYMBOL}
{n_predictions} traders have called it

Last chance to lock in your prediction:
haltmarket.com/predict/{halt_id}"""

# POST 3 — at resolve
f"""✅ {SYMBOL} resolved {direction} {gap_pct:+.1f}%
${halt_price} → ${resume_price}

See how traders called it:
haltmarket.com/predict/{halt_id}"""
```

---

## COMPETITOR ANALYSIS

### Kalshi (kalshi.com)
- CFTC-regulated DCM since 2022
- Owns CPI, GDP, FOMC, employment markets
- USD settlement via bank ACH
- Limit orderbook pricing
- $250M raised, ~$1B valuation
- **Gap HaltMarket fills**: No halt-specific markets. 
  No sector-specific panels. No real-time event markets.

### Polymarket (polymarket.com)
- World's largest prediction market by volume
- USDC/crypto settlement — significant retail friction
- AMM pricing (LMSR)
- No CPI/GDP/FOMC markets (Kalshi-exclusive)
- Acquired QCEX (CFTC DCE) July 2025
- EU banned in France, Spain, Netherlands
- **Gap HaltMarket fills**: No halt markets. USD settlement.
  Retail-friendly onboarding.

### Manifold Markets (manifold.markets)
- Play money only
- Social prediction markets
- No CFTC regulation
- **Gap**: Not real money, no halts

### HaltPredict (haltpredict.com) — Sister Platform
- Subscription B2B/B2C ($29-99/mo)
- AI scoring with 3303 DNA profiles
- Real-time halt detection
- Alpaca trading bot
- **Relationship**: HaltMarket consumes HaltPredict API.
  HP subscribers see AI score before market opens (their edge).
  Non-subscribers see market prices only.

### Why HaltMarket Wins
1. **Only** CFTC-regulated halt prediction exchange
2. **Automated settlement** — NASDAQ RSS is federal exchange data
3. **Real-time** — markets open/close in minutes, not days
4. **Skill-based** — price input, not just direction
5. **Proprietary edge** — HaltPredict AI score available to subscribers
6. **No crypto friction** — USD via Stripe

---

## CFTC COMPLIANCE LAYER

### Preliminary Approval Limits
- Position limit: $2,500 per outcome
- Aggregate exposure cap: $15,000 per user
- Retail accessible (not accredited only)

### KYC Flow (Stripe Identity)
```typescript
// Before first trade, require identity verification
// /verify route → Stripe Identity session
// On complete → kyc_verified = true on users table
// Required for: any real-money position
// Not required for: free tier play tokens
```

### Pre-Trade Checks
```typescript
async function canUserTrade(userId: string, amount: number): Promise<boolean> {
  const limits = await getUserLimits(userId)
  
  if (!limits.kyc_verified) return false  // KYC required
  if (limits.is_restricted) return false   // Compliance hold
  if (amount > limits.position_limit_usd) return false  // $2,500 cap
  if (limits.current_exposure_usd + amount > limits.aggregate_cap_usd) return false  // $15K cap
  
  return true
}
```

---

## HALTPREDICT API INTEGRATION

```typescript
// HaltMarket consumes HaltPredict's halt detection

// Webhook receiver: POST /api/webhooks/haltpredict
// Payload: { halt_id, symbol, halt_number, halt_price,
//            ai_score, ai_prediction, halt_time, api_key }

// On receipt:
// 1. Verify api_key === process.env.HALTPREDICT_API_KEY
// 2. Upsert to active_halts
// 3. Return 200 immediately (don't block)
// 4. Async: open prediction gate, fire alerts

// HaltPredict subscribers who also have HaltMarket accounts:
// → See AI score revealed after they lock prediction
// → Get early alert (subscribers get alerts 30s before public)
// Non-subscribers:
// → See market prices only (crowd wisdom)
// → Upsell banner to HaltPredict subscription
```

---

## POSTMORTEM SYSTEM

After every halt reaches pipeline_status='complete':

```python
async def run_postmortem(halt_id: str):
    """Check all pipeline timestamps and report missing ones."""
    halt = await get_halt(halt_id)
    issues = []
    
    checks = [
        ('t_halt_detected', 'critical', 'Halt detection not recorded'),
        ('t_halt_price_set', 'critical', 'Polygon price fetch failed'),
        ('t_marketing_fired', 'warning', 'Marketing alerts not sent'),
        ('t_prediction_gate_open', 'critical', 'Prediction gate never opened'),
        ('t_quote_resumption', 'info', 'Quote resumption not logged'),
        ('t_trade_resumption', 'critical', 'Trade resumption not detected'),
        ('t_reopen_price_set', 'critical', 'Resume price not fetched'),
        ('t_predictions_scored', 'warning', 'Predictions not scored'),
        ('t_marketing_resolved', 'warning', 'Resolve alerts not sent'),
    ]
    
    for field, severity, description in checks:
        if halt.get(field) is None:
            issues.append({
                'halt_id': halt_id,
                'symbol': halt['symbol'],
                'check_name': f'missing_{field}',
                'severity': severity,
                'description': description
            })
    
    # Also check marketing delivery
    alerts = await get_alerts_for_halt(halt_id)
    channels = {a['channel'] for a in alerts}
    for channel in ['telegram', 'twitter', 'discord']:
        if channel not in channels:
            issues.append({
                'halt_id': halt_id,
                'symbol': halt['symbol'],
                'check_name': f'missing_{channel}_alert',
                'severity': 'warning',
                'description': f'No {channel} alert recorded'
            })
    
    if issues:
        await supabase.table('halt_issues').insert(issues).execute()
        criticals = [i for i in issues if i['severity'] == 'critical']
        if criticals:
            await post_discord_postmortem(halt_id, halt['symbol'], criticals)
```

---

## BUILD ORDER

Follow this exact sequence. Each phase deploys before starting next.

### Phase 1 — Foundation (Day 1)
```
1. Supabase project created (sqjdfafewyphoroaivqq)
2. Apply all schema migrations above
3. Python monitor skeleton:
   - RSS reader with LULD filter
   - Async concurrent halt processing
   - pipeline_update with status code checking
   - Supabase rebuild on startup (no in-memory state)
4. Deploy to Railway, confirm healthcheck
5. Verify first halt writes all t_ timestamps correctly
```

### Phase 2 — Core Product (Day 2)
```
6. /predict/[halt_id] page — 3 states
7. POST /api/predict/[halt_id] — submission
8. GET /api/predict/[halt_id] — data fetch
9. Supabase Realtime subscription for live updates
10. Alert URLs → /predict/{halt_id}
11. Test full loop: halt fires → gate opens → predict → resolve → score
```

### Phase 3 — Platform (Day 3)
```
12. /my-predictions — prediction history + ELO chart
13. /leaderboard — global rankings
14. /live-feed — dashboard with halt cards
15. OG image generation /api/og/[halt_id]
16. 3-post marketing cadence per halt
17. Discord postmortem
```

### Phase 4 — Monetization (Day 4)
```
18. Stripe subscription flow
19. Subscription tier gating (trader tier)
20. KYC flow (Stripe Identity) — required for CFTC compliance
21. Position limits enforcement
22. HaltPredict API integration (AI score reveal)
```

### Phase 5 — Trading Bot (Day 5)
```
23. Alpaca integration (copy from V1 order_manager.py)
24. Apply V2 parameters: -15% SL, +40% TP, 30s delay
25. Supabase rebuild of pending trades on startup
26. alpaca_trades table full lifecycle
```

---

## KNOWN ISSUES FROM V1 — DO NOT REPEAT

| # | Issue | Root Cause | Fix |
|---|-------|-----------|-----|
| 1 | Halt timestamps NULL | `_pipeline_update` HTTP 4xx not checked | Always check status_code |
| 2 | Premature resolve | RSS field[8] (quote) used instead of field[9] (trade) | Only resolve on field[9] |
| 3 | Repeat halts missed | `seen_halts` keyed on symbol not halt_id | Key on halt_id |
| 4 | Concurrent halts — only first processed | No try/except in loop, exception kills batch | asyncio.gather with return_exceptions=True |
| 5 | Stop-outs before big moves | SL -8% too tight, instant entry at resumption | SL -15%, 30s delay |
| 6 | Wrong halt in gate | `?halt_id=` param ignored, page loads latest halt | Exact halt_id lookup only |
| 7 | Alert → dashboard | All alert URLs pointed to /dashboard | All → /predict/{halt_id} |
| 8 | AI lean visible before prediction | Rendered without prediction guard | Only show after prediction locked |
| 9 | Zombie predict CTAs | Only hid on resume_price IS NOT NULL | Multi-signal isHaltResolved check |
| 10 | Halt time 4-5hrs wrong | Naive ET string stored, Postgres treats as UTC | Store UTC, parse as ET in frontend |
| 11 | Scoring never ran | `supabase` not in requirements.txt | Always verify requirements.txt |
| 12 | Twitter 401 | Tokens generated before Write permissions enabled | Enable Read+Write FIRST, then generate |
| 13 | `in_memory` state lost on restart | pending_halts not rebuilt from Supabase | Always rebuild ALL state from DB on startup |
| 14 | AFJKU/non-LULD halts processed | No reason code filter | ALLOWED_CODES = {'LUDP', 'LUDS', 'IPO'} |
| 15 | prediction_closes_at never set | `_pipeline_update` 0 rows matched | Ensure active_halts row exists first |

---

## SKILLS NEEDED FOR THIS BUILD

Claude Code should reference these skill files when working on specific tasks:

- **Frontend UI components**: Read `/mnt/skills/public/frontend-design/SKILL.md` before any React/Next.js component work
- **Database migrations**: Use `apply_migration` for DDL, `execute_sql` for queries
- **File creation**: Any file >100 lines → iterative build approach
- **TypeScript**: Strict mode, no `any` types
- **Python async**: Use `asyncio.gather` with `return_exceptions=True` for concurrent operations
- **Supabase Realtime**: Use channel subscriptions for live halt updates vs polling
- **Vercel OG**: Use `@vercel/og` for dynamic halt result images
- **Stripe**: Use webhook `checkout.session.completed` for subscription tier updates

---

## TESTING CHECKLIST FOR EVERY HALT

Run this after every deploy to verify pipeline integrity:

```sql
-- Should ALL be non-null for a properly processed halt
SELECT 
  halt_id,
  t_halt_detected IS NOT NULL as step1_detected,
  t_halt_price_set IS NOT NULL as step2_priced,
  prediction_closes_at IS NOT NULL as step3_gate,
  t_marketing_fired IS NOT NULL as step4_marketed,
  t_quote_resumption IS NOT NULL as step5_quoted,
  t_trade_resumption IS NOT NULL as step6_traded,
  t_reopen_price_set IS NOT NULL as step7_resolved,
  t_predictions_scored IS NOT NULL as step8_scored,
  t_marketing_resolved IS NOT NULL as step9_notified,
  pipeline_status = 'complete' as step10_complete
FROM active_halts
WHERE DATE(halt_time) = CURRENT_DATE
ORDER BY halt_time DESC
LIMIT 10;
```

Expected output for a healthy system: all columns TRUE.
Any FALSE = bug to investigate immediately.

---

## SUPABASE PROJECT

- Project: haltmarket
- URL: https://sqjdfafewyphoroaivqq.supabase.co
- Ref: sqjdfafewyphoroaivqq
- MCP: supabase-haltmarket (once configured)

---

## DOMAIN & HOSTING

- Domain: haltmarket.com (registered April 14, 2026)
- Frontend: Vercel — connect to haltmarket GitHub repo
- Monitor: Railway — new service, Python 3.11
- DB: Supabase project sqjdfafewyphoroaivqq

---

*This document is the single source of truth for HaltMarket V1 build.*
*Update it as new decisions are made. Do not build anything not in this doc*
*without adding it here first.*
