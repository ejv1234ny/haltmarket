# Crypto Rail Handoff — Phase 8 Wiring for Claude Code

This doc lists the remaining work to accept real USDC bets from alpha users. Migration `0008_crypto_rail.sql` and the `apps/deposit-watcher` service scaffold have already landed. This is the wire-up, test-up, and polish pass.

## Preconditions

- [ ] The uncommitted changes from the previous Claude Code session are committed (`git add -A && git commit -m "feat: phases 6+7 polish (leaderboard, compliance, deploy)"`).
- [ ] The new files from this session are included:
  - `supabase/migrations/0008_crypto_rail.sql`
  - `apps/deposit-watcher/**` (new service)
  - `docs/crypto-rail-handoff.md` (this file)
- [ ] `docs/alpha-launch-checklist.md` is updated with the new Phase 8 items (see Section 10 below).

Commit these as `feat(phase-8): crypto rail foundations — migration 0008 + deposit-watcher skeleton`.

---

## 1. Monorepo registration

The new service needs to be registered in the workspace.

### `pnpm-workspace.yaml`

No change needed if it already uses the `apps/*` glob pattern. Verify with `pnpm -r list` that `@haltmarket/deposit-watcher` shows up.

### `turbo.json`

Ensure `build`, `typecheck`, `test`, and `lint` tasks are not service-scoped in a way that excludes the new app. Running `pnpm -r typecheck` should include `deposit-watcher`.

### `.github/workflows/ci.yml`

Add `apps/deposit-watcher` to the path filters so CI runs on changes, and add a job step that runs `pnpm --filter @haltmarket/deposit-watcher typecheck && pnpm --filter @haltmarket/deposit-watcher test`.

### `.github/workflows/deploy.yml`

After the Supabase migrate job, add a Railway deploy step for `haltmarket-deposit-watcher` using the same `RAILWAY_TOKEN` pattern as `monitor` and `resolver`.

---

## 2. Apply migration 0008

```bash
supabase db push --linked
```

Verify:

```sql
-- Check tables
select * from public.system_flags;
select * from public.compliance_settings where id = 1;

-- Check RPCs exist
select proname from pg_proc where proname in (
  'credit_crypto_deposit',
  'request_withdrawal',
  'mark_withdrawal_paid',
  'mark_withdrawal_failed',
  'reconcile_crypto_ledger'
);
```

Expected rows: `crypto_deposit_cap_micro = 250000000` (that's $250 for alpha), `crypto_withdrawal_min_micro = 5000000` ($5 min).

---

## 3. Privy integration in `apps/web`

### Install

```bash
pnpm --filter @haltmarket/web add @privy-io/react-auth
```

### Wrap the app

Add a `PrivyProvider` in `apps/web/src/app/layout.tsx` (inside the `<body>`, outside the Supabase-auth children). Config:

```ts
appId: process.env.NEXT_PUBLIC_PRIVY_APP_ID!,
config: {
  loginMethods: ['email', 'google'],
  embeddedWallets: { createOnLogin: 'all-users' },
  defaultChain: { id: 8453, name: 'Base', ... },
  supportedChains: [ { id: 8453, ... } ],
  appearance: { theme: 'dark', accentColor: '#...' },
}
```

### On first login

When Privy returns the embedded wallet address, persist it to `user_wallet_addresses`:

```ts
// New server action or route: apps/web/src/app/api/wallet-address/route.ts
// Called from a client effect after Privy provisions the wallet.
await supabase.rpc('register_wallet_address', {
  p_chain_id: 8453,
  p_address: embeddedWalletAddress,
  p_source: 'privy',
});
```

**Note:** `register_wallet_address` is not in 0008 — add a migration `0009_register_wallet_address.sql` that creates a small SECURITY INVOKER RPC wrapper that INSERTs into `user_wallet_addresses` using `auth.uid()` as `user_id`. Keep it minimal; it's the one write path clients own directly.

### Environment

Add to `apps/web/.env.example` and Vercel:

- `NEXT_PUBLIC_PRIVY_APP_ID`
- `PRIVY_APP_SECRET` (server-side only)

---

## 4. Wallet page UI — deposit and withdraw sections

File: `apps/web/src/app/wallet/page.tsx`

Replace the two disabled `Deposit (coming soon)` / `Withdraw (coming soon)` buttons with real UI:

### Deposit card

- Display the user's Privy embedded wallet address (from `user_wallet_addresses` where `source = 'privy'`).
- Render a QR code (install `qrcode.react` or `qr-code-styling`).
- Copy-to-clipboard button.
- Instructions: "Send USDC on Base to this address. $250 lifetime cap during alpha. Confirmations typically complete within 10 seconds."
- Below, a `DepositHistory` component querying `select id, amount_micro, status, tx_hash, created_at from deposits where user_id = auth.uid() order by created_at desc limit 10`.

### Withdraw card

- Form: amount input (USDC, min $5), destination address input (validated 0x[40 hex]), submit.
- On submit, POST to a new edge function `request-withdrawal` (see Section 5).
- Display pending withdrawals and their status.
- Copy: "Withdrawals are processed in daily batches. Expected completion: within 24 hours."

### Component structure

```
apps/web/src/components/wallet/
├── deposit-card.tsx          (Privy address + QR + history)
├── withdraw-card.tsx         (form + pending-list)
├── deposit-history-table.tsx
└── withdraw-status-badge.tsx
```

---

## 5. `request-withdrawal` edge function

Create `supabase/functions/request-withdrawal/index.ts` mirroring the shape of `place-bet`:

- POST body: `{ amount_micro: number, destination_address: string }`
- Auth: extract user from Supabase Auth JWT.
- Call `rpc('request_withdrawal', { p_user_id, p_amount_micro, p_destination_address, p_chain_id: 8453 })`.
- Map SQLSTATE errors to HTTP codes:
  - `H0016` withdrawals_frozen → 503
  - `H0017` withdrawal_below_min → 400
  - `22023` invalid address → 400
  - balance insufficient (from post_transfer) → 402

Test file: `supabase/functions/request-withdrawal/test.ts` with the same harness as `place-bet/test.ts`.

---

## 6. Admin console additions

Extend the admin page (or create one if it doesn't exist yet per Phase 9) at `apps/web/src/app/admin/page.tsx`:

### Withdrawal queue view

- Query `public.admin_withdrawal_queue` (view created in 0008).
- Table: user handle, amount, destination, age, actions.
- Each row has "Mark paid" (form → tx_hash input) and "Mark failed" (form → reason input).
- "Mark paid" calls a new edge function `admin-withdraw-confirm` that calls `mark_withdrawal_paid(id, tx_hash, block_number)`.
- "Mark failed" calls `admin-withdraw-fail`.

### Crypto freeze switches

- Toggle UI for `deposits_frozen`, `withdrawals_frozen`, `markets_frozen` in `system_flags`.
- Each toggle immediately writes via a SECURITY DEFINER RPC `set_system_flag(flag, value, note)` — add to migration 0009 or 0010.

### Reconciliation status

- Call `reconcile_crypto_ledger()` and compare ledger-side custody to on-chain Safe balances (hot + cold).
- Fetch on-chain balances via a server-side viem call: `publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [safeAddress] })`.
- Display drift in micros + USD, badge green if < $1, yellow $1–$10, red > $10.

---

## 7. Reconciliation job (scheduled)

Create `supabase/functions/reconcile-crypto/index.ts`:

- Runs every hour via pg_cron or Supabase scheduled function.
- Calls `reconcile_crypto_ledger()`.
- Fetches on-chain balances of hot + cold Safe addresses via viem on Base.
- Computes drift: `on_chain_total - abs(ledger_custody) - in_flight_withdraw`.
- If `abs(drift) > 1_000_000` ($1), posts Discord alert and sets `deposits_frozen=true`.

---

## 8. Safe multisig setup (human — op)

- [ ] Create a **hot wallet** Safe on Base via https://app.safe.global.
  - Signers: founder + 2 trusted (2-of-3 threshold).
  - Fund with initial gas (~0.01 ETH on Base for signing txs).
- [ ] Create a **cold wallet** Safe on Base.
  - Signers: founder + 2 others (at least one hardware-wallet signer), 2-of-3 threshold.
  - No funding needed yet.
- [ ] Record both Safe addresses in a secrets manager and in `HOT_WALLET_ADDRESS` / `COLD_WALLET_ADDRESS` env vars.

---

## 9. Alchemy Notify setup (human — op)

- [ ] Create an Alchemy account at https://dashboard.alchemy.com.
- [ ] Create an app on Base Mainnet.
- [ ] Go to Notify → Create Webhook → Address Activity.
- [ ] Chain: Base Mainnet. Addresses: the hot wallet Safe. Filter: Token Transfers, USDC only.
- [ ] Webhook URL: `https://<railway-deposit-watcher>.up.railway.app/webhooks/alchemy`.
- [ ] Copy the signing key → set as `ALCHEMY_SIGNING_KEY` in Railway for the deposit-watcher service.

---

## 10. Update `docs/alpha-launch-checklist.md`

Add a new section **"8. Crypto rail"** between the existing "7. Compliance / legal" and "8. Seed + verify":

```markdown
## 8. Crypto rail

- [ ] Migration `0008_crypto_rail.sql` applied via `supabase db push`.
- [ ] Safe hot + cold wallets created on Base, signers configured.
- [ ] `HOT_WALLET_ADDRESS` and `COLD_WALLET_ADDRESS` set in all service env vars.
- [ ] Alchemy app created on Base Mainnet; Notify webhook configured.
- [ ] `ALCHEMY_SIGNING_KEY` set in Railway for deposit-watcher service.
- [ ] `deposit-watcher` deployed to Railway, webhook URL pointed at it.
- [ ] Privy account created; `NEXT_PUBLIC_PRIVY_APP_ID` + `PRIVY_APP_SECRET` set in Vercel.
- [ ] Smoke test: deposit 0.01 USDC from a mapped user wallet → observe `deposits` row + ledger credit + `ledger_global_sum()=0`.
- [ ] Smoke test: request a $5 withdrawal → admin marks paid with tx_hash → observe `withdrawals.status='confirmed'` + ledger balance.
- [ ] Reconciliation job scheduled and posting to Discord hourly.
```

Renumber the subsequent "8. Seed + verify" to "9. Seed + verify" and so on.

---

## 11. Tests to add

### TypeScript (vitest)

- `apps/deposit-watcher/test/credit.test.ts` — already in the scaffold. Add:
  - `test/alchemy.test.ts` — signature verification (happy + forged), payload schema validation, `rawValueToMicros` conversion.
  - `test/index.test.ts` — full webhook flow with mocked Supabase.
- `apps/web/src/components/wallet/__tests__/` — render tests for deposit-card and withdraw-card.

### SQL (CI integration tests)

Add to the CI Postgres harness:

- `0008_crypto_rail.test.sql` — exercise:
  - `credit_crypto_deposit` happy path (mapped sender, cap not exceeded).
  - `credit_crypto_deposit` duplicate tx_hash returns existing id.
  - `credit_crypto_deposit` unknown sender raises H0014.
  - `credit_crypto_deposit` cap exceeded raises H0012.
  - `credit_crypto_deposit` with frozen flag raises H0015 but records the pending row.
  - `request_withdrawal` below min raises H0017.
  - `request_withdrawal` → `mark_withdrawal_paid` → ledger balanced.
  - `request_withdrawal` → `mark_withdrawal_failed` → balance restored to user_wallet.
- `0008_reconcile.test.sql` — after a sequence of deposits/withdrawals, `reconcile_crypto_ledger()` returns expected micros.

---

## 12. Done-when

- [ ] All tests from Section 11 pass in CI (both pnpm and the Postgres harness).
- [ ] `pnpm -r typecheck && pnpm -r lint && pnpm -r test` green.
- [ ] `supabase db lint` clean on all migrations 0001–0008+.
- [ ] `deposit-watcher` deployed to Railway, healthy, receiving webhooks.
- [ ] Manual smoke test: mapped Privy wallet deposits $0.01 → ledger credits → user places a $1 bet → market resolves → user requests $2 withdrawal → admin marks paid → withdrawal confirmed. `ledger_global_sum()=0` at every step.
- [ ] Alpha launch checklist Section 8 boxes are green.

---

## 13. Known sharp edges

- **Privy wallet address latency.** Privy creates embedded wallets asynchronously on first login. The `/wallet` page should handle the "wallet pending" state gracefully (skeleton card with a hint that it usually takes a few seconds).
- **USDC decimal mismatch.** Base USDC is 6 decimals (same as mainnet). Some forks/tokens are 18. The `rawValueToMicros` helper assumes 6 — guard this with a contract-address check.
- **Safe execution from the admin UI.** For alpha, admins execute withdrawals manually via the Safe web app. Do not build an auto-signer. This is a deliberate trade-off to keep the private-key surface minimal.
- **Orphaned deposits.** If a user sends USDC from an address we have not mapped yet (e.g., they withdrew from an exchange), the watcher will log H0014 and the deposit sits uncredited. Admin must map the address (add a row to `user_wallet_addresses`) and re-trigger crediting. Consider a small admin UI for this.
- **Two confirmations on Base = ~4 seconds.** Good enough for alpha. Beta+ may want to require more confirmations for larger deposits.
