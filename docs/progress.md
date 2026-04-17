# Progress log

Appended after each phase's PR merges. Format per `AGENTS.md` §8.

## Phase 7 — Frontend (mocked data)
- Merged: pending
- PR: (opened from `phase-7-frontend-mocked`)
- Tests added: 9 bin-math unit tests + 3 Playwright smoke specs (×2 projects = 6 runs)
- Open questions escalated: 0
- Notes: Next.js 14 App Router pages (`/`, `/market/[id]`, `/wallet`, `/history`, `/leaderboard`, `/sign-in`), shadcn-style primitives, Supabase auth wired against `@supabase/ssr` (magic-link + Google OAuth), PWA manifest with SVG mark, mock data layer with pub/sub realtime channels, guess-the-price bet UI per ADR-0002 (client-side auto-map to bin). All pages fall back cleanly when Supabase creds are absent. Playwright wired into CI via the official `mcr.microsoft.com/playwright` image. Phases 3-5 will replace mocks with real Supabase queries in a follow-up PR; all mock types carry `TODO(phase-N)` markers.

## Phase 0 — Bootstrap
- Merged: 2026-04-16
- PR: #2
- Tests added: 3 Node (2 ledger-client balance assertions + 1 web smoke) + 2 Python (monitor + resolver smoke)
- Open questions escalated: 0
- Notes: Monorepo, Turbo pipeline, Next.js 14 placeholder, Python skeletons (uv), Supabase local config, GitHub Actions CI with the ledger-mutation grep guard already active, gated deploy-on-merge stubs, full `.env.example`, local-dev README. All five CI jobs green on first push. No money-movement code yet — that starts in Phase 1 per ADR-0001.
