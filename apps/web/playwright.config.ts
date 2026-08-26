import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';

// The suite has to follow WEB_PORT. With the port hardcoded, moving the app off 3000 pointed every
// test at whatever else was listening there — on this machine, an unrelated project — and the
// failures would have looked like our own regressions rather than a misdirected suite.
try {
  process.loadEnvFile(resolve(import.meta.dirname, '../../.env'));
} catch {
  // No .env: the defaults below still apply.
}
const WEB_PORT = process.env.WEB_PORT ?? '3000';

/**
 * Playwright drives the real browser against a real database, because the things most likely to
 * break in this app — MapLibre's worker, PostGIS-backed markers, the honesty badges — are all
 * invisible to unit tests. A headless screenshot cannot verify them either: Chrome's
 * `--virtual-time-budget` starves web workers, which is exactly how a working map spent an hour
 * looking broken.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? 'list' : [['list']],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: process.env.E2E_BASE_URL ?? `http://localhost:${WEB_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
