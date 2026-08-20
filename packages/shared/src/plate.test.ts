import { describe, it, expect } from 'vitest';
import { normalizePlate, plateMatchKey, plateCandidates, plateDistance, cleanPlateText } from './plate.js';

describe('cleanPlateText', () => {
  it('strips separators and uppercases', () => {
    expect(cleanPlateText('gj-01 ab 1234')).toBe('GJ01AB1234');
    expect(cleanPlateText('  GJ.01.AB.1234  ')).toBe('GJ01AB1234');
  });
});

describe('normalizePlate — standard plates', () => {
  it('accepts a clean Gujarat plate', () => {
    const r = normalizePlate('GJ01AB1234');
    expect(r.valid).toBe(true);
    expect(r.plate).toBe('GJ01AB1234');
    expect(r.formatted).toBe('GJ 01 AB 1234');
    expect(r.stateCode).toBe('GJ');
    expect(r.rtoCode).toBe('01');
    expect(r.series).toBe('AB');
    expect(r.number).toBe('1234');
    expect(r.repaired).toBe(false);
  });

  it('pads a single-digit RTO code so matching is stable', () => {
    const r = normalizePlate('GJ1AB1234');
    expect(r.valid).toBe(true);
    expect(r.plate).toBe('GJ01AB1234');
  });

  it('accepts plates with no series letters', () => {
    const r = normalizePlate('GJ 18 5678');
    expect(r.valid).toBe(true);
    expect(r.plate).toBe('GJ185678');
    expect(r.series).toBeNull();
  });

  it('accepts a three-letter series', () => {
    const r = normalizePlate('MH12ABC0001');
    expect(r.valid).toBe(true);
    expect(r.plate).toBe('MH12ABC0001');
  });

  it('rejects an unknown state code rather than guessing', () => {
    const r = normalizePlate('ZZ01AB1234');
    expect(r.valid).toBe(false);
    expect(r.plate).toBeNull();
    expect(r.raw).toBe('ZZ01AB1234');
  });
});

describe('normalizePlate — Bharat series', () => {
  it('accepts a BH plate', () => {
    const r = normalizePlate('22BH1234AB');
    expect(r.valid).toBe(true);
    expect(r.kind).toBe('bharat');
    expect(r.formatted).toBe('22 BH 1234 AB');
    expect(r.stateCode).toBeNull();
  });

  it('accepts a single-letter BH series', () => {
    expect(normalizePlate('23BH5678A').valid).toBe(true);
  });
});

describe('normalizePlate — OCR confusion repair', () => {
  it('repairs O→0 in the RTO digits', () => {
    const r = normalizePlate('GJO1AB1234');
    expect(r.valid).toBe(true);
    expect(r.plate).toBe('GJ01AB1234');
    expect(r.repaired).toBe(true);
  });

  it('does NOT rewrite a read that already parses, but offers the repair as an alternate', () => {
    // "GJ 01 ABI 234" is itself a legal layout, so that is what we report as seen.
    const r = normalizePlate('GJ01ABI234');
    expect(r.valid).toBe(true);
    expect(r.plate).toBe('GJ01ABI234');
    expect(r.repaired).toBe(false);
    expect(r.alternates).toContain('GJ01AB1234');
  });

  it('does not sacrifice a genuine 3-digit plate to the 4-digit preference', () => {
    const r = normalizePlate('GJ01AB123');
    expect(r.plate).toBe('GJ01AB123');
    expect(r.repaired).toBe(false);
  });

  it('repairs a digit misread in the leading state code', () => {
    const r = normalizePlate('0D01AB1234'); // Odisha "OD" with O misread as zero
    expect(r.valid).toBe(true);
    expect(r.plate).toBe('OD01AB1234');
    expect(r.repaired).toBe(true);
  });

  it('rejects a repair that lands on a non-existent state code', () => {
    // "0J" repairs to "OJ", which is not an RTO state code — so the read is dropped, not guessed.
    expect(normalizePlate('0J01AB1234').valid).toBe(false);
  });

  it('does not repair when repair is disabled (operator-typed input)', () => {
    const r = normalizePlate('GJO1AB1234', false);
    expect(r.valid).toBe(false);
  });

  it('never invents a plate from garbage', () => {
    for (const junk of ['', '???', 'HELLO', '1', '99999999999999']) {
      const r = normalizePlate(junk);
      expect(r.valid).toBe(false);
      expect(r.plate).toBeNull();
    }
  });

  it('always preserves the raw OCR text for the evidence trail', () => {
    const r = normalizePlate('gj-01-ab-1234');
    expect(r.raw).toBe('gj-01-ab-1234');
  });
});

describe('plateMatchKey', () => {
  it('produces the same key for differently formatted reads of one plate', () => {
    const forms = ['GJ01AB1234', 'gj 01 ab 1234', 'GJ-01-AB-1234', 'GJ1AB1234'];
    const keys = forms.map(plateMatchKey);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe('GJ01AB1234');
  });

  it('returns null for an invalid read so it can never match a watchlist entry', () => {
    expect(plateMatchKey('ZZ99ZZ9999')).toBeNull();
  });
});

describe('plateCandidates', () => {
  it('lets a watchlist still catch an OCR confusion without rewriting the reported read', () => {
    const candidates = plateCandidates('GJ01ABI234');
    expect(candidates[0]).toBe('GJ01ABI234');
    expect(candidates).toContain('GJ01AB1234');
  });

  it('is empty for an unreadable plate, so nothing can match', () => {
    expect(plateCandidates('!!!!')).toEqual([]);
  });
});

describe('plateDistance', () => {
  it('is zero for identical plates', () => {
    expect(plateDistance('GJ01AB1234', 'GJ 01 AB 1234')).toBe(0);
  });

  it('finds a one-character near miss', () => {
    expect(plateDistance('GJ01AB1234', 'GJ01AB1235')).toBe(1);
  });

  it('caps out for wildly different strings instead of scanning forever', () => {
    expect(plateDistance('GJ01AB1234', 'MH99XY0000', 3)).toBe(4);
  });
});
