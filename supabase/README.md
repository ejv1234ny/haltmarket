# Supabase

Project ref: `gidbmzzbwmodmwlbsngv` (us-east-2).

## Link

```bash
supabase link --project-ref gidbmzzbwmodmwlbsngv
```

## Local stack

```bash
supabase start    # boots Postgres, GoTrue, Studio, Storage, Realtime, Inbucket
supabase stop
```

## Layout

- `migrations/` — versioned SQL, additive-only (`0001_ledger.sql` lands in Phase 1).
- `functions/` — Deno edge functions (`place-bet`, `notify-halt`, `initiate-deposit`, `initiate-withdrawal`) land in later phases.
- `config.toml` — local stack config.

## Migration discipline

Migrations must be additive. Never `ALTER`/`DROP` existing columns. Ledger tables (`wallets`, `ledger_entries`, `deposits`, `withdrawals`) are frozen outside Phase 1 — see `AGENTS.md` §5 rule 5 and `docs/adrs/ADR-0001-ledger-subsystem.md`.

A CI grep gate (`infra/github-actions/ledger-guard.yml`) fails the build on any migration that `UPDATE`s or `DELETE`s `ledger_entries`.
