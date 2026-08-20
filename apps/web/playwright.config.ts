import { defineConfig, devices } from '@playwright/test';

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
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
