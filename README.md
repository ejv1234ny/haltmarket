# haltmarket

Real-money parimutuel prediction market for NASDAQ LUDP halt reopen prices.

Users bet on the exact reopen price of a halted stock during the 5-minute LUDP halt window. Markets auto-create from the Nasdaq RSS feed, auto-resolve from Polygon's opening-cross price, and pay out pro-rata to the bin containing the actual reopen.

## Source of truth

- `AGENTS.md` — the build plan. Claude Code executes phases in order; do not skip ahead.
- `docs/design.md` — full system design.
- `docs/adrs/ADR-0001-ledger-subsystem.md` — ledger architecture (first phase).

## Stack

| Layer | Tech |
|---|---|
| Database / auth / realtime | Supabase Postgres |
| Backend hot-path | Supabase Edge Functions (Deno/TS) |
| Halt monitor / resolver | Python on Railway |
| Frontend | Next.js 14 (App Router) on Vercel |
| Market data | Polygon.io |
| Halt feed | Nasdaq Trader RSS (LUDP only) |

## Supabase project

Ref: `gidbmzzbwmodmwlbsngv` (us-east-2, NANO / free tier).

```bash
supabase link --project-ref gidbmzzbwmodmwlbsngv
```

## Local dev

See `AGENTS.md` Phase 0 for the bootstrap.

## Status

Pre-Phase-0. Autonomous build pending.
