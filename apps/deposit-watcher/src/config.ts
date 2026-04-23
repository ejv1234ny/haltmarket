import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

const schema = z.object({
  // Supabase — service-role credentials required for RPC calls.
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),

  // Alchemy webhook verification. See https://docs.alchemy.com/reference/notify-api-quickstart
  ALCHEMY_SIGNING_KEY: z.string().min(8),

  // Chain + wallet targets. Default Base mainnet.
  CHAIN_ID: z.coerce.number().int().positive().default(8453),
  HOT_WALLET_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  // Base USDC contract is 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913
  USDC_CONTRACT_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/)
    .default('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'),

  // Deposit confirmation threshold. USDC on Base is fast; 2 confs ≈ 4 seconds.
  MIN_CONFIRMATIONS: z.coerce.number().int().nonnegative().default(2),

  // Server
  PORT: z.coerce.number().int().positive().default(8082),
  METRICS_PORT: z.coerce.number().int().positive().default(8083),

  // Observability
  DISCORD_WEBHOOK_URL: z.string().url().optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const errors = parsed.error.format();
    // eslint-disable-next-line no-console
    console.error('[config] invalid env:', JSON.stringify(errors, null, 2));
    process.exit(1);
  }
  return parsed.data;
}
