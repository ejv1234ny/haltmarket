# haltmarket-monitor

Python service that polls the Nasdaq Trader LUDP RSS feed, deduplicates halts, enriches each event with a Polygon last-trade price, and inserts `halts` rows into Supabase. Phase-2 deliverable per `AGENTS.md`.

## Local dev

```bash
uv sync --all-extras
uv run haltmarket-monitor
uv run pytest
uv run ruff check .
uv run mypy
```

## Runtime

- Hot-standby pair with `pg_try_advisory_lock` leader election (Phase 2).
- `/metrics` endpoint exposes halt-to-DB latency + poll cadence (Phase 2).
- Deployed to Railway via `Dockerfile` (Phase 2).
