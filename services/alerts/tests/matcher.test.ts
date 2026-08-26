import { describe, expect, it } from 'vitest';

import {
  APPEARANCE_MATCH_THRESHOLD,
  APPEARANCE_STRONG_THRESHOLD,
  bestAppearanceScore,
  cosineSimilarity,
  matchAttributes,
  matchPlate,
  matchSignature,
  type ObservedSignature,
  type WatchlistTarget,
} from '../src/matcher.js';

/**
 * Every assertion here sits between two expensive failures: missing the vehicle the organisers
 * asked us to find, and crying wolf at a control room. They pull in opposite directions, so the
 * thresholds are pinned to the measurements they came from rather than to whatever made a demo
 * look good.
 */

const DIM = 512;

function vector(seed: number, dim = DIM): number[] {
  // Deterministic pseudo-random unit vector, so a failure is reproducible.
  const out: number[] = [];
  let x = seed;
  for (let i = 0; i < dim; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out.push(x / 2147483648 - 0.5);
  }
  const norm = Math.sqrt(out.reduce((s, v) => s + v * v, 0));
  return out.map((v) => v / norm);
}

/** A vector at a chosen cosine similarity to `base`. */
function similarTo(base: number[], target = 0.95): number[] {
  const noise = vector(999);
  const out = base.map((v, i) => v * target + noise[i]! * Math.sqrt(1 - target * target));
  const norm = Math.sqrt(out.reduce((s, v) => s + v * v, 0));
  return out.map((v) => v / norm);
}

function signature(over: Partial<ObservedSignature> = {}): ObservedSignature {
  return {
    trackId: 't1',
    cameraId: 'cam-a',
    cameraLabel: '10 char-chowk-road-2-junagadh',
    cls: 'car',
    colour: 'white',
    colourConfidence: 0.9,
    colourUncertain: false,
    partialPlate: null,
    embedding: vector(1),
    embeddingModel: 'osnet_x0_25_msmt17.onnx',
    recordedAtMs: 1_760_000_000_000,
    detectedAtMs: Date.now(),
    ...over,
  };
}

function target(over: Partial<WatchlistTarget> = {}): WatchlistTarget {
  return {
    entryId: 'e1',
    entityType: 'vehicle_plate',
    entityValue: 'GJ01AB1234',
    reason: 'stolen vehicle',
    priority: 'high',
    ...over,
  };
}

describe('cosineSimilarity', () => {
  it('is 1 for a vector against itself', () => {
    const v = vector(7);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it('refuses to match a zero vector against anything', () => {
    // A track with no usable crops stores zeros. Dividing by its norm would give NaN, and a NaN
    // comparison silently reads as "no match" in some places and "match" in others.
    expect(cosineSimilarity(new Array(DIM).fill(0), vector(3))).toBe(0);
  });

  it('returns 0 rather than throwing on mismatched dimensions', () => {
    expect(cosineSimilarity(vector(1, 512), vector(1, 128))).toBe(0);
  });
});

describe('bestAppearanceScore', () => {
  it('takes the best enrolled view, not the average', () => {
    // A target enrolled from three angles should match on the one resembling this view; averaging
    // across the other two would bury exactly the evidence that identifies it.
    const observed = vector(1);
    const score = bestAppearanceScore(observed, [vector(50), observed, vector(60)]);
    expect(score).toBeCloseTo(1, 5);
  });

  it('is 0 when the target has never been enrolled', () => {
    expect(bestAppearanceScore(vector(1), undefined)).toBe(0);
    expect(bestAppearanceScore(vector(1), [])).toBe(0);
  });
});

describe('plate matching', () => {
  it('matches an exact read without claiming a repair', () => {
    const result = matchPlate('GJ01AB1234', 'GJ01AB1234');
    expect(result.matched).toBe(true);
    expect(result.repaired).toBe(false);
    expect(result.via).toBe('plate');
  });

  it('matches a spaced plate against the canonical form', () => {
    expect(matchPlate('GJ 01 AB 1234', 'GJ01AB1234').matched).toBe(true);
  });

  it('never matches when nothing was legible', () => {
    expect(matchPlate(null, 'GJ01AB1234').matched).toBe(false);
    expect(matchPlate('', 'GJ01AB1234').matched).toBe(false);
  });

  it('does not match an unrelated plate', () => {
    expect(matchPlate('MH12XY9999', 'GJ01AB1234').matched).toBe(false);
  });

  it('flags a match that needed character repair', () => {
    // O/0 and I/1 are the classic OCR confusions. A repaired read is still worth surfacing, but the
    // operator has to be told it was repaired — that is the difference between evidence and a guess.
    const result = matchPlate('GJO1AB1234', 'GJ01AB1234');
    if (result.matched) expect(result.repaired || result.via === 'plate-alternate').toBe(true);
  });
});

describe('attribute matching', () => {
  it('requires the class to agree', () => {
    expect(matchAttributes(signature({ cls: 'car' }), 'white truck')).toBe(false);
    expect(matchAttributes(signature({ cls: 'truck', colour: 'white' }), 'white truck')).toBe(true);
  });

  it('refuses to use a colour the pipeline flagged as unreliable', () => {
    // At night the colour estimate is not trustworthy, and "white truck" matched on a guessed
    // colour would send an operator after the wrong vehicle.
    const nightly = signature({ cls: 'truck', colour: 'white', colourUncertain: true });
    expect(matchAttributes(nightly, 'white truck')).toBe(false);
    // The class alone still matches, because that part was never in doubt.
    expect(matchAttributes(nightly, 'truck')).toBe(true);
  });

  it('ignores an empty descriptor', () => {
    expect(matchAttributes(signature(), '')).toBe(false);
  });
});

describe('matchSignature', () => {
  it('raises nothing against an empty watchlist', () => {
    expect(matchSignature(signature(), [])).toEqual([]);
  });

  it('matches a plate entry on a legible plate', () => {
    const matches = matchSignature(signature({ partialPlate: 'GJ01AB1234' }), [target()]);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.matchedVia).toBe('plate');
    expect(matches[0]!.source).toBe('internal_anpr');
    expect(matches[0]!.confidence).toBeGreaterThan(0.9);
  });

  it('matches a plate entry on appearance when the plate is unreadable', () => {
    // This is the normal case on this grid, not the exception: a plate occupies about 41 px of a
    // median 164 px vehicle box, so most watchlist hits can only ever come from appearance.
    const enrolled = vector(1);
    const matches = matchSignature(
      signature({ partialPlate: null, embedding: enrolled }),
      [target({ embeddings: [enrolled] })],
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]!.matchedVia).toBe('appearance');
    expect(matches[0]!.source).toBe('internal_reid');
  });

  it('does not raise on a weak appearance score', () => {
    // Measured: different vehicles sit around 0.544. Nothing near that may reach an operator.
    const observed = vector(1);
    const different = similarTo(observed, 0.55);
    const matches = matchSignature(
      signature({ embedding: observed }),
      [target({ embeddings: [different] })],
    );
    expect(matches).toEqual([]);
  });

  it('caps confidence on an attributes-only match', () => {
    // "A white truck" describes hundreds of vehicles a day. The operator should see that in the
    // number rather than having to know it.
    const matches = matchSignature(
      signature({ cls: 'truck', colour: 'white' }),
      [target({ entityType: 'vehicle_attributes', entityValue: 'white truck' })],
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]!.matchedVia).toBe('attributes');
    expect(matches[0]!.confidence).toBeLessThan(0.6);
  });

  it('returns every list a vehicle appears on, not just the first', () => {
    // The same vehicle can be wanted for two reasons; suppressing one would hide the more serious
    // one at random.
    const enrolled = vector(1);
    const matches = matchSignature(signature({ partialPlate: 'GJ01AB1234', embedding: enrolled }), [
      target({ entryId: 'a', entityValue: 'GJ01AB1234', priority: 'high' }),
      target({
        entryId: 'b',
        entityType: 'vehicle_attributes',
        entityValue: 'white car',
        priority: 'critical',
      }),
    ]);
    expect(matches.map((m) => m.entry.entryId).sort()).toEqual(['a', 'b']);
  });

  it('keeps the two appearance thresholds in the right order', () => {
    expect(APPEARANCE_MATCH_THRESHOLD).toBeLessThan(APPEARANCE_STRONG_THRESHOLD);
    // Both must sit clear of the measured different-vehicle median of 0.544.
    expect(APPEARANCE_MATCH_THRESHOLD).toBeGreaterThan(0.7);
  });
});
