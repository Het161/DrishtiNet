/**
 * The rules a route has to obey, with no database attached.
 *
 * Kept apart from the queries so the constraint that actually matters — whether a vehicle could
 * physically have made a leg — can be tested without a server, exactly as the gateway keeps its
 * live-stream rules separate from its sockets. `server-only` in the query module also makes it
 * unimportable by the test runner, so this split is what lets these rules be proven at all.
 */

/** Above this cosine, two tracks look like the same vehicle. Measured: same 0.950, different 0.544. */
export const APPEARANCE_THRESHOLD = 0.82;

/**
 * Fastest a vehicle could plausibly travel between two cameras, in km/h.
 *
 * Deliberately generous — this is a physical impossibility filter, not a speeding detector. Set too
 * low it would discard real sightings on an open highway; its job is only to reject the 300 km leap
 * that appearance similarity cannot see.
 */
export const MAX_PLAUSIBLE_SPEED_KMH = 140;

/**
 * Two cameras at one junction are metres apart, and cross-camera clocks agree to about 14 s. Below
 * this elapsed time the speed test is meaningless — dividing by nearly zero makes every pair look
 * impossibly fast — so near-simultaneous sightings are judged on distance alone.
 */
const MIN_ELAPSED_SECONDS = 20;

/** Within this distance, two cameras are effectively the same place. */
const SAME_PLACE_KM = 1.5;

/** Great-circle distance in km. */
export function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Cosine similarity. Both sides are stored L2-normalised, so this is a dot product. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
}

/**
 * Is this leg physically possible?
 *
 * Returns true when the vehicle could have covered the distance in the time available. Unknown
 * positions pass but are marked unverifiable: a camera nobody has placed cannot contradict
 * anything, and silently dropping its sightings would hide evidence because of a mapping gap rather
 * than a factual one — while silently accepting them would present an unchecked leg as a sound one.
 */
export function legIsPossible(
  fromLat: number | null, fromLng: number | null, fromAt: Date,
  toLat: number | null, toLng: number | null, toAt: Date,
): { possible: boolean; km: number | null; speedKmh: number | null; verifiable: boolean } {
  if (fromLat === null || fromLng === null || toLat === null || toLng === null) {
    return { possible: true, km: null, speedKmh: null, verifiable: false };
  }

  const km = haversineKm(fromLat, fromLng, toLat, toLng);
  const seconds = Math.abs(toAt.getTime() - fromAt.getTime()) / 1000;

  if (seconds < MIN_ELAPSED_SECONDS) {
    // Near-simultaneous. Two angles on one junction are fine; two cities are not.
    return { possible: km <= SAME_PLACE_KM, km, speedKmh: null, verifiable: true };
  }

  const speedKmh = km / (seconds / 3600);
  return { possible: speedKmh <= MAX_PLAUSIBLE_SPEED_KMH, km, speedKmh, verifiable: true };
}
