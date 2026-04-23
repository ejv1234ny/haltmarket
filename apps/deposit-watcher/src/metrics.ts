import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'deposit_watcher_' });

export const webhooksReceivedTotal = new Counter({
  name: 'deposit_watcher_webhooks_received_total',
  help: 'Number of Alchemy webhooks received.',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

export const depositsCreditedTotal = new Counter({
  name: 'deposit_watcher_deposits_credited_total',
  help: 'Number of on-chain USDC deposits successfully credited to the ledger.',
  labelNames: ['status'] as const,
  registers: [registry],
});

export const rpcLatencyMs = new Histogram({
  name: 'deposit_watcher_rpc_latency_ms',
  help: 'Latency of credit_crypto_deposit RPC calls (milliseconds).',
  buckets: [25, 50, 100, 250, 500, 1000, 2500, 5000],
  registers: [registry],
});

export const webhookVerificationFailuresTotal = new Counter({
  name: 'deposit_watcher_webhook_verification_failures_total',
  help: 'Webhooks rejected for invalid signatures.',
  registers: [registry],
});
