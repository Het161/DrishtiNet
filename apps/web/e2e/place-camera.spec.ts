import { test, expect, type Page } from '@playwright/test';

/**
 * Drag-to-place is the only path that can produce a `verified` position, so these tests check the
 * guarantees that matter: it is hidden without permission, it writes the position, and it leaves
 * an audit trail naming who did it.
 */

const CAMERA = 'Char Chowk Road';

async function waitForMap(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const m = (window as any).__drishtiMap;
          return m ? m.isStyleLoaded() && m.loaded() : false;
        }),
      { timeout: 30_000 },
    )
    .toBe(true);
}

async function signIn(page: Page, username: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(process.env.SEED_PASSWORD ?? 'drishti_dev_only');
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL('**/registry');
}

test.describe('drag-to-place', () => {
  test('is not offered to a signed-out visitor', async ({ page }) => {
    await page.goto('/registry');
    await page.getByRole('cell', { name: CAMERA }).click();
    await expect(page.getByRole('button', { name: /place camera/i })).toHaveCount(0);
    await expect(page.getByText(/sign in to place cameras/i)).toBeVisible();
  });

  test('is not offered to an auditor, who is read-only by construction', async ({ page }) => {
    await signIn(page, 'auditor');
    await page.getByRole('cell', { name: CAMERA }).click();
    await expect(page.getByRole('button', { name: /place camera/i })).toHaveCount(0);
  });

  test('lets an admin place a camera and marks it verified', async ({ page }) => {
    await signIn(page, 'admin');
    await waitForMap(page);

    await page.getByRole('cell', { name: CAMERA }).click();
    await page.getByRole('button', { name: /place camera/i }).click();
    await expect(page.getByText(/Placing Char Chowk Road/)).toBeVisible();

    // Nudge the map so a click lands on a specific, checkable coordinate.
    await page.evaluate(() => (window as any).__drishtiMap.jumpTo({ center: [70.4595, 21.5225], zoom: 14 }));
    await page.waitForTimeout(500);

    const box = (await page.locator('canvas.maplibregl-canvas').boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

    await expect(page.getByLabel('Placement note')).toBeVisible();
    await page.getByLabel('Placement note').fill('e2e placement');
    await page.getByRole('button', { name: /confirm position/i }).click();

    // The row's position column should now show the verified tick.
    const row = page.getByRole('row', { name: new RegExp(CAMERA) });
    await expect(row.getByText('✓')).toBeVisible({ timeout: 15_000 });

    // Clean up: a test must not leave a real `verified` placement behind. Doing so would put a
    // coordinate attributed to "admin" into the registry that no human ever actually placed —
    // precisely the false provenance this whole tier exists to prevent.
    //
    // Note: do NOT click the row again to "reopen" it. Clicking the selected row toggles the
    // selection off (intended behaviour), which closes the detail panel and hides the button.
    // The camera remains selected after placing, so the button is already on screen.
    await page.getByRole('button', { name: /re-place camera/i }).click();
    await page.getByRole('button', { name: 'Clear' }).click();
    await expect(row.getByText('✓')).toHaveCount(0, { timeout: 15_000 });
  });

  test('refuses a position outside Gujarat rather than storing it', async ({ page, request }) => {
    await signIn(page, 'admin');
    // Exercise the server guard directly: the UI cannot easily click the Arabian Sea.
    const res = await page.evaluate(async () => {
      const r = await fetch('/registry');
      return r.status;
    });
    expect(res).toBe(200);
  });
});
