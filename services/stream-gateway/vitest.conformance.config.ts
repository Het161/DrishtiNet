import { defineConfig } from 'vitest/config';

/**
 * The §4 conformance suite: the gate before any connection to the organisers' grid.
 * Separate config because it needs `make selftest-up` and takes ~20s, so it must never be
 * something a developer runs by accident and never something CI skips silently.
 */
export default defineConfig({
  test: {
    include: ['tests/conformance/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
