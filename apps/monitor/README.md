# haltmarket-monitor

Python service that polls the Nasdaq Trader RSS feed, dedups halts, enriches each event with a Polygon last-trade price, and inserts `halts` rows into Supabase via the `public.insert_halt(...)` RPC (`supabase/migrations/0002_halts.sql`).

Scoped per AGENTS.md §Phase 2 + ADR-0002: LUDP (volatility), T1 + T12 (news), H10 (regulatory). `halts.halt_kind` is a stored generated column driven by `reason_code`.

## Local dev

```bash
uv sync --all-extras
uv run haltmarket-monitor          # no DATABASE_URL → skeleton mode (exit 0)
DATABASE_URL=postgres://... \
POLYGON_API_KEY=... \
uv run haltmarket-monitor          # real poll loop, /metrics on :8080
uv run pytest                      # unit + fixture tests
MONITOR_TEST_DATABASE_URL=postgres://... uv run pytest  # + DB integration
uv run ruff check .
uv run mypy
```

## Environment

| Var | Required | Default | Notes |
|---|---|---|---|
| `DATABASE_URL` | yes (runtime) | — | psycopg DSN to Supabase Postgres |
| `POLYGON_API_KEY` | no | — | omit → `last_price` stays NULL |
| `NASDAQ_HALT_RSS_URL` | no | nasdaqtrader.com feed | override for fixtures |
| `MONITOR_POLL_INTERVAL_SECONDS` | no | `3.0` | |
| `MONITOR_METRICS_PORT` | no | `8080` | Prometheus-style `/metrics` + `/healthz` |
| `MONITOR_LEADER_LOCK_KEY` | no | `0x48414C544D4B5431` | `pg_try_advisory_lock` key |
| `MONITOR_UNRESOLVED_REFUND_AFTER_MIN` | no | `15` | Referenced by Phase 5 resolver |

## Runtime model

* **Leader election.** The monitor holds a `pg_try_advisory_lock` for the life of its psycopg session. A second instance running the same image polls the same lock on every tick and only becomes active when it wins — so the pair is hot-standby. Killing the leader releases the lock (session scope) and the standby takes over on its next tick, well within the 10-second SLA from AGENTS.md §Phase 2.
* **Dedup.** Persistent dedup lives on `halts.halts_dedup` (`UNIQUE (symbol, halt_time, reason_code)`). `insert_halt()` uses `ON CONFLICT DO NOTHING` and returns NULL on dupes. In-memory cache avoids re-calling the RPC for items already seen this process.
* **Halt classification.** Both sides (monitor + DB) classify `reason_code` → `halt_kind` identically; the DB remains the source of truth via the stored generated column.
* **/metrics.** Prometheus exposition format: `haltmarket_monitor_halts_seen_total{kind="..."}`, `halts_inserted_total`, `poll_cycles_total`, `is_leader`, `last_poll_ms`, `last_halt_to_db_ms`.
* **Deployment.** `Dockerfile` targets `python:3.12-slim`; Railway auto-detects the `haltmarket-monitor` console script. Healthcheck hits `/healthz`.
