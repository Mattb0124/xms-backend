import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

/**
 * Integration tests run against a real PostgreSQL (Testcontainers, or the
 * database named by TEST_DATABASE_URL) with the migrations applied once per
 * run by test/kit/global-setup.ts. Files share one database, so they run
 * one at a time.
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.int-spec.ts'],
    globalSetup: ['./test/kit/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 180000,
  },
});
