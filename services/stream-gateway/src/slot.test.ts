import { describe, it, expect } from 'vitest';
import {
  SLOT_SECONDS,
  slotOffsetSeconds,
  slotStartMs,
  secondsUntilSlotRollover,
  playbackPositionSeconds,
  secondsUntilLoop,
  describeSlot,
} from './slot.js';

/**
 * Ground truth captured live from https://live.sentinelgujarat.in/api/cameras/1/state on
 * 2026-08-20. If our arithmetic reproduces this exact pair, we are aligned with the portal player.
 */
const OBSERVED = {
  serverEpoch: 1787239306.351337,
  slotOffset: 42706.351337,
  wallTimeIst: '2026-08-20T20:51:46.351337+05:30',
  slotSeconds: 43200.0,
};

describe('slot arithmetic — reproduces the portal exactly', () => {
  it('matches the observed slot_offset to sub-millisecond precision', () => {
    const ours = slotOffsetSeconds(OBSERVED.serverEpoch * 1000);
    expect(Math.abs(ours - OBSERVED.slotOffset)).toBeLessThan(0.001);
  });

  it('agrees with the portal on the slot length', () => {
    expect(SLOT_SECONDS).toBe(OBSERVED.slotSeconds);
  });

  it('places the slot boundary at 09:00 IST', () => {
    const start = slotStartMs(OBSERVED.serverEpoch * 1000);
    const ist = new Date(start).toLocaleString('en-GB', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
    expect(ist).toBe('09:00:00');
  });
});

describe('slot boundaries', () => {
  const at = (iso: string) => new Date(iso).getTime();

  it('is zero exactly at 09:00 IST', () => {
    expect(slotOffsetSeconds(at('2026-08-20T09:00:00+05:30'))).toBeCloseTo(0, 6);
  });

  it('is zero exactly at 21:00 IST', () => {
    expect(slotOffsetSeconds(at('2026-08-20T21:00:00+05:30'))).toBeCloseTo(0, 6);
  });

  it('is one hour at 10:00 IST', () => {
    expect(slotOffsetSeconds(at('2026-08-20T10:00:00+05:30'))).toBeCloseTo(3600, 6);
  });

  it('handles times before the first anchor of the day without going negative', () => {
    // 03:00 IST falls in the slot that began at 21:00 the previous evening — 6 hours in.
    const off = slotOffsetSeconds(at('2026-08-20T03:00:00+05:30'));
    expect(off).toBeGreaterThanOrEqual(0);
    expect(off).toBeCloseTo(6 * 3600, 6);
  });

  it('never returns a value outside [0, SLOT_SECONDS)', () => {
    for (let h = 0; h < 24; h++) {
      for (const m of [0, 17, 33, 59]) {
        const t = at(`2026-08-20T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+05:30`);
        const off = slotOffsetSeconds(t);
        expect(off).toBeGreaterThanOrEqual(0);
        expect(off).toBeLessThan(SLOT_SECONDS);
      }
    }
  });

  it('counts down to the next rollover', () => {
    const t = at('2026-08-20T20:00:00+05:30');
    expect(secondsUntilSlotRollover(t)).toBeCloseTo(3600, 6);
  });
});

describe('playbackPositionSeconds', () => {
  const t = OBSERVED.serverEpoch * 1000;

  it('wraps a looping file that is shorter than the slot', () => {
    // Camera 31 measured at ~43196.83 s — very slightly under the 12 h slot.
    const pos = playbackPositionSeconds({ durationSeconds: 43196.83, nowMs: t });
    expect(pos).toBeCloseTo(42706.351337, 3);
  });

  it('loops a short file many times within one slot', () => {
    const pos = playbackPositionSeconds({ durationSeconds: 600, nowMs: t });
    expect(pos).toBeCloseTo(42706.351337 % 600, 3);
    expect(pos).toBeLessThan(600);
  });

  it('clamps instead of wrapping when loop is disabled', () => {
    const pos = playbackPositionSeconds({ durationSeconds: 600, loop: false, nowMs: t });
    expect(pos).toBeCloseTo(599.5, 3);
  });

  it('falls back to the raw slot offset when duration is unknown', () => {
    expect(playbackPositionSeconds({ durationSeconds: null, nowMs: t }))
      .toBeCloseTo(42706.351337, 3);
  });

  it('never returns a position past the end of the file', () => {
    for (const duration of [30, 600, 3600, 43196.83, 49437.28]) {
      for (let hour = 0; hour < 24; hour++) {
        const now = new Date(`2026-08-20T${String(hour).padStart(2, '0')}:00:00+05:30`).getTime();
        const pos = playbackPositionSeconds({ durationSeconds: duration, nowMs: now });
        expect(pos).toBeGreaterThanOrEqual(0);
        expect(pos).toBeLessThan(duration);
      }
    }
  });

  it('handles a file longer than the slot by never wrapping inside it', () => {
    // Camera 20 measured at 49437.28 s (13.7 h) — longer than the 12 h slot, so it plays
    // linearly and the tail of the file is never reached.
    const pos = playbackPositionSeconds({ durationSeconds: 49437.28, nowMs: t });
    expect(pos).toBeCloseTo(42706.351337, 3);
  });
});

describe('secondsUntilLoop', () => {
  it('reports the remaining runway before a re-seek is needed', () => {
    expect(secondsUntilLoop(550, 600)).toBeCloseTo(50, 6);
  });

  it('is null when duration is unknown', () => {
    expect(secondsUntilLoop(550, null)).toBeNull();
  });

  it('never goes negative', () => {
    expect(secondsUntilLoop(700, 600)).toBe(0);
  });
});

describe('describeSlot', () => {
  it('labels the morning slot', () => {
    expect(describeSlot(new Date('2026-08-20T20:51:46+05:30').getTime()))
      .toBe('slot 09:00–21:00 IST, 11h51m in');
  });

  it('labels the evening slot', () => {
    expect(describeSlot(new Date('2026-08-20T22:30:00+05:30').getTime()))
      .toBe('slot 21:00–09:00 IST, 1h30m in');
  });
});
