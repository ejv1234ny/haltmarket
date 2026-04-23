import * as Sentry from '@sentry/node';
import Fastify, { FastifyRequest } from 'fastify';
import { createClient } from '@supabase/supabase-js';
import { loadEnv } from './config.js';
import { Logger } from './logger.js';
import { registry, webhooksReceivedTotal, webhookVerificationFailuresTotal } from './metrics.js';
import {
  verifyAlchemySignature,
  WebhookPayload,
  rawValueToMicros,
  isUsdcTransferTo,
} from './alchemy.js';
import { creditDeposit } from './credit.js';

const env = loadEnv();
const log = new Logger(env.LOG_LEVEL);

// Sentry is opt-in. When SENTRY_DSN is absent (dev, CI), the SDK is a no-op
// and nothing changes. When present, process-level uncaught exceptions and
// explicit captureException calls flow to the configured project.
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.DEPLOY_ENV ?? 'production',
    tracesSampleRate: Number.parseFloat(process.env.SENTRY_TRACES_SAMPLE ?? '0.05'),
    release: process.env.RAILWAY_DEPLOYMENT_ID,
  });
  log.info('Sentry initialized', { env: process.env.DEPLOY_ENV ?? 'production' });
}

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ---- HTTP server (receives Alchemy webhooks) --------------------------------

const app = Fastify({
  logger: false,
  bodyLimit: 4 * 1024 * 1024,
  disableRequestLogging: true,
});

/**
 * Capture the raw body so we can verify the Alchemy HMAC signature.
 * Fastify parses JSON by default — we override with a text parser and
 * parse manually below.
 */
app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
  done(null, body);
});

app.get('/healthz', async () => ({ ok: true }));

app.post('/webhooks/alchemy', async (req: FastifyRequest, reply) => {
  const raw = req.body as string;
  const sig = req.headers['x-alchemy-signature'] as string | undefined;

  if (!verifyAlchemySignature(raw, sig, env.ALCHEMY_SIGNING_KEY)) {
    webhookVerificationFailuresTotal.inc();
    log.warn('webhook signature verification failed', { sigHeader: sig ?? null });
    reply.code(401);
    return { error: 'invalid_signature' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn('webhook body not valid JSON', { err: (err as Error).message });
    reply.code(400);
    return { error: 'invalid_json' };
  }

  const payloadCheck = WebhookPayload.safeParse(parsed);
  if (!payloadCheck.success) {
    log.warn('webhook payload failed schema', { issues: payloadCheck.error.issues });
    reply.code(400);
    webhooksReceivedTotal.inc({ outcome: 'rejected_schema' });
    return { error: 'invalid_payload' };
  }
  const payload = payloadCheck.data;

  let credited = 0;
  let skipped = 0;
  let errored = 0;

  for (const activity of payload.event.activity) {
    if (!isUsdcTransferTo(activity, env.USDC_CONTRACT_ADDRESS, env.HOT_WALLET_ADDRESS)) {
      skipped++;
      continue;
    }

    const amountMicro = rawValueToMicros(activity);
    if (amountMicro <= 0n) {
      skipped++;
      continue;
    }

    try {
      const outcome = await creditDeposit(supabase, log, {
        chainId:      env.CHAIN_ID,
        txHash:       activity.hash,
        fromAddress:  activity.fromAddress,
        toAddress:    activity.toAddress,
        amountMicro,
        blockNumber:  BigInt(activity.blockNum),
      });
      if (outcome.kind === 'credited') credited++;
      else skipped++;   // rejected (known reasons) or duplicate
    } catch (err) {
      errored++;
      log.error('credit failed — will retry on next Alchemy redelivery', {
        txHash: activity.hash,
        err: (err as Error).message,
      });
      Sentry.captureException(err, {
        tags: { kind: 'credit_failed', tx_hash: activity.hash },
      });
    }
  }

  if (errored > 0) {
    webhooksReceivedTotal.inc({ outcome: 'partial_error' });
    reply.code(500);
    return { credited, skipped, errored };
  }

  webhooksReceivedTotal.inc({ outcome: 'ok' });
  return { credited, skipped, errored };
});

// ---- Metrics server ---------------------------------------------------------

const metricsApp = Fastify({ logger: false });
metricsApp.get('/metrics', async (_req, reply) => {
  reply.header('content-type', registry.contentType);
  return registry.metrics();
});
metricsApp.get('/healthz', async () => ({ ok: true }));

// ---- Boot -------------------------------------------------------------------

async function main(): Promise<void> {
  await app.listen({ host: '0.0.0.0', port: env.PORT });
  await metricsApp.listen({ host: '0.0.0.0', port: env.METRICS_PORT });
  log.info('deposit-watcher listening', {
    port: env.PORT,
    metricsPort: env.METRICS_PORT,
    chainId: env.CHAIN_ID,
    hotWallet: env.HOT_WALLET_ADDRESS,
  });
}

main().catch((err: unknown) => {
  log.error('fatal', { err: (err as Error).message });
  Sentry.captureException(err, { tags: { kind: 'boot' } });
  process.exit(1);
});

// Graceful shutdown for Railway SIGTERM
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log.info('shutdown signal received', { signal });
    Promise.all([app.close(), metricsApp.close()])
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
}
