import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Default `test` script excludes integration — those require a real DB and
    // are gated by LEDGER_TEST_DATABASE_URL via `test:integration`.
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/integration.test.ts', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      include: ['src/index.ts'],
      thresholds: {
        lines: 95,
        functions: 95,
        branches: 90,
        statements: 95,
      },
    },
  },
});
