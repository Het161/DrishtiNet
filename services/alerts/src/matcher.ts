/**
 * Deciding whether a vehicle we just saw is one somebody is looking for.
 *
 * ── Why the signature leads and the plate corroborates ───────────────────────────────────────────
 *
 * Measured on the organisers' footage at their camera geometry: the median vehicle box is 164 px
 * wide, which puts a ten-character plate at roughly 41 px. Nothing reads that. So a matcher built
 * plate-first would match almost nothing on this grid, and the little it did match would be OCR
 * guesses on the few close vehicles — confident, wrong, and pointed at a real registration number.
 *
 * The appearance embedding is the opposite: measured separation on real cam_10 vehicles is 0.950
 * for the same vehicle against 0.544 for different ones. That margin is what identification runs
 * on here. A plate, when one is legible, raises confidence and is recorded as the corroborating
 * signal — never as the sole reason for an alert.
 *
 * ── Why thresholds are named, not inlined ────────────────────────────────────────────────────────
 *
 * Every number below sits between "missed the vehicle we were asked to find" and "cried wolf at a
 * control room". Both failures are expensive and they pull in opposite directions, so each
 * threshold is stated with the measurement it came from rather than tuned until a demo looked good.
 */
import { normalizePlate, plateCandidates, plateDistance } from '@drishtinet/shared/plate';

/** A finished vehicle signature, as published by the analytics pipeline. */
export interface ObservedSignature {
  trackId: string;
  cameraId: string;
  cameraLabel: string;
  cls: string;
  colour: string | null;
  colourConfidence: number;
  colourUncertain: boolean;
  partialPlate: string | null;
  embedding: number[];
  embeddingModel: string | null;
  recordedAtMs: number;
  detectedAtMs: number;
}

export type EntityType = 'vehicle_plate' | 'vehicle_attributes' | 'person' | 'object';
export type Priority = 'critical' | 'high' | 'medium' | 'low';

export interface WatchlistTarget {
  entryId: string;
  entityType: EntityType;
  /** Canonical plate for a plate entry; a descriptor like "white truck" otherwise. */
  entityValue: string;
  reason: string;
  priority: Priority;
  /** Reference embeddings, when the target has been seen before and enrolled. */
  embeddings?: number[][];
}

export interface Match {
  entry: WatchlistTarget;
  confidence: number;
  /** What actually produced the match, so an operator can weigh it. */
  matchedVia: 'plate' | 'plate-alternate' | 'appearance' | 'attributes';
  /** True when the plate had to be repaired to match — always surfaced, never hidden. */
  repaired: boolean;
  source: 'internal_anpr' | 'internal_reid';
}

/**
 * Appearance similarity above which two tracks are treated as the same vehicle.
 *
 * Measured: same vehicle median 0.950, different vehicles median 0.544. 0.82 sits well clear of the
 * different-vehicle distribution while leaving headroom for a poorer view — a vehicle seen from a
 * sharper angle on the second camera scores lower than one seen the same way twice.
 */
export const APPEARANCE_MATCH_THRESHOLD = 0.82;

/**
 * Above this, a match is strong enough to raise on appearance alone. Between the two thresholds it
 * needs corroboration — matching class, or a colour that is not flagged uncertain.
 */
export const APPEARANCE_STRONG_THRESHOLD = 0.9;

/** Edit distance within which a partial plate is considered the same plate. */
export const PLATE_MAX_DISTANCE = 2;

/** Both vectors are stored L2-normalised, so cosine similarity is a dot product. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  // A zero vector is what a track with no usable crops stores. It must match nothing, rather than
  // matching everything through a division that produces NaN.
  if (na < 1e-12 || nb < 1e-12) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Best appearance similarity between an observation and any enrolled view of a target.
 *
 * Maximum rather than mean: a target enrolled from three angles should match on the one that
 * resembles the current view, and averaging across the other two would bury exactly the evidence
 * that identifies it.
 */
export function bestAppearanceScore(
  observed: readonly number[],
  references: readonly (readonly number[])[] | undefined,
): number {
  if (!references || references.length === 0) return 0;
  let best = 0;
  for (const reference of references) {
    const score = cosineSimilarity(observed, reference);
    if (score > best) best = score;
  }
  return best;
}

/**
 * Does an observed partial plate match a watchlist plate?
 *
 * Partial is the normal case, not the exception: a plate is often legible only in part, and half a
 * registration is still evidence. What is never acceptable is padding the missing half — the parser
 * offers alternates for genuinely ambiguous characters, and each is tried as itself.
 */
export function matchPlate(
  observed: string | null,
  target: string,
): { matched: boolean; via: 'plate' | 'plate-alternate'; repaired: boolean; distance: number } {
  const none = { matched: false, via: 'plate' as const, repaired: false, distance: 99 };
  if (!observed) return none;

  const targetKey = normalizePlate(target, false).plate ?? target.toUpperCase().replace(/\s+/g, '');

  // `allowRepair: false` first, so a plate that parses cleanly is never credited to a repair.
  const direct = normalizePlate(observed, false);
  if (direct.plate) {
    const distance = plateDistance(direct.plate, targetKey, PLATE_MAX_DISTANCE + 1);
    if (distance <= PLATE_MAX_DISTANCE) {
      return { matched: true, via: 'plate', repaired: false, distance };
    }
  }

  // Only now consider readings that needed repair, and say so when one is used.
  for (const candidate of plateCandidates(observed)) {
    const distance = plateDistance(candidate, targetKey, PLATE_MAX_DISTANCE + 1);
    if (distance <= PLATE_MAX_DISTANCE) {
      return { matched: true, via: 'plate-alternate', repaired: true, distance };
    }
  }
  return none;
}

/** Does a free-text descriptor like "white truck" describe this observation? */
export function matchAttributes(signature: ObservedSignature, descriptor: string): boolean {
  const words = descriptor.toLowerCase().split(/[\s,]+/).filter(Boolean);
  if (words.length === 0) return false;

  const cls = signature.cls.toLowerCase();
  const colour = (signature.colour ?? '').toLowerCase();

  const classWords = words.filter((w) => w === cls);
  const colourWords = words.filter((w) => w === colour);

  // Colour alone is too weak to raise an alert on, and a colour the pipeline itself flagged as
  // unreliable is weaker still. Require the class to agree, and require the colour to be trusted
  // before it is allowed to contribute at all.
  if (classWords.length === 0) return false;
  const colourMentioned = words.some((w) =>
    ['white', 'black', 'grey', 'silver', 'red', 'blue', 'green', 'yellow', 'orange', 'purple'].includes(w),
  );
  if (!colourMentioned) return true;
  if (signature.colourUncertain) return false;
  return colourWords.length > 0;
}

/**
 * Match one observation against the active watchlist.
 *
 * Returns every match rather than the best one: the same vehicle can appear on two lists for
 * different reasons, and suppressing the second would hide the more serious one at random.
 */
export function matchSignature(
  signature: ObservedSignature,
  targets: readonly WatchlistTarget[],
): Match[] {
  const matches: Match[] = [];

  for (const target of targets) {
    if (target.entityType === 'vehicle_plate') {
      const plate = matchPlate(signature.partialPlate, target.entityValue);
      if (plate.matched) {
        // A repaired reading is worth less than a clean one, and the alert says which it was.
        const confidence = plate.repaired ? 0.7 : 0.95 - plate.distance * 0.1;
        matches.push({
          entry: target,
          confidence: Number(confidence.toFixed(3)),
          matchedVia: plate.via,
          repaired: plate.repaired,
          source: 'internal_anpr',
        });
        continue;
      }
      // A plate entry can still match on appearance when the target has been enrolled visually —
      // which on this grid is the only way most plate watchlist entries will ever be found.
      const score = bestAppearanceScore(signature.embedding, target.embeddings);
      if (score >= APPEARANCE_STRONG_THRESHOLD) {
        matches.push({
          entry: target,
          confidence: Number(score.toFixed(3)),
          matchedVia: 'appearance',
          repaired: false,
          source: 'internal_reid',
        });
      }
      continue;
    }

    if (target.entityType === 'vehicle_attributes') {
      const score = bestAppearanceScore(signature.embedding, target.embeddings);
      const appearanceMatched =
        score >= APPEARANCE_STRONG_THRESHOLD ||
        (score >= APPEARANCE_MATCH_THRESHOLD && matchAttributes(signature, target.entityValue));

      if (appearanceMatched) {
        matches.push({
          entry: target,
          confidence: Number(score.toFixed(3)),
          matchedVia: 'appearance',
          repaired: false,
          source: 'internal_reid',
        });
      } else if (!target.embeddings?.length && matchAttributes(signature, target.entityValue)) {
        // No enrolled view to compare against: attributes are all there is. Deliberately capped
        // low — "a white truck" describes hundreds of vehicles a day, and an operator should see
        // that reflected in the confidence rather than have to know it.
        matches.push({
          entry: target,
          confidence: 0.45,
          matchedVia: 'attributes',
          repaired: false,
          source: 'internal_reid',
        });
      }
    }
  }

  return matches;
}
