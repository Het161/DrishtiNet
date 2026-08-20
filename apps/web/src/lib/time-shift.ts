import 'server-only';

import {
  describeSlot,
  isTimeShifted,
  now,
  playbackPositionSeconds,
  recordedAtMs,
  secondsUntilSlotRollover,
} from '@drishtinet/stream-gateway/slot';

/**
 * Everything the app shell needs to tell the operator what time it is *in the footage*.
 *
 * The provided feeds replay a recording of 13-14 June 2026, so "now" on screen is not the wall
 * clock. Showing only the wall clock would quietly misrepresent what the operator is watching.
 */
export interface TimeContext {
  timeShifted: boolean;
  slotLabel: string;
  /** What the footage is showing, in IST. */
  recordedAtIso: string;
  recordedLabel: string;
  hoursUntilRollover: number;
}

export function getTimeContext(): TimeContext {
  const t = now();
  const position = playbackPositionSeconds({ durationSeconds: 43200, nowMs: t });
  const recorded = new Date(recordedAtMs(position));
  return {
    timeShifted: isTimeShifted(),
    slotLabel: describeSlot(t),
    recordedAtIso: recorded.toISOString(),
    recordedLabel: recorded.toLocaleString('en-GB', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit', month: 'short',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    }),
    hoursUntilRollover: secondsUntilSlotRollover(t) / 3600,
  };
}
