import { describe, it, expect } from 'vitest';
import { isWithinGujarat, VERIFIED_RADII, GUJARAT_BOUNDS } from './placement';

describe('isWithinGujarat', () => {
  it('accepts real camera positions', () => {
    expect(isWithinGujarat(21.5225, 70.4595)).toBe(true);  // Char Chowk, Junagadh
    expect(isWithinGujarat(23.108, 72.589)).toBe(true);    // Visat, Ahmedabad
    expect(isWithinGujarat(23.08, 70.13)).toBe(true);      // Gandhidham
  });

  it('refuses a drag that slipped into the sea or another state', () => {
    expect(isWithinGujarat(19.076, 72.877)).toBe(false);   // Mumbai
    expect(isWithinGujarat(28.61, 77.21)).toBe(false);     // Delhi
    expect(isWithinGujarat(21.5, 65.0)).toBe(false);       // Arabian Sea
  });

  it('refuses non-finite input rather than storing NaN', () => {
    expect(isWithinGujarat(Number.NaN, 70)).toBe(false);
    expect(isWithinGujarat(22, Infinity)).toBe(false);
  });

  it('offers only radii that mean "a human placed this"', () => {
    expect(VERIFIED_RADII[0]).toBe(0);
    expect(Math.max(...VERIFIED_RADII)).toBeLessThanOrEqual(100);
  });

  it('bounds actually contain Gujarat', () => {
    expect(GUJARAT_BOUNDS.minLat).toBeLessThan(20.1);
    expect(GUJARAT_BOUNDS.maxLat).toBeGreaterThan(24.7);
  });
});
