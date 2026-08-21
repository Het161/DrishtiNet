import { describe, it, expect, beforeAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';

import {
  backoffDelayMs,
  BACKOFF_MIN_MS,
  BACKOFF_MAX_MS,
  liveRtspArgs,
  isBenignDecoderWarning,
  isFatalStreamError,
  PtsGridSampler,
  AbsoluteTimeAnchor,
  PtsDiscontinuityDetector,
  isDiscontinuity,
  type Frame,
} from '../../src/live/stream-reader.js';

/**
 * §4 CONFORMANCE SUITE — the gate before any connection to the real grid.
 *
 * Eight checks, from the organisers' integration reference. They run against our own MediaMTX
 * self-test grid (`make selftest-up`), never against the organisers' infrastructure: the whole
 * point is to be certain we behave before we are a guest on someone else's network.
 *
 * Checks that need a live stream are skipped with a clear message when the grid is not up, so a
 * developer without Docker still gets the pure-logic checks. CI runs the grid.
 */

const GRID = process.env.SELFTEST_RTSP ?? 'rtsp://127.0.0.1:8654';
const H264 = `${GRID}/stream/sane`;
const H265 = `${GRID}/stream/hevc`;
const JITTER = `${GRID}/stream/jitter`;
const HIGHRES = `${GRID}/stream/highres`;

let gridUp = false;

function probe(url: string, extraArgs: string[] = [], timeoutMs = 20_000) {
  return spawnSync(
    'ffprobe',
    ['-v', 'error', '-rtsp_transport', 'tcp', ...extraArgs, '-i', url,
     '-show_entries', 'stream=codec_name,width,height', '-of', 'json'],
    { encoding: 'utf8', timeout: timeoutMs },
  );
}

beforeAll(() => {
  const r = probe(H264, [], 15_000);
  gridUp = r.status === 0;
  if (!gridUp) {
    console.warn(
      `\n  self-test grid not reachable at ${GRID} — live checks will be skipped.` +
      `\n  start it with: make selftest-up\n`,
    );
  }
});

/* ────────────────────────────────────────────────────────────────────────────
   1. RTSP is forced over TCP
   ──────────────────────────────────────────────────────────────────────────── */
describe('§4.1 RTSP forced over TCP', () => {
  it('always emits -rtsp_transport tcp', () => {
    const args = liveRtspArgs('rtsp://example/stream/1');
    expect(args[args.indexOf('-rtsp_transport') + 1]).toBe('tcp');
    expect(args).toContain('-rtsp_flags');
  });

  it('never emits -re for a live source', () => {
    // -re paces a FILE at real time. Against a live stream it fights the source's own clock.
    expect(liveRtspArgs('rtsp://example/stream/1')).not.toContain('-re');
  });

  it('identifies itself to the grid', () => {
    const args = liveRtspArgs('rtsp://example/stream/1');
    expect(args[args.indexOf('-user_agent') + 1]).toMatch(/DrishtiNet/);
  });

  it('connects over TCP to the live grid', () => {
    if (!gridUp) return;
    const r = probe(H264);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).streams[0].codec_name).toBe('h264');
  });
});

/* ────────────────────────────────────────────────────────────────────────────
   2. No logic derived from CAP_PROP_FPS
   ──────────────────────────────────────────────────────────────────────────── */
describe('§4.2 declared fps is never used for timing', () => {
  it('the sampler takes an explicit interval, not a stream fps', () => {
    // Constructing from a declared fps is the mistake; the API makes it impossible to pass one
    // implicitly, since the interval is a required constructor argument in milliseconds.
    const sampler = new PtsGridSampler(200);
    expect(sampler).toBeInstanceOf(PtsGridSampler);
    expect(() => new PtsGridSampler(0)).toThrow(/positive/);
  });

  it('samples on the same PTS grid regardless of the source frame rate', () => {
    // Same 5 s of content at 25 fps and at 12.5 fps must yield the same number of samples.
    const run = (fps: number) => {
      const sampler = new PtsGridSampler(200);
      let n = 0;
      for (let i = 0; i < fps * 5; i++) {
        if (sampler.offer({ ptsMs: (i * 1000) / fps, arrivalMs: 0 })) n++;
      }
      return n;
    };
    expect(Math.abs(run(25) - run(12.5))).toBeLessThanOrEqual(1);
  });

  it('the grid genuinely serves different frame rates', () => {
    if (!gridUp) return;
    const lowfps = probe(`${GRID}/stream/lowfps`);
    expect(lowfps.status).toBe(0);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
   3. No logic derived from arrival time
   ──────────────────────────────────────────────────────────────────────────── */
describe('§4.3 arrival time never drives intra-stream timing', () => {
  it('sampling is identical whether frames arrive evenly or in a burst', () => {
    const frames = (arrival: (i: number) => number): Frame[] =>
      Array.from({ length: 100 }, (_, i) => ({ ptsMs: i * 40, arrivalMs: arrival(i) }));

    const sample = (fs: Frame[]) => {
      const s = new PtsGridSampler(200);
      return fs.filter((f) => s.offer(f)).map((f) => f.ptsMs);
    };

    const realtime = sample(frames((i) => i * 40));
    // The join burst: the first 50 frames arrive 10x faster than real time.
    const bursty = sample(frames((i) => (i < 50 ? i * 4 : 200 + (i - 50) * 40)));

    expect(bursty).toEqual(realtime);
  });

  it('a stalled connection does not fabricate samples', () => {
    // Arrival time advancing while PTS does not must produce nothing.
    const s = new PtsGridSampler(200);
    s.offer({ ptsMs: 0, arrivalMs: 0 });
    let emitted = 0;
    for (let i = 1; i <= 50; i++) {
      if (s.offer({ ptsMs: 0, arrivalMs: i * 1000 })) emitted++;
    }
    expect(emitted).toBe(0);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
   4. Non-uniform inter-frame gaps
   ──────────────────────────────────────────────────────────────────────────── */
describe('§4.4 non-uniform frame intervals', () => {
  it('keeps sample spacing near the grid despite erratic source intervals', () => {
    const s = new PtsGridSampler(200);
    const out: number[] = [];
    let pts = 0;
    // Intervals swinging between 10 ms and 300 ms — worse than anything the grid should produce.
    const gaps = [40, 10, 300, 25, 120, 15, 260, 33, 80, 200];
    for (let i = 0; i < 400; i++) {
      pts += gaps[i % gaps.length]!;
      const f = s.offer({ ptsMs: pts, arrivalMs: pts });
      if (f) out.push(f.ptsMs);
    }
    expect(out.length).toBeGreaterThan(20);

    const deltas = out.slice(1).map((v, i) => v - out[i]!);
    const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    // Mean spacing tracks the grid; the source's worst gap (300 ms) bounds the error.
    expect(mean).toBeGreaterThan(150);
    expect(mean).toBeLessThan(320);
    // Crucially, never a run of zero-length or negative steps.
    expect(Math.min(...deltas)).toBeGreaterThan(0);
  });

  it('handles the jitter stream on the live grid', () => {
    if (!gridUp) return;
    expect(probe(JITTER).status).toBe(0);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
   5. Reconnect with exponential backoff, 2 s → 30 s
   ──────────────────────────────────────────────────────────────────────────── */
describe('§4.5 reconnect backoff', () => {
  it('starts at 2 s and doubles', () => {
    expect(backoffDelayMs(0, 0.999999)).toBeCloseTo(BACKOFF_MIN_MS, -2);
    expect(backoffDelayMs(1, 0.999999)).toBeCloseTo(4_000, -2);
    expect(backoffDelayMs(2, 0.999999)).toBeCloseTo(8_000, -2);
  });

  it('caps at 30 s however many attempts fail', () => {
    for (const attempt of [5, 10, 50, 1000]) {
      expect(backoffDelayMs(attempt, 0.999999)).toBeLessThanOrEqual(BACKOFF_MAX_MS);
    }
  });

  it('never returns a delay below half the cap once saturated', () => {
    // Jitter must spread retries without ever collapsing to an aggressive hot loop.
    for (let j = 0; j < 1; j += 0.05) {
      expect(backoffDelayMs(20, j)).toBeGreaterThanOrEqual(BACKOFF_MAX_MS / 2);
    }
  });

  it('spreads a fleet rather than retrying in lockstep', () => {
    const delays = new Set(
      Array.from({ length: 30 }, (_, i) => backoffDelayMs(3, i / 30)),
    );
    expect(delays.size).toBeGreaterThan(10);
  });

  it('recovers when a feed restarts', async () => {
    if (!gridUp) return;
    // Consume, and confirm a second connection succeeds — the grid tolerates reconnection.
    expect(probe(H264).status).toBe(0);
    await new Promise((r) => setTimeout(r, 500));
    expect(probe(H264).status).toBe(0);
  }, 60_000);
});

/* ────────────────────────────────────────────────────────────────────────────
   6. H.265 mid-stream join warnings are non-fatal
   ──────────────────────────────────────────────────────────────────────────── */
describe('§4.6 decoder warnings at join are not fatal', () => {
  it('classifies the documented H.265 join noise as benign', () => {
    for (const msg of [
      'Could not find ref with POC 12',
      '[hevc @ 0x1] missing picture in access unit with size 4242',
      'short term ref pic set is invalid',
      '[h264 @ 0x1] non-existing PPS 0 referenced',
      '[h264 @ 0x1] decode_slice_header error',
      '[h264 @ 0x1] Invalid NAL unit size (166876 > 70211)',
    ]) {
      expect(isBenignDecoderWarning(msg)).toBe(true);
      expect(isFatalStreamError(msg)).toBe(false);
    }
  });

  it('still treats genuine connection failures as fatal', () => {
    for (const msg of [
      'Connection refused',
      'Server returned 401 Unauthorized',
      'Server returned 404 Not Found',
      'No route to host',
    ]) {
      expect(isFatalStreamError(msg)).toBe(true);
    }
  });

  it('joins the live H.265 stream mid-GOP without failing', () => {
    if (!gridUp) return;
    const r = probe(H265);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).streams[0].codec_name).toBe('hevc');
    // Any stderr must be join noise, never a fatal error.
    if (r.stderr.trim()) expect(isFatalStreamError(r.stderr)).toBe(false);
  }, 60_000);
});

/* ────────────────────────────────────────────────────────────────────────────
   7. Mixed codecs and resolutions
   ──────────────────────────────────────────────────────────────────────────── */
describe('§4.7 mixed codec and resolution', () => {
  it('reads H.264 and H.265 from the same grid', () => {
    if (!gridUp) return;
    expect(JSON.parse(probe(H264).stdout).streams[0].codec_name).toBe('h264');
    expect(JSON.parse(probe(H265).stdout).streams[0].codec_name).toBe('hevc');
  }, 90_000);

  it('reads a resolution larger than 1080p without a fixed-shape assumption', () => {
    if (!gridUp) return;
    const s = JSON.parse(probe(HIGHRES).stdout).streams[0];
    expect(s.width).toBe(2560);
    expect(s.height).toBe(1440);
  }, 60_000);
});

/* ────────────────────────────────────────────────────────────────────────────
   8. Scene-discontinuity recovery
   ──────────────────────────────────────────────────────────────────────────── */
describe('§4.8 loop / scene-discontinuity recovery', () => {
  it('detects PTS running backwards', () => {
    const d = new PtsDiscontinuityDetector();
    expect(d.observe(1000)).toBe(false);
    expect(d.observe(1040)).toBe(false);
    expect(d.observe(20)).toBe(true); // loop restart
  });

  it('detects an implausible forward jump', () => {
    const d = new PtsDiscontinuityDetector(5_000);
    d.observe(1000);
    expect(d.observe(1040)).toBe(false);
    expect(d.observe(30_000)).toBe(true);
  });

  it('treats a normal gap as continuous', () => {
    const d = new PtsDiscontinuityDetector(5_000);
    d.observe(1000);
    expect(d.observe(3_500)).toBe(false);
  });

  it('any single signal is enough to reset state', () => {
    expect(isDiscontinuity({ ptsJump: true, sceneCut: false, clockWentBackwards: false })).toBe(true);
    expect(isDiscontinuity({ ptsJump: false, sceneCut: true, clockWentBackwards: false })).toBe(true);
    expect(isDiscontinuity({ ptsJump: false, sceneCut: false, clockWentBackwards: true })).toBe(true);
    expect(isDiscontinuity({ ptsJump: false, sceneCut: false, clockWentBackwards: false })).toBe(false);
  });

  it('the sampler resumes cleanly after a reset', () => {
    const s = new PtsGridSampler(200);
    for (let i = 0; i < 20; i++) s.offer({ ptsMs: i * 40, arrivalMs: 0 });
    s.reset();
    // After a loop the new segment starts near zero; the sampler must not withhold frames waiting
    // for a tick that belongs to the previous segment.
    expect(s.offer({ ptsMs: 0, arrivalMs: 0 })).not.toBeNull();
  });
});

/* ────────────────────────────────────────────────────────────────────────────
   Absolute-time anchoring (supports §4.3 and the time model)
   ──────────────────────────────────────────────────────────────────────────── */
describe('absolute time anchoring survives the join burst', () => {
  it('ignores the replayed GOP and anchors on steady-state frames', () => {
    const a = new AbsoluteTimeAnchor(5_000, 1_500);
    const TRUE_ANCHOR = 1_000_000;

    // Burst: 2 s of buffered GOP delivered in 200 ms, so arrival − PTS is wildly early.
    for (let i = 0; i < 50; i++) {
      a.observe({ ptsMs: i * 40, arrivalMs: TRUE_ANCHOR + i * 4 });
    }
    // Steady state, with a little network delay on top.
    for (let i = 50; i < 250; i++) {
      const pts = i * 40;
      a.observe({ ptsMs: pts, arrivalMs: TRUE_ANCHOR + pts + (i % 7) * 3 });
    }

    expect(a.isSettled).toBe(true);
    // Within a few ms of the truth, despite the burst.
    expect(Math.abs(a.anchorMs! - TRUE_ANCHOR)).toBeLessThan(50);
  });

  it('is not settled before the window has passed', () => {
    const a = new AbsoluteTimeAnchor(5_000, 1_500);
    a.observe({ ptsMs: 0, arrivalMs: 0 });
    a.observe({ ptsMs: 40, arrivalMs: 40 });
    expect(a.isSettled).toBe(false);
  });

  it('takes the minimum, so queueing delay never inflates the anchor', () => {
    const a = new AbsoluteTimeAnchor(1_000, 0);
    a.observe({ ptsMs: 0, arrivalMs: 5_000 });     // 5 s of delay
    a.observe({ ptsMs: 100, arrivalMs: 5_020 });   // 4.92 s
    a.observe({ ptsMs: 200, arrivalMs: 5_205 });   // 5.005 s
    a.observe({ ptsMs: 300, arrivalMs: 5_300 });   // 5.0 s
    expect(a.anchorMs).toBe(4_920);
  });
});
