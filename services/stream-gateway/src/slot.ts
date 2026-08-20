/**
 * Sentinel portal "simulated live" timeline arithmetic.
 *
 * The provided feeds are NOT live cameras. Each is a long recording served as a progressive MP4
 * over HTTP range, and the portal manufactures the illusion of live purely in the browser:
 *
 *     position_in_file = ((slot_offset + elapsed) mod slot_seconds) mod file_duration
 *
 * with `slot_seconds = 43200` (12 h). Reverse-engineering an observed sample pinned the slot
 * boundaries exactly:
 *
 *     server_epoch = 1787239306.351337  →  slot_offset = 42706.351337
 *     slot start   = 1787196600         →  2026-08-20 09:00:00 IST
 *
 * so slots begin at 09:00 and 21:00 IST. `slotOffsetSeconds()` below reproduces that number to the
 * microsecond, which is what makes it safe to align our own ingest to what the operator sees.
 *
 * Three consequences that shape the whole system:
 *
 *  1. Opening the MP4 naively starts at t=0 — i.e. up to 12 hours "in the past". Any ingest MUST
 *     seek to the computed offset or analytics will describe a completely different moment than
 *     the video wall.
 *  2. Files are shorter than the slot and loop within it, so a camera replays its footage several
 *     times per slot. Two cameras only show the same real-world instant if their durations match.
 *  3. At 09:00 and 21:00 IST every feed discontinuously jumps back toward the start of its file.
 *     `secondsUntilSlotRollover()` exists so the demo can be scheduled around it.
 */

/** India Standard Time is a fixed UTC+5:30 with no daylight saving — a constant is correct here. */
export const IST_OFFSET_SECONDS = 5.5 * 3600; // 19800

/** Length of one playback slot, from the portal's own /api/cameras/{id}/state. */
export const SLOT_SECONDS = 43200; // 12 hours

/** First slot boundary of an IST day, as seconds past IST midnight (09:00 IST). */
export const SLOT_ANCHOR_SECONDS = 9 * 3600; // 32400

/** Always-positive modulo — JS `%` keeps the sign of the dividend, which would break pre-anchor times. */
function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

/**
 * Seconds elapsed since the most recent 09:00/21:00 IST slot boundary.
 * Equivalent to the portal's `slot_offset` field.
 */
export function slotOffsetSeconds(nowMs: number = now()): number {
  const epochSec = nowMs / 1000;
  return mod(epochSec + IST_OFFSET_SECONDS - SLOT_ANCHOR_SECONDS, SLOT_SECONDS);
}

/** Unix epoch (ms) of the slot boundary currently in effect. */
export function slotStartMs(nowMs: number = now()): number {
  return nowMs - slotOffsetSeconds(nowMs) * 1000;
}

/** Seconds remaining before every feed jumps. Use it to warn before a demo crosses a boundary. */
export function secondsUntilSlotRollover(nowMs: number = now()): number {
  return SLOT_SECONDS - slotOffsetSeconds(nowMs);
}

export interface PlaybackPositionOptions {
  /** File duration in seconds, from our own probe. Null means "unknown — start from the offset". */
  durationSeconds: number | null;
  /** Portal reports `loop: true` for every camera; kept configurable for honesty. */
  loop?: boolean;
  nowMs?: number;
}

/**
 * Where in the source file "now" is, mirroring the portal player's `expectedOffset()`.
 * This is the value we hand to `ffmpeg -ss`.
 */
export function playbackPositionSeconds(opts: PlaybackPositionOptions): number {
  const { durationSeconds, loop = true, nowMs = now() } = opts;
  let position = slotOffsetSeconds(nowMs);

  if (durationSeconds !== null && durationSeconds > 0) {
    position = loop
      ? mod(position, durationSeconds)
      : Math.min(position, Math.max(0, durationSeconds - 0.5));
  }
  return position;
}

/**
 * How long the file can play from `position` before it loops.
 * The gateway uses this to schedule a clean re-seek instead of waiting for a mid-frame EOF.
 */
export function secondsUntilLoop(
  positionSeconds: number,
  durationSeconds: number | null,
): number | null {
  if (durationSeconds === null || durationSeconds <= 0) return null;
  return Math.max(0, durationSeconds - positionSeconds);
}

/* ------------------------------------------------------------------ */
/* Time model                                                          */
/* ------------------------------------------------------------------ */

/**
 * The instant the source footage begins: 2026-06-13 21:00:00 IST.
 *
 * Established by reading the burned-in overlay clock at three known seek offsets on camera 10:
 *   offset      0 → 13/06/2026 20:59:59
 *   offset 10 800 → 14/06/2026 00:00:53
 *   offset 21 600 → 14/06/2026 03:01:50
 */
export const RECORDING_EPOCH_MS = Date.parse('2026-06-13T21:00:00+05:30');

/**
 * Measured drift between file position and the burned-in clock: roughly +0.5 %, i.e. the recorded
 * clock runs slightly ahead of elapsed file time (about +53 s at position 10 800, +110 s at
 * 21 600). Surveillance DVRs drop frames, so a file second is not always a wall-clock second.
 *
 * Consequence: the linear model below is good to about a minute over a 12-hour file, which is why
 * per-camera corrections live in the `time_sync` table rather than being assumed away. Note this
 * does NOT degrade cross-camera correlation — at any *given* position the cameras agree with each
 * other to ~14 s (measured across cameras 5, 10 and 11, 400 km apart), and correlation only ever
 * compares cameras at the same moment.
 */
export const MEASURED_POSITION_DRIFT_RATE = 0.005;

/** Correlation tolerance for two cameras with no measured clock offset between them. */
export const CORRELATION_TOLERANCE_MS = 15_000;

/**
 * `VIRTUAL_NOW_IST` — the single demo time-shift.
 *
 * The provided footage covers 21:00 → 09:00, so a demo during working hours plays deep-night video
 * in which number plates are unreadable. Setting this env var lets every component agree on a
 * different "now" and run the demo against the daylight window.
 *
 * It is deliberately one global switch rather than a per-component flag: if the map, the video wall
 * and the analytics pipeline could disagree about what time it is, the route reconstruction would
 * silently produce nonsense. When it is set the UI must show a "TIME-SHIFT (demo)" banner and
 * audit_log must record it — this exists for daylight demos, never to misrepresent live latency.
 */
export function virtualNowOffsetMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.VIRTUAL_NOW_IST?.trim();
  if (!raw) return 0;
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(
      `VIRTUAL_NOW_IST is not a parseable timestamp: ${raw}. ` +
        'Use an ISO-8601 instant such as 2026-08-21T07:15:00+05:30.',
    );
  }
  return parsed - Date.now();
}

/**
 * The project's clock. Every component must read time through this, never `Date.now()` directly,
 * so that a time-shifted demo stays internally consistent.
 */
export function now(env: NodeJS.ProcessEnv = process.env): number {
  return Date.now() + virtualNowOffsetMs(env);
}

export function isTimeShifted(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.VIRTUAL_NOW_IST?.trim());
}

/**
 * `recorded_at` — the forensic timestamp an operator sees and the only time used for cross-camera
 * correlation.
 *
 * recorded_at = recording epoch + position in file + this camera's measured clock offset
 *
 * Never derive this from raw container PTS: PTS restarts every time the file loops, so a route
 * built on it would silently run backwards.
 */
export function recordedAtMs(positionSeconds: number, clockOffsetSeconds = 0): number {
  return RECORDING_EPOCH_MS + (positionSeconds + clockOffsetSeconds) * 1000;
}

/**
 * `observed_at` — when we actually received the frame. Latency instrumentation only.
 * Never use it to order events across cameras; the cameras are replaying recorded footage.
 */
export function observedAtMs(env: NodeJS.ProcessEnv = process.env): number {
  return now(env);
}

/** Are two recorded timestamps close enough to be the same moment, given no measured offset? */
export function withinCorrelationTolerance(
  recordedAMs: number,
  recordedBMs: number,
  toleranceMs = CORRELATION_TOLERANCE_MS,
): boolean {
  return Math.abs(recordedAMs - recordedBMs) <= toleranceMs;
}

/** Human-readable slot description for the ops header, e.g. "slot 09:00–21:00 IST, 11h51m in". */
export function describeSlot(nowMs: number = now()): string {
  const offset = slotOffsetSeconds(nowMs);
  const startIsMorning = slotStartMs(nowMs);
  const startHourIst = new Date(startIsMorning).getUTCHours() * 3600
    + new Date(startIsMorning).getUTCMinutes() * 60;
  const istStart = mod(startHourIst + IST_OFFSET_SECONDS, 86400);
  const label = istStart === SLOT_ANCHOR_SECONDS ? '09:00–21:00' : '21:00–09:00';
  const h = Math.floor(offset / 3600);
  const m = Math.floor((offset % 3600) / 60);
  return `slot ${label} IST, ${h}h${String(m).padStart(2, '0')}m in`;
}
