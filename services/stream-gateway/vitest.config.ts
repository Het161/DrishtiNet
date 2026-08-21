import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The conformance suite needs the local self-test grid running and takes ~20s, so it is NOT
    // part of the default run. It is an explicit gate — `make conformance` — deliberately run
    // before any connection to the real grid, not incidentally on every commit.
    include: ['src/**/*.test.ts'],
    exclude: ['tests/conformance/**', 'node_modules/**'],
  },
});
