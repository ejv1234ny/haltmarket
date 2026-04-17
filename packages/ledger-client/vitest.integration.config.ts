import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/integration.test.ts'],
    // Integration tests open pg pools + parallel bet scenarios; keep them serial
    // to avoid per-file pool contention.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
