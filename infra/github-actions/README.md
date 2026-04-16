# infra/github-actions

Workflow definitions live in `.github/workflows/` (GitHub's required location). This directory documents each workflow and the required repo secrets / vars.

## Workflows

### `ci.yml`
Runs on every PR and push to `main`.

- **node** — `pnpm install`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.
- **python** — `uv sync` + `ruff` + `mypy` + `pytest` for both `apps/monitor` and `apps/resolver`.
- **supabase** — `supabase db lint` on any SQL migration (no-op before Phase 1 lands migrations).
- **ledger-guard** — fails if a changed migration `UPDATE`s or `DELETE`s `ledger_entries` (`AGENTS.md` §5 rule 5, ADR-0001).

### `deploy.yml`
Runs on pushes to `main`. Each job is gated on an `ENABLE_*` repo variable so deploys stay off until the operator wires real secrets.

- **vercel** — `vercel deploy --prod` for `apps/web`. Requires `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`.
- **supabase-migrate** — `supabase db push` to the linked project. Requires `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, and the `SUPABASE_PROJECT_REF` variable.
- **railway** — deploys `haltmarket-monitor` and `haltmarket-resolver`. Requires `RAILWAY_TOKEN`.

## Repo variables (`Settings → Secrets and variables → Actions → Variables`)

| Name | Purpose |
|---|---|
| `ENABLE_VERCEL_DEPLOY` | `true` once the Vercel project is wired |
| `ENABLE_SUPABASE_DEPLOY` | `true` once prod migrations should auto-push |
| `ENABLE_RAILWAY_DEPLOY` | `true` once Railway services exist |
| `SUPABASE_PROJECT_REF` | `gidbmzzbwmodmwlbsngv` |

## Repo secrets

See `.env.example` for the full list. Each deploy job documents which ones it reads.
