import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Runs only test-integration/ against the DATABASE_URL Postgres (CI integration job)
export default defineConfig({
  resolve: {
    alias: {
      '@triathlon/core': path.resolve(__dirname, '../../packages/core/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['test-integration/**/*.int.test.ts'],
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
