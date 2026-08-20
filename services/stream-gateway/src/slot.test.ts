import { describe, it, expect } from 'vitest';
import {
  SLOT_SECONDS,
  slotOffsetSeconds,
  slotStartMs,
  secondsUntilSlotRollover,
  playbackPositionSeconds,
  secondsUntilLoop,
  describeSlot,
  RECORDING_EPOCH_MS,
  MEASURED_POSITION_DRIFT_RATE,
  recordedAtMs,
  withinCorrelationTolerance,
  virtualNowOffsetMs,
  isTimeShifted,
  now,
  fitDriftModel,
  slotTimeMs,
  GLOBAL_DRIFT_RATE,
  MIN_ANCHOR_SPAN_SECONDS,
  type TimeSyncAnchor,
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

describe('time model — recorded_at', () => {
  it('anchors the recording epoch at 2026-06-13 21:00 IST', () => {
    const ist = new Date(RECORDING_EPOCH_MS).toLocaleString('en-GB', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
    expect(ist).toBe('13/06/2026, 21:00:00');
  });

  it.each([
    // position, burned-in clock observed on camera 10 during Phase 0
    [0, '13/06/2026, 21:00:00'],
    [10800, '14/06/2026, 00:00:00'],
    [21600, '14/06/2026, 03:00:00'],
    [36000, '14/06/2026, 07:00:00'],
  ])('maps position %i s to recorded time %s', (position, expected) => {
    const ist = new Date(recordedAtMs(position)).toLocaleString('en-GB', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
    expect(ist).toBe(expected);
  });

  it('applies a per-camera clock offset from time_sync', () => {
    const base = recordedAtMs(1305);
    const corrected = recordedAtMs(1305, 9); // camera 10 measured ~+9 s at this position
    expect(corrected - base).toBe(9000);
  });

  it('stays within the measured drift of the observed burned-in clocks', () => {
    // Observed: position 10800 → 00:00:53, position 21600 → 03:01:50.
    const cases: [number, string][] = [[10800, '2026-06-14T00:00:53+05:30'],
                                       [21600, '2026-06-14T03:01:50+05:30']];
    for (const [position, observedIso] of cases) {
      const drift = Math.abs(Date.parse(observedIso) - recordedAtMs(position)) / 1000;
      expect(drift).toBeLessThan(position * MEASURED_POSITION_DRIFT_RATE + 5);
    }
  });
});

describe('withinCorrelationTolerance', () => {
  it('treats readings 14 s apart as the same moment — the measured cross-camera spread', () => {
    const t = recordedAtMs(1305);
    expect(withinCorrelationTolerance(t, t + 14_000)).toBe(true);
  });

  it('rejects readings beyond the tolerance', () => {
    const t = recordedAtMs(1305);
    expect(withinCorrelationTolerance(t, t + 20_000)).toBe(false);
  });
});

describe('VIRTUAL_NOW_IST', () => {
  it('is inert by default', () => {
    expect(virtualNowOffsetMs({})).toBe(0);
    expect(isTimeShifted({})).toBe(false);
  });

  it('shifts the clock to the configured instant', () => {
    const target = '2026-08-21T07:15:00+05:30';
    const env = { VIRTUAL_NOW_IST: target } as NodeJS.ProcessEnv;
    expect(isTimeShifted(env)).toBe(true);
    expect(Math.abs(now(env) - Date.parse(target))).toBeLessThan(1000);
  });

  it('lands the shifted clock in the daylight window it exists for', () => {
    // 07:15 IST is in the evening slot, so position ≈ 36900 → recorded ≈ 07:15. Daylight.
    const env = { VIRTUAL_NOW_IST: '2026-08-21T07:15:00+05:30' } as NodeJS.ProcessEnv;
    const position = playbackPositionSeconds({ durationSeconds: 43200, nowMs: now(env) });
    const recordedHour = new Date(recordedAtMs(position)).toLocaleString('en-GB', {
      timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false,
    });
    expect(Number(recordedHour)).toBeGreaterThanOrEqual(6);
    expect(Number(recordedHour)).toBeLessThan(9);
  });

  it('refuses an unparseable value rather than silently ignoring it', () => {
    expect(() => virtualNowOffsetMs({ VIRTUAL_NOW_IST: 'tomorrow morning' } as NodeJS.ProcessEnv))
      .toThrow(/not a parseable timestamp/);
  });
});

describe('per-camera drift model', () => {
  /** Camera 10's three real burned-in readings from Phase 0. */
  const CAM10: TimeSyncAnchor[] = [
    { positionSeconds: 0, observedOffsetSeconds: -1 },
    { positionSeconds: 10800, observedOffsetSeconds: 53 },
    { positionSeconds: 21600, observedOffsetSeconds: 110 },
  ];

  it('fits camera 10 to its measured ~0.51% drift', () => {
    const m = fitDriftModel(CAM10);
    expect(m.source).toBe('fitted');
    expect(m.driftRate).toBeCloseTo(0.005139, 5);
    expect(m.maxResidualSeconds!).toBeLessThan(2);
  });

  it('reproduces the observed clock readings within the +/-5s target', () => {
    const m = fitDriftModel(CAM10);
    const observed: [number, string][] = [
      [0, '2026-06-13T20:59:59+05:30'],
      [10800, '2026-06-14T00:00:53+05:30'],
      [21600, '2026-06-14T03:01:50+05:30'],
    ];
    for (const [position, iso] of observed) {
      const error = Math.abs(Date.parse(iso) - recordedAtMs(position, m)) / 1000;
      expect(error).toBeLessThan(5);
    }
  });

  it('refuses to fit a slope from anchors that do not span far enough', () => {
    // Two readings inside one 45-minute clip: a +/-1s misreading would become ~32s by slot end.
    const narrow: TimeSyncAnchor[] = [
      { positionSeconds: 36000, observedOffsetSeconds: 185 },
      { positionSeconds: 38700, observedOffsetSeconds: 199 },
    ];
    const m = fitDriftModel(narrow);
    expect(m.source).toBe('global_default');
    expect(m.driftRate).toBe(GLOBAL_DRIFT_RATE);
    expect(m.spanSeconds).toBe(2700);
  });

  it('accepts a pair that straddles the slot', () => {
    const wide: TimeSyncAnchor[] = [
      { positionSeconds: 3600, observedOffsetSeconds: 17.5 },
      { positionSeconds: 36000, observedOffsetSeconds: 183.5 },
    ];
    const m = fitDriftModel(wide);
    expect(m.source).toBe('fitted');
    expect(m.spanSeconds).toBeGreaterThanOrEqual(MIN_ANCHOR_SPAN_SECONDS);
    expect(m.driftRate).toBeCloseTo(0.005123, 4);
  });

  it('shows why the span rule exists: a 1s misreading over a short span explodes by slot end', () => {
    const truth = (p: number) => -1.5 + 0.005139 * p;
    const misread = (anchors: TimeSyncAnchor[]) =>
      anchors.map((a, i) => ({ ...a, observedOffsetSeconds: a.observedOffsetSeconds + (i ? 1 : -1) }));

    const narrowSpan = [3600, 6300].map((p) => ({ positionSeconds: p, observedOffsetSeconds: truth(p) }));
    const wideSpan = [3600, 36000].map((p) => ({ positionSeconds: p, observedOffsetSeconds: truth(p) }));

    // Force a raw fit on the narrow pair to show what the guard is protecting against.
    const rawNarrow = (() => {
      const a = misread(narrowSpan);
      const b = (a[1]!.observedOffsetSeconds - a[0]!.observedOffsetSeconds)
        / (a[1]!.positionSeconds - a[0]!.positionSeconds);
      const c = a[0]!.observedOffsetSeconds - b * a[0]!.positionSeconds;
      return c + b * 43200;
    })();

    const wideModel = fitDriftModel(misread(wideSpan));
    const wideErr = Math.abs(
      (wideModel.offsetSeconds + wideModel.driftRate * 43200) - truth(43200),
    );

    expect(Math.abs(rawNarrow - truth(43200))).toBeGreaterThan(15);
    expect(wideErr).toBeLessThan(5);
  });

  it('falls back to a borrowed rate for a single anchor, and says so', () => {
    const m = fitDriftModel([{ positionSeconds: 1305, observedOffsetSeconds: 9 }]);
    expect(m.source).toBe('single_anchor');
    expect(m.driftRate).toBe(GLOBAL_DRIFT_RATE);
    // The constant term is chosen so the model passes exactly through the one reading we have.
    expect(recordedAtMs(1305, m)).toBeCloseTo(recordedAtMs(1305, 9), -1);
  });

  it('reports no model at all rather than pretending zero drift is measured', () => {
    const m = fitDriftModel([]);
    expect(m.source).toBe('none');
    expect(m.anchorCount).toBe(0);
  });
});

describe('slotTimeMs', () => {
  it('is the portal linear clock, uncorrected', () => {
    expect(slotTimeMs(0)).toBe(RECORDING_EPOCH_MS);
    expect(slotTimeMs(36000)).toBe(RECORDING_EPOCH_MS + 36_000_000);
  });

  it('differs from recorded_at by exactly the drift correction', () => {
    const m = fitDriftModel([
      { positionSeconds: 0, observedOffsetSeconds: -1 },
      { positionSeconds: 21600, observedOffsetSeconds: 110 },
    ]);
    const p = 36000;
    const delta = (recordedAtMs(p, m) - slotTimeMs(p)) / 1000;
    expect(delta).toBeCloseTo(m.offsetSeconds + m.driftRate * p, 6);
  });
});
