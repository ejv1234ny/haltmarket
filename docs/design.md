# LUDP Halt Prediction Market — System Design

**Status:** Design proposal — not yet approved.
**Scope:** Real-money prediction market for the reopen price of NASDAQ LUDP halts, ingested from the Nasdaq Trader RSS feed. Polymarket-like UX, compressed into a 5-minute halt window.

---

## 1. Summary

The platform ingests NASDAQ LUDP halts in real time, spins up a short-lived prediction market per halt, notifies opted-in users, accepts stakes from their deposited balance, captures the official reopen price, and settles winners automatically, retaining a fee on volume.

The defining constraint is **time**: LUDP halts last roughly 5 minutes, with most betting volume crammed into the first 60-90 seconds. This rules out classical order-book / AMM market-making (too little time to bootstrap liquidity) and pushes the design toward a **parimutuel pool over a price ladder**.

---

## 2. Requirements

### 2.1 Functional

| # | Requirement |
|---|---|
| F1 | Detect every LUDP halt within 5s of RSS publication |
| F2 | Atomically create a market (with price ladder) and open betting |
| F3 | Fan out notifications (push, SMS, email, in-app) to opted-in users |
| F4 | Accept stakes with strict deadline enforcement |
| F5 | Stream live pool sizes, implied odds, time-to-close to viewers |
| F6 | Detect reopen and capture official opening-cross price from Polygon |
| F7 | Resolve: winning bin, pro-rata payouts, house fee |
| F8 | Credit winners' wallets, expose settlement transparently |
| F9 | Deposits, withdrawals, KYC, responsible-gambling limits |
| F10 | Refund all stakes (no fee) on unresolved markets |

### 2.2 Non-functional

- **Latency:** halt→market-open p95 < 3s; halt→first-push p95 < 5s; bet submission p95 < 500ms; reopen→settlement p95 < 30s
- **Throughput:** 1000 concurrent users per market; peak 100 LUDP halts/day; ~50K bets/day target
- **Availability:** 99.9% during market hours (4am-8pm ET)
- **Financial integrity:** double-entry ledger; zero tolerance for wallet drift
- **Regulatory:** KYC before first deposit; geo-blocking; per-user deposit limits

### 2.3 Constraints

- **5-minute window.** Mechanism must work with minutes of liquidity.
- **Slow RSS feed.** Baseline latency halt→feed is 5-15s.
- **Regulatory.** Real-money prediction markets on US securities outcomes are in a gray zone. See §10.
- **Existing stack.** Supabase Postgres + Polygon + Railway. Reuse where possible.

---

## 3. High-Level Architecture

```
                        ┌───────────────────────────┐
                        │ Nasdaq Trader RSS (LUDP)  │
                        │ Polygon (prices + halts)  │
                        └──────────┬────────────────┘
                                   │
                          ┌────────▼────────────┐
                          │  Halt Ingestor      │
                          │  (hot-standby pair) │
                          └────────┬────────────┘
                                   │ create halt + market
                                   ▼
┌───────────────────────────────────────────────────────────────────────┐
│                          Supabase (Postgres + Realtime)                │
│  halts | markets | bins | bets | wallets | ledger | users | kyc       │
│  deposits | withdrawals | resolutions | payouts | notifications       │
└──┬─────────┬────────────┬────────────┬─────────────┬──────────────────┘
   │         │            │            │             │
   ▼         ▼            ▼            ▼             ▼
┌─────┐ ┌────────┐  ┌──────────┐ ┌──────────┐  ┌─────────────┐
│ Web │ │ Mobile │  │ Notifier │ │ Payment  │  │ Resolution  │
│ SPA │ │ (PWA)  │  │ Worker   │ │ Gateway  │  │ Worker      │
└─────┘ └────────┘  └──────────┘ └──────────┘  └─────────────┘
```

**Components.** Halt Ingestor (Python, hot-standby via advisory lock). Supabase as system of record + realtime transport. Notifier (Deno edge function, fans out push/SMS/email with DLQ). Payment Gateway (Stripe or crypto on-ramp; reflects to ledger). Resolution Worker (Python, polls Polygon for reopens). Web/Mobile (thin clients on realtime channels).

---

## 4. Core Design Decisions

### 4.1 Market mechanism: parimutuel pool on a log-spaced price ladder

**Decision.** For each halt, 20 bins between `0.5 × last_price` and `2.0 × last_price`, log-spaced. Users stake into one or more bins. At reopen, the bin containing the official cross price wins. Winners split `total_pool × (1 − fee)` pro-rata to their stake in the winning bin.

**Why parimutuel over AMM/CLOB.**

| Criterion | Parimutuel | AMM (LMSR) | CLOB |
|---|---|---|---|
| Works with 5 min of liquidity | ✅ | ⚠️ needs seed capital | ❌ empty book |
| Seed capital required | $0 | Significant | Significant |
| Implied odds display | `bin_stake / total` | Math | Spread-derived |
| Complexity to ship | Low | High | Very high |

**Ladder construction.** From last price `P`: 20 bins log-spaced from `P × 0.5` to `P × 2.0`; `$0.01` floor; tail bins at each extreme.

#### Closest-to-the-pin bonus layer

To recover the "guess the price, closest wins" UX vision without sacrificing the retention properties of parimutuel bins, a configurable **closest-to-the-pin bonus** is carved out of each pool.

- Users submit a numeric `predicted_price`; client rounds to the nearest bin for the parimutuel calculation but preserves the exact price on the `bets` row.
- At resolution, the pool is split: `fee_bps` to house, `closest_bonus_bps` to the single user with smallest `|predicted_price − reopen_price|`, remainder to the winning bin pro-rata.
- Defaults: `fee_bps = 500` (5%), `closest_bonus_bps = 700` (7%).
- Tie-breaking: if multiple users share the exact minimum distance, the bonus is split equally among them.
- A single user can win both the bin share and the closest bonus — they are additive credits to the same `user_wallet` within one resolution `txn_id`.

See `docs/adrs/ADR-0002-closest-to-pin-bonus.md` for full rationale and options considered.

### 4.2 Money & custody

Internal ledger holds user balances. Launch currencies:

- **USDC** (crypto) — deposited to a house-controlled address (Coinbase Prime / Fireblocks). Polymarket-style.
- **USD** (fiat, later) — via Stripe + Plaid. Requires KYC and gaming license or offshore entity.

**Internal accounting: double-entry ledger.** Every movement is two rows in `ledger_entries` summing to zero within a `txn_id`. Wallet balance = `sum(entries WHERE user_id=X)`, never stored denormalized. Invariant check hourly.

### 4.3 Notifications

Halt detection → `markets` INSERT → Supabase trigger → edge function fan-out via Web Push, Twilio, SendGrid. Circuit breaker per channel. Dead-letter on failure. Target: p95 push 5s after halt.

---

## 5. Data Model

```sql
-- Users & wallets
create table users (
  id uuid primary key,
  kyc_status text check (kyc_status in ('none','pending','approved','rejected')),
  geo_country text, geo_state text,
  self_excluded_until timestamptz,
  deposit_limit_cents int,
  created_at timestamptz default now()
);

create table wallets (
  user_id uuid references users(id),
  currency text check (currency in ('USD','USDC')),
  balance_micro bigint not null default 0,
  primary key (user_id, currency)
);

create table ledger_entries (
  id bigserial primary key,
  txn_id uuid not null,
  user_id uuid,                               -- null = house
  account text not null,                      -- 'user_wallet','house_fees','market_pool','pending_deposits'
  currency text not null,
  amount_micro bigint not null,               -- signed
  reason text not null,
  ref_market_id uuid, ref_bet_id uuid,
  created_at timestamptz default now()
);
create index on ledger_entries (user_id, created_at desc);
create index on ledger_entries (txn_id);

-- Markets
create table halts (
  id uuid primary key, symbol text, reason_code text,
  halt_time timestamptz, halt_end_time timestamptz,
  last_price numeric(12,4),
  reopen_price numeric(12,4), reopen_at timestamptz,
  reopen_source text
);

create table markets (
  id uuid primary key,
  halt_id uuid unique references halts(id),
  status text check (status in ('open','locked','resolved','refunded')),
  opened_at timestamptz, closes_at timestamptz, resolved_at timestamptz,
  currency text not null,
  total_pool_micro bigint not null default 0,
  fee_bps int not null default 500,
  winning_bin_id uuid
);

create table bins (
  id uuid primary key,
  market_id uuid references markets(id),
  idx int,
  low_price numeric(12,4),
  high_price numeric(12,4),
  stake_micro bigint not null default 0
);
create unique index on bins (market_id, idx);

create table bets (
  id uuid primary key,
  market_id uuid, bin_id uuid, user_id uuid,
  stake_micro bigint not null,
  placed_at timestamptz default now(),
  status text check (status in ('active','settled','refunded')),
  idempotency_key text,
  unique (user_id, idempotency_key)
);

create table market_resolutions (
  market_id uuid primary key references markets(id),
  reopen_price numeric(12,4),
  winning_bin_id uuid,
  gross_pool_micro bigint,
  fee_micro bigint,
  payout_pool_micro bigint,
  resolved_at timestamptz default now()
);

create table payouts (
  bet_id uuid primary key references bets(id),
  market_id uuid, user_id uuid,
  amount_micro bigint not null,
  created_at timestamptz default now()
);

-- Notifications
create table notification_prefs (
  user_id uuid primary key references users(id),
  ludp_halts boolean default true,
  min_price_range numeric,
  channels text[]                              -- ['push','sms','email']
);
```

**RLS posture.** Every user-owned table has `SELECT using (user_id = auth.uid())`; writes go through SECURITY DEFINER RPCs. No `USING (true)` permissive policies.

---

## 6. API Design (REST, JSON)

```
POST /api/v1/auth/kyc                  start KYC
GET  /api/v1/wallet                    balance + recent ledger
POST /api/v1/deposits                  initiate (idempotency-key header)
POST /api/v1/withdrawals               initiate (KYC required)

GET  /api/v1/markets?status=open       list active markets
GET  /api/v1/markets/:id               market + bins + stakes
POST /api/v1/markets/:id/bets          { bin_id, stake_micro, idem_key }
GET  /api/v1/bets?status=active        user's open bets
GET  /api/v1/markets/:id/resolution    after settle

# Realtime (Supabase)
markets:{id}         bin deltas, time remaining, status transitions
user:{id}            wallet updates, bet state, payouts
```

**Bet placement semantics.** Accepted only if: `market.status='open'` AND `now() < closes_at` AND `wallets.balance_micro ≥ stake_micro` AND `idem_key` new for user. Wallet debit + bin increment in one `SERIALIZABLE` transaction.

**Closes-at.** Default `halt_time + 90s` — before Nasdaq-published resumption time. No user with a faster feed can front-run the reopen.

---

## 7. Resolution Logic

```
1. Worker wakes every 5s
2. For markets where status='locked' AND halt_end_time < now() - 5s:
   a. Query Polygon /v3/trades/{symbol} for first post-halt_end_time print
      with opening-cross condition code (or fall back to first regular trade)
   b. If not found and halt < 15 min old: keep polling
   c. If > 15 min: mark 'refunded', refund all stakes (no fee)
3. Once reopen_price captured:
   a. Find bin containing reopen_price (or tail bin)
   b. fee = total_pool × (fee_bps / 10000)
   c. payout_pool = total_pool - fee
   d. For each active bet in winning_bin: payout = payout_pool × (bet.stake / winning_bin.stake)
   e. Write market_resolutions + payouts rows
   f. Ledger: debit market_pool, credit user_wallets + house_fees
   g. market.status = 'resolved'
4. Realtime broadcast on markets:{id}
```

All inside one transaction per market. Idempotent.

**Edge cases.** No winning bin → tail bin catches extremes. Re-halt → wait for final reopen, not intermediate.

---

## 8. Fees

- Default 5% (`fee_bps = 500`), debited at resolution to `house_fees`
- Configurable per market
- No per-bet fee — parimutuel tradition
- Display: "Pool: $15,420 · Fee: 5% · Payout pool: $14,649"

---

## 9. Scale & Reliability

### Load
- Peak halt rate: ~1/min on a bad day
- Peak concurrent users per market: 5K post-growth
- Peak bet rate: 83/sec — trivial for Postgres
- Storage: ~10K rows/day → <5GB/year

### Patterns
- Ingestor redundancy (hot-standby + advisory lock)
- Idempotent everything (bets have `idempotency_key`; resolution idempotent)
- Ledger invariants (`SUM = 0` hourly)
- Refund path for unresolvable markets (no fee)
- Graceful degradation (ledger works even if Stripe down)
- Postgres PITR; ledger is source of truth

### Monitoring
Halt-to-market latency · notification delivery · ledger invariant · market resolution rate · Polygon error rate · per-user bet velocity · refund rate.

---

## 10. Security, Fraud, Compliance

### Regulatory paths
1. **CFTC-regulated (Kalshi).** DCM/DCO registration. 12-24 months, heavy legal spend.
2. **Offshore + crypto (Polymarket).** Cayman/Curaçao, USDC only, geo-block US. Fastest.
3. **Sweepstakes / skill-game.** Virtual tokens redeemable for value. Weak argument for this product.

**Recommendation:** path 2 to validate demand; path 1 in parallel.

### Fraud mitigations
- Multi-acct: fingerprinting, IP rep, payment dedup, KYC match
- Front-running: hard close at halt+90s; server-side only
- Cross manipulation (thin stocks): cap size to ADV; exclude small caps
- Account takeover: 2FA on withdrawals; address whitelist + 24h cooldown
- Chargebacks: card funds locked 72h; withdraw to same method

### Responsible gambling
Deposit limits, self-exclusion, reality checks, lifetime P&L display, GamStop-style opt-out.

---

## 11. Rollout

Phase 0 — schema + ledger (2 wks) · Phase 1 — market engine, paper bets (3 wks) · Phase 2 — real money closed beta (4 wks) · Phase 3 — public launch (non-US) · Phase 4 — fiat rails OR CFTC filing.

---

## 12. Trade-offs Summary

| Decision | Chosen | Trade-off |
|---|---|---|
| Mechanism | Parimutuel ladder | No mid-market exit |
| Launch currency | USDC | Excludes US retail |
| Ladder | 20 log-spaced bins | Coarser for large-caps |
| Notification latency | 5s push p95 | Behind SIP feeds — fine for MVP |
| Close-at | halt + 90s | Cuts window short; protects fairness |
| Unresolved | Full refund, no fee | House eats ops cost |
| DB | Supabase Postgres | Vendor lock-in |
| Ledger | Double-entry in app DB | Coupled until >$1M volume |

---

## 13. Open Questions / Revisit

AMM overlay at avg pool > $10K · cross-halt parlays · market-maker bots · price-feed redundancy · AI-assisted odds · mobile push latency · extended halts (T12, H10) · regulatory pivot if CFTC opens for this.

---

**End of design.**
