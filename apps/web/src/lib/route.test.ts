import { describe, expect, it } from 'vitest';

import { legIsPossible, MAX_PLAUSIBLE_SPEED_KMH } from './route-rules';

/**
 * The physical-possibility filter.
 *
 * This exists because of a measurement: at cosine 0.82 the appearance model produced 949 matches
 * between cameras 5 and 16 — one junction from two angles, which is correct — and 20 matches
 * between cameras 5 and 10, which sit roughly 300 km apart in different districts. An appearance
 * model cannot tell those apart, because nobody asked it about geography.
 *
 * An investigator shown one impossible leg stops trusting the possible ones, so this is the part of
 * route reconstruction most worth pinning down.
 */

const AHMEDABAD = { lat: 23.108, lng: 72.589 };
// Junagadh, ~300 km away — the real separation that produced the false positives.
const JUNAGADH = { lat: 21.522, lng: 70.457 };

const at = (iso: string) => new Date(iso);

describe('legIsPossible', () => {
  it('rejects a leap across the state in no time at all', () => {
    const leg = legIsPossible(
      AHMEDABAD.lat, AHMEDABAD.lng, at('2026-06-13T21:00:00Z'),
      JUNAGADH.lat, JUNAGADH.lng, at('2026-06-13T21:00:05Z'),
    );
    expect(leg.possible).toBe(false);
    expect(leg.km).toBeGreaterThan(200);
  });

  it('accepts two angles on one junction seen seconds apart', () => {
    // Cameras 5 and 16 share a position to within their placement uncertainty.
    const leg = legIsPossible(
      AHMEDABAD.lat, AHMEDABAD.lng, at('2026-06-13T21:00:00Z'),
      AHMEDABAD.lat, AHMEDABAD.lng, at('2026-06-13T21:00:04Z'),
    );
    expect(leg.possible).toBe(true);
  });

  it('accepts a long journey given enough time for it', () => {
    const leg = legIsPossible(
      AHMEDABAD.lat, AHMEDABAD.lng, at('2026-06-13T21:00:00Z'),
      JUNAGADH.lat, JUNAGADH.lng, at('2026-06-14T01:00:00Z'), // four hours
    );
    expect(leg.possible).toBe(true);
    expect(leg.speedKmh).toBeLessThan(MAX_PLAUSIBLE_SPEED_KMH);
  });

  it('rejects the same journey attempted too quickly', () => {
    const leg = legIsPossible(
      AHMEDABAD.lat, AHMEDABAD.lng, at('2026-06-13T21:00:00Z'),
      JUNAGADH.lat, JUNAGADH.lng, at('2026-06-13T21:30:00Z'), // 300 km in half an hour
    );
    expect(leg.possible).toBe(false);
    expect(leg.speedKmh).toBeGreaterThan(MAX_PLAUSIBLE_SPEED_KMH);
  });

  it('does not judge near-simultaneous sightings by speed', () => {
    // Dividing by nearly zero makes every pair look impossibly fast, so short legs go by distance.
    const leg = legIsPossible(
      AHMEDABAD.lat, AHMEDABAD.lng, at('2026-06-13T21:00:00Z'),
      AHMEDABAD.lat, AHMEDABAD.lng, at('2026-06-13T21:00:01Z'),
    );
    expect(leg.speedKmh).toBeNull();
    expect(leg.possible).toBe(true);
  });

  it('keeps an unverifiable leg but never calls it verified', () => {
    /**
     * Camera 10 has no placed position, and it is exactly the camera producing matches 300 km from
     * Ahmedabad. Dropping its sightings would hide evidence over a mapping gap; accepting them
     * silently would present an unchecked leg as a confirmed one. It is kept, and flagged.
     */
    const leg = legIsPossible(
      AHMEDABAD.lat, AHMEDABAD.lng, at('2026-06-13T21:00:00Z'),
      null, null, at('2026-06-13T21:00:05Z'),
    );
    expect(leg.possible).toBe(true);
    expect(leg.verifiable).toBe(false);
    expect(leg.km).toBeNull();
  });

  it('treats a verifiable leg as verifiable', () => {
    const leg = legIsPossible(
      AHMEDABAD.lat, AHMEDABAD.lng, at('2026-06-13T21:00:00Z'),
      AHMEDABAD.lat, AHMEDABAD.lng, at('2026-06-13T21:05:00Z'),
    );
    expect(leg.verifiable).toBe(true);
  });

  it('is symmetric in time, so an out-of-order pair is still judged on elapsed time', () => {
    const forward = legIsPossible(
      AHMEDABAD.lat, AHMEDABAD.lng, at('2026-06-13T21:00:00Z'),
      JUNAGADH.lat, JUNAGADH.lng, at('2026-06-13T21:30:00Z'),
    );
    const backward = legIsPossible(
      AHMEDABAD.lat, AHMEDABAD.lng, at('2026-06-13T21:30:00Z'),
      JUNAGADH.lat, JUNAGADH.lng, at('2026-06-13T21:00:00Z'),
    );
    expect(backward.speedKmh).toBeCloseTo(forward.speedKmh!, 1);
  });
});
