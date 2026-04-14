import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
    testTimeout: 30_000, // argon2 hashing is intentionally slow
    // Run integration test FILES sequentially: they all share one Postgres
    // and truncate tables in beforeEach. Parallel files race each other's
    // data. Slightly slower but correct.
    // Tests WITHIN a file still run sequentially (vitest default).
    fileParallelism: false,
    pool: 'forks', // argon2 is native, fork isolation avoids native-module issues
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
    },
  },
});
