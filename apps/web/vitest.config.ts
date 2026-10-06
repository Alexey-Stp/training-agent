import path from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Resolve workspace packages from source so tests don't depend on a prior build (CI runs tests without building)
    alias: {
      '@triathlon/core': path.resolve(__dirname, '../../packages/core/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    // test-integration/ needs a real Postgres: npm run test:integration
    exclude: [...configDefaults.exclude, 'test-integration/**'],
  },
});
