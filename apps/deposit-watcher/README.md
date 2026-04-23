# deposit-watcher

Listens for USDC Transfer events into the Safe hot wallet on Base, verifies them against Alchemy Notify's signed webhook, and calls the `credit_crypto_deposit` RPC to credit the user's ledger balance.

## Responsibilities

- Receive address-activity webhooks from Alchemy Notify.
- Verify HMAC-SHA256 signature against `ALCHEMY_SIGNING_KEY`.
- Parse USDC Transfer activity targeting the configured hot wallet.
- Convert on-chain raw value to micros and call `credit_crypto_deposit(...)`.
- Expose `/metrics` (Prometheus) and `/healthz`.

## Non-responsibilities

- No polling/backfill in v0.1 (webhook-only). Add a polling fallback in v0.2 if Alchemy reliability becomes an issue.
- No withdrawal processing. Withdrawals are ops-initiated via Safe multisig; see `docs/crypto-rail-handoff.md`.
- No KYC enforcement. The RPC enforces user-wallet-address mapping; KYC gates live in `place_bet`.

## Endpoints

- `POST /webhooks/alchemy` — the webhook receiver.
- `GET  /healthz` — liveness.
- `GET  /metrics` (on `METRICS_PORT`) — Prometheus scrape target.

## Environment

See `src/config.ts` for the schema. Required:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ALCHEMY_SIGNING_KEY`
- `HOT_WALLET_ADDRESS` (Safe multisig on Base)

Optional (with sensible defaults):

- `CHAIN_ID` (default `8453` = Base mainnet)
- `USDC_CONTRACT_ADDRESS` (default Base USDC: `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`)
- `MIN_CONFIRMATIONS` (default `2`)
- `PORT` (default `8082`)
- `METRICS_PORT` (default `8083`)
- `DISCORD_WEBHOOK_URL`
- `LOG_LEVEL` (`debug|info|warn|error`, default `info`)

## Wiring

1. Deploy the service to Railway (see `railway.toml`).
2. Get the public URL from Railway (e.g., `https://deposit-watcher.up.railway.app`).
3. In Alchemy Dashboard → Notify:
   - Create a new "Address Activity" webhook on Base Mainnet.
   - Target address: the Safe hot wallet.
   - Asset filter: USDC (contract `0x8335...2913`).
   - URL: `https://<railway-url>/webhooks/alchemy`.
4. Copy the signing key from the webhook settings into `ALCHEMY_SIGNING_KEY`.
5. Smoke-test by sending a 0.01 USDC transfer to the hot wallet from a mapped user address. Confirm:
   - A `deposits` row is created with `status='confirmed'` and `tx_hash` populated.
   - The user's `wallets` cache shows `balance_micro += 10000`.
   - `ledger_global_sum()` returns 0.

## Idempotency

- Webhook replays are idempotent: `credit_crypto_deposit` returns the original `deposit_id` on a repeat `tx_hash`.
- On transient errors (network, DB), the service returns 500 so Alchemy retries with exponential backoff.
- Alchemy's retry window is 24 hours — sufficient for all realistic outages.

## Observability

Prometheus metrics:

- `deposit_watcher_webhooks_received_total{outcome=ok|rejected_schema|partial_error}`
- `deposit_watcher_deposits_credited_total{status=credited|rejected|errored}`
- `deposit_watcher_rpc_latency_ms` (histogram)
- `deposit_watcher_webhook_verification_failures_total`

Alert on:

- `webhook_verification_failures_total > 0` over 5m (possible attacker or misconfigured webhook)
- `deposits_credited_total{status="errored"} > 0` over 5m (DB issue, investigate)

## Local dev

```bash
cd apps/deposit-watcher
pnpm install
pnpm dev
# POST a sample webhook payload; use a signed body for realistic testing.
```

Integration tests run against a live Postgres fixture — see `test/`.
