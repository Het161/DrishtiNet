import { test, expect, type Page } from '@playwright/test';

/**
 * The registry must show the truth about 31 real cameras — including what it does not know.
 * These assertions are deliberately about honesty markers, not cosmetics.
 */

async function waitForMap(page: Page): Promise<void> {
  // The map is ready when MapLibre has finished loading the style AND the GeoJSON source.
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const m = (window as unknown as { __drishtiMap?: { isStyleLoaded(): boolean; loaded(): boolean } }).__drishtiMap;
          return m ? m.isStyleLoaded() && m.loaded() : false;
        }),
      { timeout: 30_000, message: 'MapLibre never finished loading the offline basemap' },
    )
    .toBe(true);
}

test.describe('camera registry', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/registry');
  });

  test('renders the real 31-camera roster from the database', async ({ page }) => {
    await expect(page.getByText('Camera registry')).toBeVisible();
    // Real camera names, not placeholders.
    await expect(page.getByRole('cell', { name: 'Char Chowk Road' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Dolatpara GIDC' })).toBeVisible();
    await expect(page.getByText('Showing 31 of 31')).toBeVisible();
  });

  test('states what it does not know, rather than hiding it', async ({ page }) => {
    // 11 unverified positions and 31 unassigned departments are facts about this dataset.
    await expect(page.getByText('Positions unverified')).toBeVisible();
    await expect(page.getByText('Departments unassigned')).toBeVisible();

    const unverified = page.locator('div', { hasText: /^Positions unverified$/ }).first();
    await expect(unverified).toBeVisible();
  });

  test('the offline basemap loads with no network', async ({ page, context }) => {
    // Block every external origin: the venue has no internet and the map must not care.
    await context.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (route) => route.abort());
    await page.reload();
    await waitForMap(page);

    const districtCount = await page.evaluate(() =>
      (window as unknown as { __drishtiMap?: { querySourceFeatures(id: string): unknown[] } })
        .__drishtiMap?.querySourceFeatures('districts').length ?? 0,
    );
    expect(districtCount).toBeGreaterThan(0);
  });

  test('selecting a camera reveals its provenance', async ({ page }) => {
    await waitForMap(page);
    await page.getByRole('cell', { name: 'Timbawadi Gate' }).click();

    // Camera 6 is the one the portal reports "live" while its media endpoint returns HTTP 500.
    await expect(page.getByText(/HTTP 500/)).toBeVisible();
    await expect(page.getByText(/Measured/)).toBeVisible();
  });

  test('filtering to gaps only narrows the roster', async ({ page }) => {
    await page.getByLabel('Filter by status').selectOption('offline');
    await expect(page.getByRole('cell', { name: 'Timbawadi Gate' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Char Chowk Road' })).toHaveCount(0);
  });
});
