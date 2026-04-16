# haltmarket

Real-money parimutuel prediction market for NASDAQ LUDP halt reopen prices.

Users bet on the exact reopen price of a halted stock during the 5-minute LUDP halt window. Markets auto-create from the Nasdaq RSS feed, auto-resolve from Polygon's opening-cross price, and pay out pro-rata to the bin containing the actual reopen.

## Source of truth

- `AGENTS.md` — the build plan. Claude Code executes phases in order; do not skip ahead.
- `docs/design.md` — full system design.
- `docs/adrs/ADR-0001-ledger-subsystem.md` — ledger architecture (Phase 1).
- `docs/progress.md` — phase-by-phase delivery log.
- `docs/human-tasks.md` — items deferred to the operator.

## Stack

| Layer | Tech |
|---|---|
| Database / auth / realtime | Supabase Postgres |
| Backend hot-path | Supabase Edge Functions (Deno/TS) |
| Halt monitor / resolver | Python 3.12 on Railway, managed by `uv` |
| Frontend | Next.js 14 App Router on Vercel |
| Monorepo | pnpm workspaces + Turborepo |
| Market data | Polygon.io |
| Halt feed | Nasdaq Trader RSS (LUDP only) |

## Repo layout

```
haltmarket/
├── apps/
│   ├── web/                 # Next.js 14 PWA
│   ├── monitor/             # Python halt ingestor  (Phase 2)
│   └── resolver/            # Python resolution worker (Phase 5)
├── packages/
│   ├── shared-types/        # Supabase-generated types + shared TS types
│   └── ledger-client/       # TS wrapper around the ledger RPC (Phase 1)
├── supabase/
│   ├── migrations/          # Versioned SQL, additive-only
│   ├── functions/           # Deno edge functions
│   └── config.toml          # Local stack config
├── infra/github-actions/    # CI/deploy workflow docs
├── docs/                    # design.md, adrs/, progress.md, runbooks
└── AGENTS.md                # Build plan (Phases 0-10)
```

## Prerequisites

- **Node** 20.18+ (see `.nvmrc`)
- **pnpm** 10.33+ (via `corepack enable && corepack prepare pnpm@10.33.0 --activate`)
- **Python** 3.12+ and [`uv`](https://docs.astral.sh/uv/)
- **Docker** (used by `supabase start`)
- **Supabase CLI** (`brew install supabase/tap/supabase` or see [docs](https://supabase.com/docs/guides/cli))

On GitHub Codespaces the devcontainer installs everything automatically.

## First-time setup

```bash
# 1. clone + install JS deps
git clone https://github.com/ejv1234ny/haltmarket.git && cd haltmarket
pnpm install

# 2. copy env template and fill what you need for local dev
cp .env.example .env.local

# 3. Python apps (uv creates per-app .venv)
(cd apps/monitor && uv sync --all-extras)
(cd apps/resolver && uv sync --all-extras)

# 4. Boot Supabase stack (Postgres, Studio on :54323, API on :54321)
supabase start

# 5. Run the web app
pnpm --filter @haltmarket/web dev
# → http://127.0.0.1:3000
```

## Common commands

```bash
pnpm lint           # eslint across workspace
pnpm typecheck      # tsc --noEmit across workspace
pnpm test           # vitest across workspace
pnpm build          # next build + package builds
pnpm --filter @haltmarket/web dev

# Python apps
(cd apps/monitor  && uv run haltmarket-monitor)
(cd apps/resolver && uv run haltmarket-resolver)
(cd apps/monitor  && uv run pytest && uv run ruff check . && uv run mypy)

# Supabase
supabase start | stop | status
supabase db diff --linked -f <name>    # generate a migration from the live DB (Phase 1+)
supabase db push                        # apply local migrations to the linked project
supabase functions serve                # run edge functions locally
```

## Supabase project

Linked project ref: `gidbmzzbwmodmwlbsngv` (us-east-2).

```bash
supabase link --project-ref gidbmzzbwmodmwlbsngv
```

## Status

Phase 0 — bootstrap skeleton. See `docs/progress.md` for phase history.
