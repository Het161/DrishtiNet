/**
 * Live stream reading: the rules the organisers' integration reference imposes, in one place.
 *
 * These are pure functions and small stateful helpers with no I/O, so the conformance suite can
 * prove each rule holds without a network. The rules are not stylistic — each one corresponds to a
 * documented property of the grid that breaks naive stream handling:
 *
 *   §  RTSP must be forced over TCP.
 *   §  Reconnect with exponential backoff, 2 s → 30 s cap.
 *   §  Decoder warnings at join (H.265 RPS/POC) are normal until the first IDR. Log, never fatal.
 *   §  Frame intervals are not uniform, and CAP_PROP_FPS cannot be trusted.
 *   §  All intra-stream timing comes from PTS, never arrival time.
 *   §  The gateway replays a buffered GOP on connect, so the first 1–2 s arrive faster than real
 *      time. Absolute time may only be anchored after that burst.
 *   §  Every feed loops with a hard scene cut; long-lived state must recover from it.
 */

/* ── reconnect ─────────────────────────────────────────────────────────────── */

export const BACKOFF_MIN_MS = 2_000;
export const BACKOFF_MAX_MS = 30_000;

/**
 * Delay before reconnect attempt `attempt` (0-based), doubling from 2 s and capped at 30 s.
 *
 * `jitter` in [0,1) spreads a fleet of reconnecting cameras so they do not retry in lockstep after
 * a shared outage — thirty cameras hitting the grid on the same millisecond is a thundering herd
 * against infrastructure we are a guest on.
 */
export function backoffDelayMs(attempt: number, jitter = 0): number {
  const exponential = BACKOFF_MIN_MS * 2 ** Math.max(0, attempt);
  const capped = Math.min(exponential, BACKOFF_MAX_MS);
  // Full jitter over the lower half keeps the delay within [capped/2, capped].
  return Math.round(capped / 2 + (capped / 2) * Math.min(0.999999, Math.max(0, jitter)));
}

/* ── ffmpeg / OpenCV input options ─────────────────────────────────────────── */

export interface LiveInputOptions {
  /** Force TCP. UDP RTSP through NAT loses packets and produces corrupt, undebuggable frames. */
  rtspTransport: 'tcp';
  timeoutUs: number;
  userAgent: string;
}

/**
 * FFmpeg input arguments for a live RTSP source.
 *
 * Note the absence of `-re`: that paces a *file* at real time and is meaningless — actively
 * harmful — for a source that is already live. Present on a file input it would be correct; here it
 * would fight the stream's own clock.
 */
export function liveRtspArgs(url: string, opts: Partial<LiveInputOptions> = {}): string[] {
  const userAgent = opts.userAgent ??
    'DrishtiNet-Sentinel2026/0.1 (Gujarat Police Innovation Challenge participant; hetpatelsk@gmail.com)';
  return [
    '-rtsp_transport', 'tcp',
    '-rtsp_flags', 'prefer_tcp',
    '-user_agent', userAgent,
    '-stimeout', String(opts.timeoutUs ?? 10_000_000),
    '-fflags', '+genpts',
    '-i', url,
  ];
}

/* ── decoder warnings ──────────────────────────────────────────────────────── */

/**
 * Warnings expected when joining an H.265 stream mid-GOP, before the first IDR arrives.
 *
 * The reference says these are normal. Treating them as fatal would make every H.265 camera look
 * broken for the first second of every connection — and four of the grid's cameras are H.265.
 */
const BENIGN_DECODER_WARNINGS = [
  /Could not find ref with POC/i,
  /missing picture in access unit/i,
  /no frame\b/i,
  /non-existing PPS/i,
  /decode_slice_header error/i,
  /Invalid NAL unit size/i,
  /short term ref pic set/i,
  /RPS/i,
  /corrupted macroblock/i,
  /Frame num gap/i,
];

/** True when a decoder message is expected join noise rather than a real failure. */
export function isBenignDecoderWarning(message: string): boolean {
  return BENIGN_DECODER_WARNINGS.some((re) => re.test(message));
}

/** Messages that genuinely mean the connection is not usable. */
const FATAL_PATTERNS = [
  /Connection refused/i,
  /No route to host/i,
  /401 Unauthorized/i,
  /403 Forbidden/i,
  /404 Not Found/i,
  /Server returned \d+/i,
  /Immediate exit requested/i,
  /Invalid data found when processing input/i,
];

export function isFatalStreamError(message: string): boolean {
  if (isBenignDecoderWarning(message)) return false;
  return FATAL_PATTERNS.some((re) => re.test(message));
}

/* ── PTS-driven sampling ───────────────────────────────────────────────────── */

export interface Frame {
  /** Presentation timestamp in milliseconds, from the stream. The only timing we trust. */
  ptsMs: number;
  /** Wall-clock arrival, for latency instrumentation and anchoring only. Never for dt. */
  arrivalMs: number;
}

/**
 * Selects the frame nearest each tick of a fixed PTS grid.
 *
 * Sampling "every Nth frame" is wrong on this grid twice over: frame intervals are not uniform, so
 * every Nth frame gives a varying dt that ByteTrack's motion model reads as erratic velocity; and
 * the join burst delivers a buffered GOP faster than real time, so the first second would be
 * oversampled. Snapping to a PTS grid gives the tracker near-constant dt regardless.
 */
export class PtsGridSampler {
  private nextTick: number | null = null;
  private pending: Frame | null = null;

  constructor(private readonly intervalMs: number) {
    if (!(intervalMs > 0)) throw new Error('PTS grid interval must be positive');
  }

  /**
   * Offer a frame. Returns the frame to process, or null.
   *
   * A frame is emitted once the stream has moved past a tick, choosing whichever of the two
   * straddling frames is closer to it — so the sample sits as near the grid as the source allows.
   */
  offer(frame: Frame): Frame | null {
    if (this.nextTick === null) {
      this.nextTick = frame.ptsMs;
    }

    if (frame.ptsMs < this.nextTick) {
      // Before the tick: remember it as a candidate, keeping the latest.
      this.pending = frame;
      return null;
    }

    const previous = this.pending;
    this.pending = null;
    const chosen =
      previous !== null &&
      Math.abs(previous.ptsMs - this.nextTick) < Math.abs(frame.ptsMs - this.nextTick)
        ? previous
        : frame;

    // Advance past the frame we just emitted, so a long gap does not queue a burst of catch-up
    // ticks that would all resolve to the same frame.
    do {
      this.nextTick += this.intervalMs;
    } while (this.nextTick <= chosen.ptsMs);

    return chosen;
  }

  /** Reset on a loop or reconnect — PTS is not comparable across a discontinuity. */
  reset(): void {
    this.nextTick = null;
    this.pending = null;
  }
}

/* ── absolute time anchoring ───────────────────────────────────────────────── */

/**
 * Establishes `absolute_t = anchor + PTS` for one connection.
 *
 * The anchor is `min(arrival − PTS)` over a settling window. The minimum is the right estimator
 * because network delay only ever *adds* to arrival: the least-delayed frame is the closest to the
 * truth, and averaging would bake in the queueing delay of the join burst.
 *
 * The burst is why the window exists at all. The gateway replays a buffered GOP on connect, so the
 * first 1–2 s of frames arrive far faster than real time and their (arrival − PTS) is badly skewed.
 * Anchoring on those would offset every timestamp from that camera for the life of the connection.
 */
export class AbsoluteTimeAnchor {
  private best: number | null = null;
  private startedAt: number | null = null;
  private settled = false;

  constructor(
    /** How long to keep refining before the anchor is trusted. */
    private readonly settleMs = 5_000,
    /** Frames arriving within this of connect are burst replay and are ignored entirely. */
    private readonly burstGuardMs = 1_500,
  ) {}

  observe(frame: Frame): void {
    if (this.startedAt === null) this.startedAt = frame.arrivalMs;
    const sinceStart = frame.arrivalMs - this.startedAt;

    // Discard the replayed GOP outright rather than letting it compete for the minimum.
    if (sinceStart < this.burstGuardMs) return;

    const candidate = frame.arrivalMs - frame.ptsMs;
    if (this.best === null || candidate < this.best) this.best = candidate;
    if (sinceStart >= this.burstGuardMs + this.settleMs) this.settled = true;
  }

  /** True once the settling window has passed and the anchor may be trusted. */
  get isSettled(): boolean {
    return this.settled && this.best !== null;
  }

  /** Provisional anchor, usable before settling but subject to change. */
  get anchorMs(): number | null {
    return this.best;
  }

  /** Absolute wall-clock time for a frame, or null while still settling. */
  absoluteMs(frame: Frame): number | null {
    if (this.best === null) return null;
    return this.best + frame.ptsMs;
  }

  reset(): void {
    this.best = null;
    this.startedAt = null;
    this.settled = false;
  }
}

/* ── loop / discontinuity detection ────────────────────────────────────────── */

export interface DiscontinuitySignal {
  /** PTS jumped backwards, or forwards by more than a plausible gap. */
  ptsJump: boolean;
  /** Frame-difference spike consistent with a hard scene cut. */
  sceneCut: boolean;
  /** Burned-in clock read earlier than the previous reading. */
  clockWentBackwards: boolean;
}

export function isDiscontinuity(s: DiscontinuitySignal): boolean {
  // Any one signal is enough. A false positive costs a track reset; a false negative silently
  // merges two different moments in time into one track, which is far worse in an investigation.
  return s.ptsJump || s.sceneCut || s.clockWentBackwards;
}

/**
 * Detects a stream discontinuity from PTS alone.
 *
 * Backwards PTS is unambiguous. A large forward jump is also treated as a discontinuity because a
 * loop can restart at a higher timestamp, and because either way the tracker's state no longer
 * describes what is on screen.
 */
export class PtsDiscontinuityDetector {
  private lastPts: number | null = null;

  constructor(private readonly maxForwardGapMs = 5_000) {}

  /** Returns true when this frame begins a new continuous segment. */
  observe(ptsMs: number): boolean {
    const previous = this.lastPts;
    this.lastPts = ptsMs;
    if (previous === null) return false;

    if (ptsMs < previous) return true;
    return ptsMs - previous > this.maxForwardGapMs;
  }

  reset(): void {
    this.lastPts = null;
  }
}
