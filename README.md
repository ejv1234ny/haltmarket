# HaltMarket

CFTC-preliminary-approved, skill-based prediction exchange for NASDAQ LULD trading halts.

Every LULD halt on NASDAQ automatically creates a live prediction market. Users predict the exact reopen price; direction (UP/DOWN) is derived from their price vs. the halt price. Markets resolve automatically via NASDAQ RSS + Polygon price data. ELO rating system tracks accuracy over time.

## Architecture

- **web/** — Next.js 14 (App Router) frontend, deployed to Vercel
- **monitor/** — Python async monitor + scoring + trading, deployed to Railway
- **migrations/** — Supabase SQL migrations

## Stack

Next.js 14, TypeScript, Tailwind, Supabase (Postgres + Realtime), Alpaca, Stripe, Polygon, NASDAQ RSS, Telegram/Twitter/Discord/Web Push.

## Setup

See `CLAUDE.md` for the full build spec — single source of truth for this project.

Copy `monitor/.env.example` → `monitor/.env` and `web/.env.local.example` → `web/.env.local`, then fill in credentials.

## Build Phases

1. Foundation — folder structure, V1 copies, schema (this setup)
2. Core product — `/predict/[halt_id]`, API, Realtime
3. Platform — leaderboard, dashboard, OG images, marketing cadence
4. Monetization — Stripe, KYC, HaltPredict API integration
5. Trading bot — Alpaca integration with V2 params

## Related

- `haltpredict.com` — sister platform providing AI scoring
- Supabase project: `sqjdfafewyphoroaivqq`
