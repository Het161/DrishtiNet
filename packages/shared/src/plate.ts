/**
 * Indian number-plate normalization.
 *
 * Two rules drive the whole design:
 *
 * 1. **Never repair a read that already parses.** `GJ01ABI234` is a grammatically valid plate
 *    (GJ 01 ABI 234) even though OCR probably meant `GJ 01 AB 1234`. Silently rewriting it would
 *    put a plate in the evidence trail that the camera did not see. So the direct parse wins, and
 *    the confusion-pair rewrite is offered as an *alternate* instead.
 * 2. **Never invent.** A read that matches no Indian plate grammar, or lands on a state code that
 *    does not exist, is returned invalid with the raw text preserved. A missing plate is a far
 *    cheaper failure than a fabricated one.
 *
 * The alerts engine matches a watchlist against the primary read *and* its alternates, flagging
 * which one hit — so the strictness above costs no recall, it just makes the uncertainty visible.
 */

/** Live RTO state / UT codes (includes legacy codes still on the road: OR, UA). */
export const STATE_CODES = [
  'AN', 'AP', 'AR', 'AS', 'BR', 'CG', 'CH', 'DD', 'DL', 'DN', 'GA', 'GJ', 'HP', 'HR',
  'JH', 'JK', 'KA', 'KL', 'LA', 'LD', 'MH', 'ML', 'MN', 'MP', 'MZ', 'NL', 'OD', 'OR',
  'PB', 'PY', 'RJ', 'SK', 'TN', 'TR', 'TS', 'UA', 'UK', 'UP', 'WB',
] as const;

export type StateCode = (typeof STATE_CODES)[number];

const STATE_CODE_SET: ReadonlySet<string> = new Set(STATE_CODES);

/** Bharat series: 22 BH 1234 AB — year(2) + "BH" + number(4) + series(1-2). */
const RE_BH = /^(\d{2})(BH)(\d{4})([A-Z]{1,2})$/;

const RE_DIGITS = /^\d+$/;
const RE_LETTERS = /^[A-Z]+$/;

/**
 * Position-aware OCR confusion pairs, applied only when the direct parse has already failed and
 * the slot's type is unambiguous from the layout.
 */
const TO_DIGIT: Readonly<Record<string, string>> = {
  O: '0', Q: '0', D: '0', I: '1', L: '1', J: '1', Z: '2', A: '4', S: '5', B: '8', G: '6', T: '7',
};
const TO_LETTER: Readonly<Record<string, string>> = {
  '0': 'O', '1': 'I', '2': 'Z', '4': 'A', '5': 'S', '6': 'G', '8': 'B',
};

export type PlateKind = 'standard' | 'bharat' | 'unknown';

export interface PlateNormalizationResult {
  /** Canonical unspaced plate — only set when `valid`. */
  plate: string | null;
  /** Human-facing spaced form, e.g. "GJ 01 AB 1234" — only set when `valid`. */
  formatted: string | null;
  valid: boolean;
  stateCode: StateCode | null;
  rtoCode: string | null;
  series: string | null;
  number: string | null;
  kind: PlateKind;
  /** Raw OCR text exactly as received, always preserved for the evidence trail. */
  raw: string;
  /** True when the primary read required confusion-pair repair. Surface this in the UI. */
  repaired: boolean;
  /**
   * Other canonical plates this read could plausibly be, best-first. Used for watchlist recall,
   * never presented as the plate that was seen.
   */
  alternates: string[];
  reason?: string;
}

interface Parse {
  plate: string;
  formatted: string;
  kind: PlateKind;
  stateCode: StateCode | null;
  rtoCode: string;
  series: string | null;
  number: string;
  repaired: boolean;
}

/** Strip everything that cannot appear on a plate and uppercase. */
export function cleanPlateText(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Enumerate every way `s` can be read as a standard plate.
 * Tries the longest trailing number block first, since a 4-digit number is by far the common case.
 */
function enumerateStandard(s: string, repaired: boolean): Parse[] {
  const out: Parse[] = [];
  // Shortest legal layout is state(2)+rto(1)+number(1) = 4; longest is 2+2+3+4 = 11.
  if (s.length < 4 || s.length > 11) return out;

  const maxNumLen = Math.min(4, s.length - 3);
  for (let numLen = maxNumLen; numLen >= 1; numLen--) {
    const num = s.slice(s.length - numLen);
    if (!RE_DIGITS.test(num)) continue;

    const prefix = s.slice(0, s.length - numLen);
    const state = prefix.slice(0, 2);
    if (!RE_LETTERS.test(state) || !STATE_CODE_SET.has(state)) continue;

    for (const rtoLen of [2, 1] as const) {
      if (prefix.length < 2 + rtoLen) continue;
      const rto = prefix.slice(2, 2 + rtoLen);
      if (!RE_DIGITS.test(rto)) continue;

      const series = prefix.slice(2 + rtoLen);
      if (series.length > 3) continue;
      if (series.length > 0 && !RE_LETTERS.test(series)) continue;

      const paddedRto = rto.padStart(2, '0');
      out.push({
        plate: `${state}${paddedRto}${series}${num}`,
        formatted: [state, paddedRto, series, num].filter(Boolean).join(' '),
        kind: 'standard',
        stateCode: state as StateCode,
        rtoCode: paddedRto,
        series: series || null,
        number: num,
        repaired,
      });
    }
  }
  return out;
}

function enumerateBharat(s: string, repaired: boolean): Parse[] {
  const m = RE_BH.exec(s);
  if (!m) return [];
  const [, year, , num, series] = m;
  return [{
    plate: s,
    formatted: `${year} BH ${num} ${series}`,
    kind: 'bharat',
    stateCode: null,
    rtoCode: year!,
    series: series!,
    number: num!,
    repaired,
  }];
}

/** Higher is better. A 4-digit number block dominates, because that is what real plates carry. */
function score(p: Parse): number {
  let s = p.number.length === 4 ? 100 : p.number.length * 12;
  if (p.repaired) s -= 8;
  if (p.series && p.series.length <= 2) s += 3;
  if (p.rtoCode.length === 2) s += 2;
  if (p.kind === 'bharat') s += 5;
  return s;
}

/**
 * Rewrite characters whose slot type is forced by the most likely layout.
 * Only ever called when no direct parse succeeded.
 */
function repairCandidate(s: string): string | null {
  if (s.length < 4 || s.length > 11) return null;
  const chars = s.split('');

  // Slots 0-1 are always letters.
  for (let i = 0; i < 2; i++) {
    const c = chars[i]!;
    if (!RE_LETTERS.test(c) && TO_LETTER[c]) chars[i] = TO_LETTER[c]!;
  }
  // The trailing number block is always digits.
  const tailLen = Math.min(4, s.length - 3);
  for (let i = chars.length - tailLen; i < chars.length; i++) {
    const c = chars[i]!;
    if (!RE_DIGITS.test(c) && TO_DIGIT[c]) chars[i] = TO_DIGIT[c]!;
  }
  // Slot 2 is the first RTO district digit.
  const c2 = chars[2]!;
  if (!RE_DIGITS.test(c2) && TO_DIGIT[c2]) chars[2] = TO_DIGIT[c2]!;

  const out = chars.join('');
  return out === s ? null : out;
}

function fail(raw: string, reason: string): PlateNormalizationResult {
  return {
    plate: null, formatted: null, valid: false, stateCode: null, rtoCode: null,
    series: null, number: null, kind: 'unknown', raw, repaired: false, alternates: [], reason,
  };
}

/**
 * Normalize a raw OCR string into a canonical Indian plate.
 * Set `allowRepair` to false for operator-typed watchlist input — a human typing a plate should be
 * told their entry is malformed, not have it quietly rewritten.
 */
export function normalizePlate(raw: string, allowRepair = true): PlateNormalizationResult {
  const cleaned = cleanPlateText(raw);
  if (cleaned.length === 0) return fail(raw, 'empty after cleaning');

  const direct = [...enumerateBharat(cleaned, false), ...enumerateStandard(cleaned, false)];
  const repairedParses: Parse[] = [];

  if (allowRepair) {
    const candidate = repairCandidate(cleaned);
    if (candidate) {
      repairedParses.push(
        ...enumerateBharat(candidate, true),
        ...enumerateStandard(candidate, true),
      );
    }
  }

  // Rule 1: a direct parse always wins over any repair.
  const pool = direct.length > 0 ? direct : repairedParses;
  if (pool.length === 0) {
    return fail(raw, 'does not match any known Indian plate grammar or state code');
  }

  const ranked = [...pool].sort((a, b) => score(b) - score(a));
  const best = ranked[0]!;

  // Alternates: every other distinct canonical plate we could plausibly be looking at, including
  // the repaired readings that rule 1 kept out of the primary slot.
  const seen = new Set([best.plate]);
  const alternates: string[] = [];
  for (const p of [...ranked.slice(1), ...(direct.length > 0 ? repairedParses : [])]
    .sort((a, b) => score(b) - score(a))) {
    if (seen.has(p.plate)) continue;
    seen.add(p.plate);
    alternates.push(p.plate);
  }

  return {
    plate: best.plate,
    formatted: best.formatted,
    valid: true,
    stateCode: best.stateCode,
    rtoCode: best.rtoCode,
    series: best.series,
    number: best.number,
    kind: best.kind,
    raw,
    repaired: best.repaired,
    alternates,
  };
}

/** Canonical key for the plate we believe was seen. Null for invalid reads. */
export function plateMatchKey(raw: string): string | null {
  const r = normalizePlate(raw);
  return r.valid ? r.plate : null;
}

/**
 * Every canonical plate a read could correspond to, best-first.
 * The alerts engine matches a watchlist against this whole list so an OCR confusion (1↔I, 0↔O)
 * does not cause a miss — while the UI still shows only the primary as "what was read".
 */
export function plateCandidates(raw: string): string[] {
  const r = normalizePlate(raw);
  if (!r.valid || !r.plate) return [];
  return [r.plate, ...r.alternates];
}

/**
 * Levenshtein distance, capped — used for "near-miss" watchlist suggestions in the triage UI.
 * A near miss is shown to the operator as a suggestion; it never auto-fires an alert.
 */
export function plateDistance(a: string, b: string, cap = 3): number {
  const s = cleanPlateText(a);
  const t = cleanPlateText(b);
  if (Math.abs(s.length - t.length) > cap) return cap + 1;
  let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i++) {
    const curr: number[] = [i];
    let rowMin = i;
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      const v = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
      curr[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > cap) return cap + 1;
    prev = curr;
  }
  return Math.min(prev[t.length]!, cap + 1);
}
