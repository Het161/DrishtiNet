import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    // Playwright owns e2e/; vitest owns unit tests only.
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'node',
  },
  resolve: { alias: { '@': resolve(import.meta.dirname, 'src') } },
});
