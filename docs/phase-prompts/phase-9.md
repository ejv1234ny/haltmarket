Resume the haltmarket build. Phases 0-8 and Phase 7-cleanup are merged. Phase 9 is next.

Build Phase 9 per AGENTS.md §Phase 9.

## Deliverables

### Admin gate
- Migration `supabase/migrations/0005_user_roles.sql`: `ALTER TABLE users ADD COLUMN role text default 'user' check (role in ('user','admin'))`
- `apps/web/middleware.ts`: redirect non-admins away from `/admin/*`
- First admin is provisioned manually — document in `docs/human-tasks.md` §15 with exact SQL

### Admin pages
- `/admin` — dashboard: ledger totals, recent markets table, alert log, invariant-check history
- `/admin/markets/[id]` — market detail + "Force refund" button that calls `force_refund_market(market_id uuid)` SECURITY DEFINER RPC. The RPC validates market is in 'locked' or 'resolved', writes all refund legs via `post_transfer(reason='admin_force_refund')` in one txn, transitions market to 'refunded'
- `/admin/users/[id]` — user detail + "Rebuild wallet cache" button (calls `reconcile_wallet_cache(user_id uuid)` RPC)
- `/admin/invariants` — history of invariant-check runs, last drift timestamp, drift amount

### Observability dashboard (admin-only, same `/admin`)
- Halt-to-market latency histogram (last 24h)
- Bet-placement p95 (last 1h, last 24h)
- Resolution success rate (last 24h)
- Notification delivery rate + DLQ depth (last 24h)
- Open markets count
- Ledger global sum (should always be 0 — banner RED if not)

Use direct SQL against ledger_entries + markets + notification_log. No new metrics store.

### Scheduled alert-monitor
`supabase/functions/alert-monitor/` runs every 5 min via Supabase pg_cron. Alerts on:
- Ledger invariant SUM ≠ 0 → Discord webhook @CRITICAL + log to `alerts` table (Phase 1 already has the alerts table)
- DLQ depth > 100 (from notification_log where delivery_status='failed' in last 1h) → Discord warning
- Resolution success rate < 95% in last 1h → Discord warning
- Any market stuck in 'locked' status for > 20 min → Discord warning

Discord webhook URL from `DISCORD_WEBHOOK_URL` env. Alerts deduplicated by (alert_type, hour) so we don't spam.

### Runbooks
`docs/runbooks/`:
- `runbook-drift.md` — ledger invariant drift (symptom: `alert-monitor` posts "SUM ≠ 0" → diagnosis: which wallet cache is wrong, using `ledger_wallet_drift` RPC → remediation: `reconcile_wallet_cache` on affected users → postmortem template)
- `runbook-stuck-market.md` — market locked > 20 min (symptom → diagnosis via resolver logs → remediation: manual force-refund from admin UI OR resolver restart → postmortem)
- `runbook-rss-outage.md` — Nasdaq RSS down (symptom: Phase 2 monitor reports 0 halts for 30 min during market hours → diagnosis: check nasdaqtrader.com/rss.aspx manually → remediation: wait for upstream, no action until alpha → postmortem)
- `runbook-polygon-outage.md` — Polygon down (symptom: Phase 5 resolver stuck → remediation: pause markets via force-refund after 15-min timeout → postmortem)

Each runbook: symptom → diagnosis steps → remediation → postmortem template.

## Acceptance
- Admin can force-refund a market and ledger balances (SUM = 0 after)
- Every alert path tested by intentionally breaking the invariant (describe test procedure in runbook)
- Runbooks pass a cold-read test (fresh team member executes without questions)
- Non-admin users hit 404 on `/admin/*`

## Non-goals
- Multi-tier roles (just user vs admin; no team/org/manager tiers)
- SOC 2 prep
- Auto-remediation — every alert pages a human; no auto-actions

## Commit prefix
`feat(admin):` for code + `docs(runbook):` for the runbook files (split per commit or one mixed PR is fine)

## PR title
`[Phase 9] Admin + observability + runbooks`
