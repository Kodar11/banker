import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    include: ['tests/engine/**/*.test.ts', 'tests/server/**/*.test.ts', 'tests/learning/**/*.test.ts', 'tests/account/**/*.test.ts', 'tests/social/**/*.test.ts'],
    environment: 'node',
    // Server integration tests share one Postgres database; run files sequentially.
    fileParallelism: false,
  },
});
