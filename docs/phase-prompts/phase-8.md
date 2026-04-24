Resume the haltmarket build. Phases 0-6 and Phase 7-cleanup are merged. Phase 8 is next.

Build Phase 8 per AGENTS.md §Phase 8.

## Deliverables

### TypeScript interface
Create `packages/payment-provider/` as a new pnpm workspace package. In `src/index.ts`:

```ts
export interface PaymentProvider {
  initiateDeposit(userId: string, amountMicro: bigint): Promise<{ id: string; redirectUrl?: string }>
  confirmDeposit(paymentId: string, providerEventId: string): Promise<{ settled: boolean; amountMicro: bigint }>
  initiateWithdrawal(userId: string, amountMicro: bigint, destination: string): Promise<{ id: string }>
  confirmWithdrawal(paymentId: string, providerEventId: string): Promise<{ settled: boolean }>
}

export class NotProductionError extends Error {}
```

### StubProvider
`packages/payment-provider/src/stub.ts`:
- Credits wallets after 5s setTimeout
- Writes deposit/withdrawal rows using Phase 1 schema
- Throws `NotProductionError` if `process.env.NODE_ENV === 'production'`

### Edge functions
- `initiate-deposit` — validates amount, calls provider.initiateDeposit, inserts deposits row, returns {id, redirectUrl}
- `initiate-withdrawal` — validates balance, calls provider.initiateWithdrawal, inserts withdrawals row, debits wallet via `post_transfer(reason='withdrawal_hold')` so balance reflects pending

### Webhook receiver
`apps/web/app/api/webhooks/payments/route.ts`:
- HMAC-verified via `X-Payment-Signature` header + `PAYMENT_WEBHOOK_SECRET`
- Dispatches to provider.confirmDeposit or confirmWithdrawal based on event type
- On deposit settled: credits wallet via `post_transfer(reason='deposit')`
- On withdrawal settled: marks withdrawal row settled (balance already debited on initiate)
- On withdrawal failed: reverses the hold via `post_transfer(reason='withdrawal_hold_reverse')`

### UI flows
- `/wallet` page — Deposit + Withdraw buttons
- Deposit modal: amount input → calls initiate-deposit → StubProvider redirects to a local `/dev/payment-success?paymentId=X` page → 5s later webhook fires → wallet credits appear
- Withdrawal modal: amount + destination input → calls initiate-withdrawal → immediate debit → 5s later webhook fires → row marked settled

### Markers
`TODO(human): replace StubProvider with Coinbase Commerce / Circle / Fireblocks` at every StubProvider instantiation. Link to docs/human-tasks.md §5.

## Acceptance
- Deposit with StubProvider credits wallet after 5s delay
- Withdrawal debits immediately (hold) and webhook settles 5s later
- Ledger invariant (SUM = 0) holds after 1,000 simulated deposit+withdrawal cycles
- NotProductionError throws if `NODE_ENV=production` is set

## Non-goals
- Real payment rails — human task (AGENTS.md §9.5)
- KYC gating on deposits — separate phase
- Multi-currency — USDC only at launch per AGENTS.md §1

## Commit prefix
`feat(payments):`

## PR title
`[Phase 8] Deposit/withdrawal scaffolding with StubProvider`
