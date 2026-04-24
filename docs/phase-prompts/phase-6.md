Resume the haltmarket build. Phases 0-5 and Phase 7-cleanup are merged on main. Phase 6 is next.

Build Phase 6 per AGENTS.md §Phase 6.

## Deliverables

### Migration
`supabase/migrations/0004_notifications.sql`:
- `notification_prefs` (user_id, market_opened BOOL default true, market_resolved BOOL default true, direct_message BOOL default true)
- `push_subscriptions` (id, user_id, endpoint TEXT UNIQUE, p256dh TEXT, auth TEXT, created_at timestamptz)
- `notification_log` (id, user_id, type text, payload jsonb, sent_at timestamptz, delivery_status text check in ('sent','failed','retrying'), error text)

RLS: users read/write own prefs + subscriptions. Only service role writes to notification_log.

### Edge function `notify-halt`
Supabase Edge Function triggered on `markets` INSERT via Postgres trigger. Parallel fan-out:
- Query push_subscriptions joined with notification_prefs where market_opened = true
- Parallel `web-push` dispatch (Deno-compatible web-push lib)
- Per-endpoint circuit breaker: gate bad endpoints after 3 consecutive failures for 1 hour
- DLQ: failed dispatches retry with exponential backoff up to 3 times, then log as 'failed'
- Target: p95 < 5s for 10,000 subscribers

### Frontend
- `apps/web/app/wallet/notifications/page.tsx` — toggle preferences UI
- `apps/web/public/sw.js` — service worker that handles push + click-to-navigate
- First-visit banner component that requests push permission + subscribes (dismissible, persists)
- VAPID public key loaded from NEXT_PUBLIC_VAPID_PUBLIC_KEY env var

### Email stub (SendGrid)
`packages/email-client/src/sendgrid.ts` — interface only with sendEmail(to, subject, body). Logs to console when SENDGRID_API_KEY unset. `TODO(human): replace stub with real SendGrid integration` marker.

### Tests
- Synthetic integration: insert a test market, verify push arrives at test subscription within 5s
- DLQ test: inject failing endpoint, verify retry count + final log entry as 'failed'
- Scale test: 10,000 mock subscribers inserted, trigger notify-halt, assert p95 < 5s
- Circuit breaker test: endpoint fails 3x, next call skipped, resumes after 1h

## Acceptance
- Synthetic test passes
- DLQ handles 10% failure rate without blocking healthy endpoints
- UI subscribes cleanly in Chrome, Firefox, Safari
- Ledger invariant untouched (sanity check — notifications have no money flow)

## Non-goals
- Real SendGrid integration (human task — API key + merchant email)
- VAPID key generation (human task — AGENTS.md §9.14; operator generates + stores in env)
- Email templates (Phase 9 will introduce them for admin alerts)

## Commit prefix
`feat(notify):`

## PR title
`[Phase 6] Push notifications + email stub`
