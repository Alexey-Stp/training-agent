import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Resolve workspace packages from source so tests don't depend on a prior build (CI runs tests without building)
    alias: {
      '@triathlon/core': path.resolve(__dirname, '../../packages/core/src/index.ts'),
      '@triathlon/integrations-icu': path.resolve(
        __dirname,
        '../../packages/integrations-icu/src/index.ts'
      ),
      '@triathlon/ai': path.resolve(__dirname, '../../packages/ai/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    // Each migration test boots PGlite and replays every migration in beforeAll; with all of them
    // running in parallel the default 10s is too tight on slower machines
    hookTimeout: 30_000,
  },
});
