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
export function slotOffsetSeconds(nowMs: number = Date.now()): number {
  const epochSec = nowMs / 1000;
  return mod(epochSec + IST_OFFSET_SECONDS - SLOT_ANCHOR_SECONDS, SLOT_SECONDS);
}

/** Unix epoch (ms) of the slot boundary currently in effect. */
export function slotStartMs(nowMs: number = Date.now()): number {
  return nowMs - slotOffsetSeconds(nowMs) * 1000;
}

/** Seconds remaining before every feed jumps. Use it to warn before a demo crosses a boundary. */
export function secondsUntilSlotRollover(nowMs: number = Date.now()): number {
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
  const { durationSeconds, loop = true, nowMs = Date.now() } = opts;
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

/**
 * The wall-clock IST instant a given playback position corresponds to.
 *
 * This is the timestamp we attach to detections. Note the deliberate choice: we stamp events with
 * RECEIVE time in IST, and keep the file position separately for debugging. Container PTS restarts
 * on every loop, so using it as an event time would produce a route reconstruction that silently
 * runs backwards.
 */
export function positionToWallClockMs(nowMs: number = Date.now()): number {
  return nowMs;
}

/** Human-readable slot description for the ops header, e.g. "slot 09:00–21:00 IST, 11h51m in". */
export function describeSlot(nowMs: number = Date.now()): string {
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
