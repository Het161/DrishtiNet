/**
 * FFmpeg publisher: turns the portal's fake-live VOD into a real live stream.
 *
 * ── Why the indirection exists ───────────────────────────────────────────────────────────────
 *
 * The portal serves each camera as a multi-gigabyte progressive MP4 and lets the *browser* fake
 * liveness by seeking to `slot_offset`. Copying that approach would mean every operator tab and
 * every analytics worker opening its own connection to shared government infrastructure, each
 * independently pulling gigabytes. With a 50-tile wall that is hundreds of concurrent range-streams
 * from one team, on a portal every competing team is also using.
 *
 * Instead the gateway opens exactly ONE upstream connection per camera, seeks it to the correct
 * slot position, paces it at real time (`-re`) and republishes it into MediaMTX as RTSP. MediaMTX
 * then fans it out to WebRTC tiles, RTSP for analytics, and JPEG snapshots — without touching the
 * portal again. Upstream load is constant in the number of viewers, and every consumer sees the
 * same frames at the same moment.
 *
 * ── Lazy by default ──────────────────────────────────────────────────────────────────────────
 *
 * Nothing starts until something subscribes, and everything stops `idleTimeoutMs` after the last
 * subscriber leaves. Thirty-one cameras publishing continuously because a dashboard was left open
 * on a laptop overnight would be indefensible use of someone else's bandwidth.
 *
 * ── Two different drifts ─────────────────────────────────────────────────────────────────────
 *
 * This class corrects PACING drift: `-re` paces from ffmpeg's own clock, which slips against wall
 * time, so the published stream gradually stops matching the slot position an operator expects.
 * Every `driftCheckIntervalMs` we recompute the expected position and re-seek when the gap exceeds
 * `maxDriftSeconds`.
 *
 * That is NOT the same as the source-clock drift handled in slot.ts (the recorded footage's own
 * burned-in clock runs ~0.5% fast against file position). Fixing one does nothing for the other.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

import { playbackPositionSeconds, secondsUntilLoop, now as projectNow } from './slot.js';
import { POLITENESS, type CameraSource, type HealthStatus } from './adapters/types.js';

/** The slice of ChildProcess we use, so tests can substitute a fake without spawning anything. */
export interface SpawnedProcess {
  stderr: {
    setEncoding(encoding: string): void;
    on(event: 'data', listener: (chunk: string) => void): void;
  } | null;
  on(event: 'error', listener: (err: Error) => void): void;
  on(event: 'exit', listener: (code: number | null) => void): void;
  kill(signal?: NodeJS.Signals): void;
}

export type SpawnFn = (command: string, args: string[]) => SpawnedProcess;

export interface PublisherConfig {
  /** Base URL of the upstream portal, e.g. https://live.sentinelgujarat.in */
  upstreamBase: string;
  rtspHost: string;
  rtspPort: number;
  ffmpegPath?: string;
  /** Re-encode instead of stream-copying (the AVI sources need this). */
  forceTranscode?: boolean;
  /** How long a camera keeps publishing after its last subscriber leaves. */
  idleTimeoutMs?: number;
  /** How often to compare actual playback position against the expected slot position. */
  driftCheckIntervalMs?: number;
  /** Re-seek once measured drift exceeds this. */
  maxDriftSeconds?: number;
  /** Injectable for tests. */
  spawn?: SpawnFn;
  now?: () => number;
}

export interface PublisherState {
  cameraId: string;
  status: HealthStatus;
  subscribers: number;
  startedAt: number | null;
  lastFrameAt: number | null;
  /** Playback position we seeked to on the current attempt. */
  seekedTo: number | null;
  restarts: number;
  reseeks: number;
  consecutiveFailures: number;
  fps: number | null;
  /** Last measured pacing drift, in seconds. Positive means we are ahead of the slot. */
  driftSeconds: number | null;
  detail: string | null;
}

/** Containers/codecs MediaMTX can carry without a re-encode. */
const COPYABLE_CODECS = new Set(['h264', 'hevc', 'h265']);

export const DEFAULTS = {
  idleTimeoutMs: 60_000,
  driftCheckIntervalMs: 30_000,
  maxDriftSeconds: 2,
} as const;

/**
 * Should a stream be re-seeked? Pure so the policy is testable without processes or timers.
 * A NaN or non-finite drift is never actionable — re-seeking on garbage would thrash the upstream.
 */
export function shouldReseek(driftSeconds: number, maxDriftSeconds: number): boolean {
  return Number.isFinite(driftSeconds) && Math.abs(driftSeconds) > maxDriftSeconds;
}

/**
 * Difference between two positions in a looping file, taking the shorter way round.
 *
 * Without this, a stream sitting 1 s past a loop boundary looks like it is a whole file-length
 * away from a stream sitting 1 s before it, and the publisher would re-seek every single loop.
 */
export function circularDrift(
  actual: number,
  expected: number,
  periodSeconds: number | null,
): number {
  let drift = actual - expected;
  if (periodSeconds && periodSeconds > 0) {
    if (drift > periodSeconds / 2) drift -= periodSeconds;
    else if (drift < -periodSeconds / 2) drift += periodSeconds;
  }
  return drift;
}

/**
 * Where playback has actually reached, assuming it advanced at real time from the seek point.
 * Compared against the freshly computed expected position to measure pacing drift.
 */
export function actualPosition(
  seekedTo: number,
  startedAtMs: number,
  nowMs: number,
  durationSeconds: number | null,
): number {
  const elapsed = Math.max(0, (nowMs - startedAtMs) / 1000);
  const raw = seekedTo + elapsed;
  if (durationSeconds !== null && durationSeconds > 0) return raw % durationSeconds;
  return raw;
}

export class FfmpegPublisher {
  private readonly procs = new Map<string, SpawnedProcess>();
  private readonly states = new Map<string, PublisherState>();
  private readonly cameras = new Map<string, CameraSource>();
  private readonly stopping = new Set<string>();
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private driftTimer: ReturnType<typeof setInterval> | null = null;

  private readonly idleTimeoutMs: number;
  private readonly driftCheckIntervalMs: number;
  private readonly maxDriftSeconds: number;
  private readonly spawnFn: SpawnFn;
  private readonly now: () => number;

  constructor(private readonly cfg: PublisherConfig) {
    this.idleTimeoutMs = cfg.idleTimeoutMs ?? DEFAULTS.idleTimeoutMs;
    this.driftCheckIntervalMs = cfg.driftCheckIntervalMs ?? DEFAULTS.driftCheckIntervalMs;
    this.maxDriftSeconds = cfg.maxDriftSeconds ?? DEFAULTS.maxDriftSeconds;
    this.now = cfg.now ?? projectNow;
    this.spawnFn =
      cfg.spawn ??
      ((command, args) =>
        nodeSpawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] }) as unknown as SpawnedProcess);
  }

  /** RTSP path MediaMTX exposes this camera on. */
  rtspUrl(cameraId: string): string {
    return `rtsp://${this.cfg.rtspHost}:${this.cfg.rtspPort}/cam/${encodeURIComponent(cameraId)}`;
  }

  private ensureState(cameraId: string): PublisherState {
    let s = this.states.get(cameraId);
    if (!s) {
      s = {
        cameraId, status: 'unknown', subscribers: 0, startedAt: null, lastFrameAt: null,
        seekedTo: null, restarts: 0, reseeks: 0, consecutiveFailures: 0, fps: null,
        driftSeconds: null, detail: 'idle',
      };
      this.states.set(cameraId, s);
    }
    return s;
  }

  state(cameraId: string): PublisherState {
    return { ...this.ensureState(cameraId) };
  }

  allStates(): PublisherState[] {
    return [...this.states.values()].map((s) => ({ ...s }));
  }

  subscriberCount(cameraId: string): number {
    return this.states.get(cameraId)?.subscribers ?? 0;
  }

  isPublishing(cameraId: string): boolean {
    return this.procs.has(cameraId);
  }

  /**
   * A consumer (video tile, analytics worker) starts watching.
   * The first subscriber starts the upstream; later ones are free.
   */
  async acquire(camera: CameraSource): Promise<void> {
    this.cameras.set(camera.id, camera);
    const s = this.ensureState(camera.id);
    s.subscribers += 1;

    // Cancel a pending idle stop — someone came back before the timeout elapsed.
    const idle = this.idleTimers.get(camera.id);
    if (idle) {
      clearTimeout(idle);
      this.idleTimers.delete(camera.id);
    }

    if (s.subscribers === 1 && !this.procs.has(camera.id)) {
      this.stopping.delete(camera.id);
      s.detail = 'starting (first subscriber)';
      void this.runForever(camera);
      this.startDriftMonitor();
      await delay(0);
    }
  }

  /** A consumer stops watching. The upstream closes `idleTimeoutMs` after the last one leaves. */
  release(cameraId: string): void {
    const s = this.states.get(cameraId);
    if (!s || s.subscribers === 0) return;
    s.subscribers -= 1;
    if (s.subscribers > 0) return;

    s.detail = `idle — stopping in ${Math.round(this.idleTimeoutMs / 1000)}s`;
    const timer = setTimeout(() => {
      this.idleTimers.delete(cameraId);
      if (this.subscriberCount(cameraId) === 0) void this.stop(cameraId);
    }, this.idleTimeoutMs);
    // Never hold the process open just to run an idle timer.
    timer.unref?.();
    this.idleTimers.set(cameraId, timer);
  }

  async stop(cameraId: string): Promise<void> {
    this.stopping.add(cameraId);
    const idle = this.idleTimers.get(cameraId);
    if (idle) {
      clearTimeout(idle);
      this.idleTimers.delete(cameraId);
    }
    const proc = this.procs.get(cameraId);
    if (proc) {
      proc.kill('SIGTERM');
      this.procs.delete(cameraId);
    }
    const s = this.states.get(cameraId);
    if (s) {
      s.status = 'offline';
      s.startedAt = null;
      s.detail = 'stopped';
    }
    if (this.procs.size === 0) this.stopDriftMonitor();
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.states.keys()].map((id) => this.stop(id)));
    this.stopDriftMonitor();
  }

  /* ── drift ──────────────────────────────────────────────────────────────── */

  private startDriftMonitor(): void {
    if (this.driftTimer) return;
    this.driftTimer = setInterval(() => this.checkDrift(), this.driftCheckIntervalMs);
    this.driftTimer.unref?.();
  }

  private stopDriftMonitor(): void {
    if (!this.driftTimer) return;
    clearInterval(this.driftTimer);
    this.driftTimer = null;
  }

  /**
   * Compare where playback actually is against where the slot says it should be, and re-seek when
   * they diverge. Exposed for tests and for the health endpoint.
   */
  checkDrift(): void {
    for (const [cameraId, s] of this.states) {
      if (!this.procs.has(cameraId) || s.startedAt === null || s.seekedTo === null) continue;
      const camera = this.cameras.get(cameraId);
      if (!camera) continue;

      const nowMs = this.now();
      const expected = playbackPositionSeconds({
        durationSeconds: camera.durationSeconds,
        nowMs,
      });
      const actual = actualPosition(s.seekedTo, s.startedAt, nowMs, camera.durationSeconds);

      const drift = circularDrift(actual, expected, camera.durationSeconds);
      s.driftSeconds = drift;

      if (shouldReseek(drift, this.maxDriftSeconds)) {
        s.reseeks += 1;
        s.detail = `pacing drift ${drift.toFixed(1)}s — re-seeking`;
        // Killing the process makes runForever recompute the position and restart cleanly.
        this.procs.get(cameraId)?.kill('SIGTERM');
      }
    }
  }

  /* ── process supervision ────────────────────────────────────────────────── */

  private upstreamUrl(camera: CameraSource): string {
    if (/^https?:\/\//i.test(camera.sourceUrl)) return camera.sourceUrl;
    return `${this.cfg.upstreamBase.replace(/\/$/, '')}${camera.sourceUrl}`;
  }

  buildArgs(camera: CameraSource, position: number): string[] {
    const canCopy =
      !this.cfg.forceTranscode && !!camera.codec && COPYABLE_CODECS.has(camera.codec.toLowerCase());

    const args = [
      '-hide_banner', '-loglevel', 'warning', '-nostdin',
      '-user_agent', POLITENESS.userAgent,
      // Survive the origin's habit of dropping long-lived range reads.
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_on_network_error', '1',
      '-reconnect_delay_max', '10',
      '-rw_timeout', '30000000',
      // Input seek: FFmpeg turns this into an HTTP range request rather than reading from byte 0.
      '-ss', position.toFixed(3),
      // Pace the file at real time so downstream sees a live stream, not a fast dump.
      '-re',
      '-i', this.upstreamUrl(camera),
      // Surveillance sources carry no useful audio and MediaMTX is happier without it.
      '-an',
    ];

    if (canCopy) {
      args.push('-c:v', 'copy');
    } else {
      args.push(
        '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
        '-g', '50', '-pix_fmt', 'yuv420p',
      );
    }

    args.push('-f', 'rtsp', '-rtsp_transport', 'tcp', this.rtspUrl(camera.id));
    return args;
  }

  /**
   * Supervise one camera until it is stopped: seek, publish, and on any exit recompute the slot
   * position and resume. Failures back off; a clean end-of-file is a loop, not an error.
   */
  private async runForever(camera: CameraSource): Promise<void> {
    const state = this.ensureState(camera.id);

    while (!this.stopping.has(camera.id) && this.subscriberCount(camera.id) > 0) {
      const position = playbackPositionSeconds({
        durationSeconds: camera.durationSeconds,
        loop: true,
        nowMs: this.now(),
      });

      state.seekedTo = position;
      state.startedAt = this.now();
      state.status = 'unknown';
      state.driftSeconds = null;
      state.detail = `seeking to ${position.toFixed(1)}s`;

      const proc = this.spawnFn(this.cfg.ffmpegPath ?? 'ffmpeg', this.buildArgs(camera, position));
      this.procs.set(camera.id, proc);

      const exitCode = await this.superviseProcess(proc, state);
      this.procs.delete(camera.id);

      if (this.stopping.has(camera.id) || this.subscriberCount(camera.id) === 0) break;

      state.restarts += 1;

      // A clean exit near the file's end is a loop; restart immediately at the new position.
      const runway = secondsUntilLoop(position, camera.durationSeconds);
      const ranToEnd =
        exitCode === 0 ||
        (runway !== null && this.now() - (state.startedAt ?? 0) >= runway * 1000 * 0.9);

      if (ranToEnd) {
        state.consecutiveFailures = 0;
        state.detail = 'source looped — reseeking';
        continue;
      }

      state.consecutiveFailures += 1;
      state.status = 'offline';
      const backoff =
        POLITENESS.retryBackoffMs[
          Math.min(state.consecutiveFailures - 1, POLITENESS.retryBackoffMs.length - 1)
        ]!;
      state.detail = `upstream failed (exit ${exitCode}); retrying in ${backoff}ms`;
      await delay(backoff);
    }

    state.status = this.subscriberCount(camera.id) === 0 ? 'offline' : state.status;
    if (this.procs.size === 0) this.stopDriftMonitor();
  }

  private superviseProcess(proc: SpawnedProcess, state: PublisherState): Promise<number | null> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        resolve(code);
      };

      // FFmpeg reports progress on stderr; each `frame=` line proves the pipeline is alive.
      proc.stderr?.setEncoding('utf8');
      proc.stderr?.on('data', (chunk: string) => {
        if (chunk.includes('frame=') || chunk.includes('speed=')) {
          state.lastFrameAt = this.now();
          state.status = 'online';
          state.consecutiveFailures = 0;
          state.detail = null;
          const fps = /fps=\s*([\d.]+)/.exec(chunk);
          if (fps) state.fps = Number(fps[1]);
        } else {
          const line = chunk.trim().split('\n').pop();
          if (line) state.detail = line.slice(0, 200);
        }
      });

      proc.on('error', (err) => {
        state.status = 'offline';
        state.detail = `spawn failed: ${err.message}`;
        finish(null);
      });
      proc.on('exit', (code) => finish(code));
    });
  }
}
