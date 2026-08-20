import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  FfmpegPublisher,
  shouldReseek,
  actualPosition,
  circularDrift,
  DEFAULTS,
  type PublisherConfig,
  type SpawnedProcess,
} from './publisher.js';
import type { CameraSource } from './adapters/types.js';

/**
 * A stand-in for a spawned ffmpeg. Nothing here starts a process or touches the network — the
 * point of these tests is that the politeness rules hold without ever contacting the portal.
 */
class FakeProcess implements SpawnedProcess {
  killed = false;
  killSignal: string | null = null;
  private exitCb: ((code: number | null) => void) | null = null;
  private dataCb: ((chunk: string) => void) | null = null;

  stderr = {
    setEncoding: () => {},
    on: (_event: 'data', cb: (chunk: string) => void) => {
      this.dataCb = cb;
    },
  };

  on(event: 'error' | 'exit', cb: never): void {
    if (event === 'exit') this.exitCb = cb as unknown as (code: number | null) => void;
  }

  kill(signal?: NodeJS.Signals): void {
    this.killed = true;
    this.killSignal = signal ?? 'SIGTERM';
    // Real ffmpeg exits asynchronously after SIGTERM.
    queueMicrotask(() => this.exitCb?.(255));
  }

  emitProgress(line = 'frame= 120 fps= 25.0 speed=1.0x'): void {
    this.dataCb?.(line);
  }

  exit(code: number | null): void {
    this.exitCb?.(code);
  }
}

const CAMERA: CameraSource = {
  id: '10',
  name: 'Char Chowk Road',
  sourceType: 'MP4_PROGRESSIVE',
  sourceUrl: '/stream/10',
  durationSeconds: 43200,
  codec: 'h264',
  container: 'mp4',
};

function makePublisher(overrides: Partial<PublisherConfig> = {}) {
  const spawned: FakeProcess[] = [];
  const clock = { now: Date.parse('2026-08-21T10:00:00+05:30') };
  const publisher = new FfmpegPublisher({
    upstreamBase: 'https://live.example.invalid',
    rtspHost: 'mediamtx',
    rtspPort: 8554,
    now: () => clock.now,
    spawn: () => {
      const p = new FakeProcess();
      spawned.push(p);
      return p;
    },
    ...overrides,
  });
  return { publisher, spawned, clock };
}

describe('shouldReseek', () => {
  it('ignores drift within tolerance', () => {
    expect(shouldReseek(1.5, 2)).toBe(false);
    expect(shouldReseek(-1.9, 2)).toBe(false);
  });

  it('triggers past tolerance in either direction', () => {
    expect(shouldReseek(2.5, 2)).toBe(true);
    expect(shouldReseek(-9, 2)).toBe(true);
  });

  it('never acts on a non-finite measurement', () => {
    // Re-seeking on NaN would thrash a struggling upstream for no reason.
    expect(shouldReseek(Number.NaN, 2)).toBe(false);
    expect(shouldReseek(Infinity, 2)).toBe(false);
  });
});

describe('circularDrift', () => {
  const PERIOD = 600;

  it('is a plain difference away from the boundary', () => {
    expect(circularDrift(300, 297, PERIOD)).toBeCloseTo(3, 6);
    expect(circularDrift(297, 300, PERIOD)).toBeCloseTo(-3, 6);
  });

  it('takes the short way round when the two straddle a loop boundary', () => {
    // 1s past the wrap vs 1s before it is 2s apart, not 598s. Without this the publisher would
    // re-seek on every single loop of the file.
    expect(circularDrift(1, 599, PERIOD)).toBeCloseTo(2, 6);
    expect(circularDrift(599, 1, PERIOD)).toBeCloseTo(-2, 6);
  });

  it('keeps a genuinely large drift large', () => {
    expect(Math.abs(circularDrift(0, 250, PERIOD))).toBeCloseTo(250, 6);
  });

  it('is a plain difference for a non-looping source', () => {
    expect(circularDrift(10, 4, null)).toBeCloseTo(6, 6);
  });

  it('never reports a drift larger than half the period', () => {
    for (let a = 0; a < PERIOD; a += 37) {
      for (let e = 0; e < PERIOD; e += 53) {
        expect(Math.abs(circularDrift(a, e, PERIOD))).toBeLessThanOrEqual(PERIOD / 2 + 1e-9);
      }
    }
  });
});

describe('actualPosition', () => {
  const start = 1_000_000;

  it('advances at real time from the seek point', () => {
    expect(actualPosition(100, start, start + 30_000, 43200)).toBeCloseTo(130, 6);
  });

  it('wraps at the end of a looping file', () => {
    expect(actualPosition(43_190, start, start + 20_000, 43200)).toBeCloseTo(10, 6);
  });

  it('does not go backwards if the clock jitters', () => {
    expect(actualPosition(100, start, start - 5_000, 43200)).toBeCloseTo(100, 6);
  });
});

describe('lazy start and idle stop', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('publishes nothing until something subscribes', () => {
    const { publisher, spawned } = makePublisher();
    expect(spawned).toHaveLength(0);
    expect(publisher.isPublishing('10')).toBe(false);
    expect(publisher.state('10').status).toBe('unknown');
  });

  it('starts exactly one upstream on the first subscriber', async () => {
    const { publisher, spawned } = makePublisher();
    await publisher.acquire(CAMERA);
    await vi.advanceTimersByTimeAsync(1);
    expect(spawned).toHaveLength(1);
    expect(publisher.isPublishing('10')).toBe(true);
  });

  it('does not open a second connection for additional subscribers', async () => {
    const { publisher, spawned } = makePublisher();
    await publisher.acquire(CAMERA);
    await publisher.acquire(CAMERA);
    await publisher.acquire(CAMERA);
    await vi.advanceTimersByTimeAsync(1);
    expect(spawned).toHaveLength(1);
    expect(publisher.subscriberCount('10')).toBe(3);
  });

  it('keeps publishing while any subscriber remains', async () => {
    const { publisher } = makePublisher();
    await publisher.acquire(CAMERA);
    await publisher.acquire(CAMERA);
    await vi.advanceTimersByTimeAsync(1);

    publisher.release('10');
    await vi.advanceTimersByTimeAsync(DEFAULTS.idleTimeoutMs * 2);
    expect(publisher.isPublishing('10')).toBe(true);
  });

  it('stops the upstream after the idle timeout once the last subscriber leaves', async () => {
    const { publisher } = makePublisher();
    await publisher.acquire(CAMERA);
    await vi.advanceTimersByTimeAsync(1);

    publisher.release('10');
    expect(publisher.isPublishing('10')).toBe(true); // still within the grace period

    await vi.advanceTimersByTimeAsync(DEFAULTS.idleTimeoutMs + 100);
    expect(publisher.isPublishing('10')).toBe(false);
    expect(publisher.subscriberCount('10')).toBe(0);
  });

  it('cancels the idle stop if a subscriber returns in time', async () => {
    const { publisher, spawned } = makePublisher();
    await publisher.acquire(CAMERA);
    await vi.advanceTimersByTimeAsync(1);

    publisher.release('10');
    await vi.advanceTimersByTimeAsync(DEFAULTS.idleTimeoutMs / 2);
    await publisher.acquire(CAMERA);
    await vi.advanceTimersByTimeAsync(DEFAULTS.idleTimeoutMs + 100);

    expect(publisher.isPublishing('10')).toBe(true);
    // Crucially it never restarted — the same process kept running.
    expect(spawned).toHaveLength(1);
  });

  it('ignores an unbalanced release rather than going negative', () => {
    const { publisher } = makePublisher();
    publisher.release('10');
    publisher.release('10');
    expect(publisher.subscriberCount('10')).toBe(0);
  });
});

describe('pacing drift correction', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('leaves a well-paced stream alone', async () => {
    const { publisher, spawned, clock } = makePublisher();
    await publisher.acquire(CAMERA);
    await vi.advanceTimersByTimeAsync(1);

    // Advance wall clock and the stream together: no drift.
    clock.now += 30_000;
    publisher.checkDrift();

    expect(Math.abs(publisher.state('10').driftSeconds ?? 99)).toBeLessThan(0.01);
    expect(spawned[0]!.killed).toBe(false);
    expect(publisher.state('10').reseeks).toBe(0);
  });

  it('re-seeks when ffmpeg pacing has slipped past tolerance', async () => {
    // A publisher whose stream is "ahead": we simulate slip by starting it in the past.
    const { publisher, spawned, clock } = makePublisher({ maxDriftSeconds: 2 });
    await publisher.acquire(CAMERA);
    await vi.advanceTimersByTimeAsync(1);

    // Pretend the process began 10s ago in stream terms but the wall clock barely moved:
    // actual position runs ahead of the expected slot position.
    const s = publisher.state('10');
    expect(s.seekedTo).not.toBeNull();
    clock.now += 10_000;
    // Expected advances 10s too, so force divergence by rewinding only the expectation:
    // easiest honest simulation is to move the clock back after the process recorded startedAt.
    clock.now -= 20_000;

    publisher.checkDrift();
    const after = publisher.state('10');
    expect(Math.abs(after.driftSeconds ?? 0)).toBeGreaterThan(2);
    expect(after.reseeks).toBe(1);
    expect(spawned[0]!.killed).toBe(true);
  });

  it('does not run a drift monitor when nothing is publishing', async () => {
    const { publisher } = makePublisher();
    await publisher.acquire(CAMERA);
    await vi.advanceTimersByTimeAsync(1);
    await publisher.stop('10');
    // No throw and no state change from a stray check.
    expect(() => publisher.checkDrift()).not.toThrow();
    expect(publisher.isPublishing('10')).toBe(false);
  });
});

describe('ffmpeg arguments', () => {
  it('stream-copies H.264 and seeks to the requested position', () => {
    const { publisher } = makePublisher();
    const args = publisher.buildArgs(CAMERA, 36000);
    expect(args).toContain('-c:v');
    expect(args[args.indexOf('-c:v') + 1]).toBe('copy');
    expect(args[args.indexOf('-ss') + 1]).toBe('36000.000');
    expect(args).toContain('-re');
    expect(args.at(-1)).toBe('rtsp://mediamtx:8554/cam/10');
  });

  it('transcodes a source MediaMTX cannot carry as-is', () => {
    const { publisher } = makePublisher();
    const avi: CameraSource = { ...CAMERA, id: '23', codec: 'avi', container: 'avi' };
    const args = publisher.buildArgs(avi, 0);
    expect(args[args.indexOf('-c:v') + 1]).toBe('libx264');
  });

  it('identifies itself to the portal', () => {
    const { publisher } = makePublisher();
    const args = publisher.buildArgs(CAMERA, 0);
    const ua = args[args.indexOf('-user_agent') + 1] ?? '';
    expect(ua).toMatch(/DrishtiNet/);
    expect(ua).toMatch(/hetpatelsk@gmail\.com/);
  });
});

describe('health reporting', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reports online once frames are flowing', async () => {
    const { publisher, spawned } = makePublisher();
    await publisher.acquire(CAMERA);
    await vi.advanceTimersByTimeAsync(1);

    spawned[0]!.emitProgress();
    const s = publisher.state('10');
    expect(s.status).toBe('online');
    expect(s.fps).toBeCloseTo(25, 1);
    expect(s.lastFrameAt).not.toBeNull();
  });
});
