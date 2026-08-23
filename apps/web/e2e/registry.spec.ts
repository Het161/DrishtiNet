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

  /**
   * A failed PMTiles fetch used to raise the red "Map failed to load" banner and never clear it, so
   * a map that was drawing districts, markers and controls perfectly well sat under a permanent
   * failure notice. On a projector that teaches an evaluator to distrust every warning we show.
   *
   * Measured behaviour that these tests pin down: MapLibre never re-requests a source whose archive
   * fetch failed — zero retries across pan, zoom and wait. So the roads basemap cannot heal itself,
   * and the notice must stay up until someone rebuilds the map. Hence Retry.
   */
  test.describe('when the roads basemap fails to fetch', () => {
    const notice = /Roads basemap unavailable/;

    test('says what actually broke instead of condemning the whole map', async ({
      page,
      context,
    }) => {
      await context.route('**/map/*.pmtiles', (route) => route.abort('failed'));
      await page.reload();

      await expect(page.getByText(notice)).toBeVisible({ timeout: 15_000 });
      // Never the fatal wording: the map itself is fine, only the roads are missing.
      await expect(page.getByText('Map failed to load')).toHaveCount(0);

      // The registry stays fully usable — neither outlines nor the roster depend on road tiles.
      // Polled, not sampled once: a dead roads source means the map never reports itself fully
      // loaded, so there is no single moment to wait for before asking.
      await expect
        .poll(
          () =>
            page.evaluate(
              () =>
                (
                  window as unknown as {
                    __drishtiMap?: { querySourceFeatures(id: string): unknown[] };
                  }
                ).__drishtiMap?.querySourceFeatures('districts').length ?? 0,
            ),
          { timeout: 20_000, message: 'district outlines never rendered without the roads basemap' },
        )
        .toBeGreaterThan(0);
      await expect(page.getByText('Showing 31 of 31')).toBeVisible();
    });

    test('keeps saying so for as long as it is true', async ({ page, context }) => {
      await context.route('**/map/*.pmtiles', (route) => route.abort('failed'));
      await page.reload();

      await expect(page.getByText(notice)).toBeVisible({ timeout: 15_000 });
      // A basemap that is still broken must not quietly stop mentioning it.
      await page.waitForTimeout(6000);
      await expect(page.getByText(notice)).toBeVisible();
    });

    test('recovers when the operator retries', async ({ page, context }) => {
      let failing = true;
      await context.route('**/map/*.pmtiles', async (route) => {
        if (failing) await route.abort('failed');
        else await route.continue();
      });

      await page.reload();
      await expect(page.getByText(notice)).toBeVisible({ timeout: 15_000 });

      failing = false;
      await page.getByRole('button', { name: 'Retry' }).click();

      await expect(page.getByText(notice)).toHaveCount(0, { timeout: 30_000 });
      await expect(page.getByText('Map failed to load')).toHaveCount(0);
      await waitForMap(page);

      // The rebuild must bring the camera layers back with it, not just the basemap.
      await expect(page.getByRole('cell', { name: 'Timbawadi Gate' })).toBeVisible();
    });
  });
});
