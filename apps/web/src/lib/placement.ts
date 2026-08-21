/**
 * Placement constants shared by the client panel and the server action.
 *
 * Deliberately NOT in the `'use server'` module: a file marked `'use server'` may only export
 * async functions, so importing a plain constant from one compiles fine and then throws a
 * client-side exception at runtime — which is exactly how this was found.
 */

/** Uncertainty radii offered when placing a camera, in metres. Zero means surveyed to the pole. */
export const VERIFIED_RADII = [0, 10, 25, 50, 100] as const;

/**
 * Gujarat's bounding box, generously padded. A drag that lands in the Arabian Sea or a neighbouring
 * state is a slip, not a placement, and is refused rather than stored.
 */
export const GUJARAT_BOUNDS = { minLat: 19.5, maxLat: 25.5, minLng: 67.5, maxLng: 75.5 } as const;

export function isWithinGujarat(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= GUJARAT_BOUNDS.minLat && lat <= GUJARAT_BOUNDS.maxLat &&
    lng >= GUJARAT_BOUNDS.minLng && lng <= GUJARAT_BOUNDS.maxLng
  );
}
