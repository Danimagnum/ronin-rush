import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // The 1M-round distribution test is CPU-bound; give it room on slow CI runners.
    testTimeout: 120_000,
  },
});
