/**
 * FFmpeg publisher: turns the portal's fake-live VOD into a real live stream.
 *
 * The central design decision of the whole stream tier lives here.
 *
 * The portal serves each camera as a multi-gigabyte progressive MP4 and lets the *browser* fake
 * liveness by seeking to `slot_offset`. If we copied that approach, every operator tab and every
 * analytics worker would open its own connection to shared government infrastructure and each
 * would independently pull gigabytes. With 50 tiles and a handful of analysts that is hundreds of
 * concurrent range-streams from one team — on a portal every competing team is also hammering.
 *
 * Instead the gateway opens exactly ONE upstream connection per camera, seeks it to the correct
 * slot position, paces it at real time (`-re`) and republishes it into MediaMTX as RTSP. From
 * there MediaMTX fans it out to WebRTC for browser tiles, RTSP for analytics, and JPEG snapshots
 * for the wall — all without touching the portal again.
 *
 * Two useful properties fall out of that:
 *   - Upstream load is constant in the number of viewers. This is also exactly how a real
 *     deployment federating district NETRAM control rooms would have to work.
 *   - Every consumer sees the SAME frames at the same moment, so a detection on the analytics path
 *     genuinely corresponds to what the operator is looking at.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

import { playbackPositionSeconds, secondsUntilLoop } from './slot.js';
import { POLITENESS, type CameraSource, type HealthStatus } from './adapters/types.js';

export interface PublisherConfig {
  /** Base URL of the upstream portal, e.g. https://live.sentinelgujarat.in */
  upstreamBase: string;
  /** RTSP host MediaMTX listens on, e.g. "mediamtx" in compose or "localhost" in dev. */
  rtspHost: string;
  rtspPort: number;
  ffmpegPath?: string;
  /**
   * Re-encode instead of stream-copying. Needed for the two AVI sources whose codec MediaMTX
   * cannot carry over RTSP untouched.
   */
  forceTranscode?: boolean;
}

export interface PublisherState {
  cameraId: string;
  status: HealthStatus;
  startedAt: number | null;
  lastFrameAt: number | null;
  /** Playback position we seeked to on the current attempt. */
  seekedTo: number | null;
  restarts: number;
  consecutiveFailures: number;
  fps: number | null;
  detail: string | null;
}

/** Containers/codecs MediaMTX can carry without a re-encode. */
const COPYABLE_CODECS = new Set(['h264', 'hevc', 'h265']);

export class FfmpegPublisher {
  private readonly procs = new Map<string, ChildProcess>();
  private readonly states = new Map<string, PublisherState>();
  private readonly stopping = new Set<string>();

  constructor(private readonly cfg: PublisherConfig) {}

  /** RTSP path MediaMTX will expose this camera on. */
  rtspUrl(cameraId: string): string {
    return `rtsp://${this.cfg.rtspHost}:${this.cfg.rtspPort}/cam/${encodeURIComponent(cameraId)}`;
  }

  state(cameraId: string): PublisherState {
    return (
      this.states.get(cameraId) ?? {
        cameraId,
        status: 'unknown',
        startedAt: null,
        lastFrameAt: null,
        seekedTo: null,
        restarts: 0,
        consecutiveFailures: 0,
        fps: null,
        detail: 'not started',
      }
    );
  }

  allStates(): PublisherState[] {
    return [...this.states.values()];
  }

  /** Idempotent — a second call for a running camera is a no-op, never a second connection. */
  async ensureStarted(camera: CameraSource): Promise<void> {
    if (this.procs.has(camera.id)) return;
    this.stopping.delete(camera.id);
    void this.runForever(camera);
    // Give the process a moment to fail loudly on an obviously bad URL.
    await delay(50);
  }

  async stop(cameraId: string): Promise<void> {
    this.stopping.add(cameraId);
    const proc = this.procs.get(cameraId);
    if (proc) {
      proc.kill('SIGTERM');
      this.procs.delete(cameraId);
    }
    const s = this.states.get(cameraId);
    if (s) {
      s.status = 'offline';
      s.detail = 'stopped by operator';
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.procs.keys()].map((id) => this.stop(id)));
  }

  private upstreamUrl(camera: CameraSource): string {
    if (/^https?:\/\//i.test(camera.sourceUrl)) return camera.sourceUrl;
    return `${this.cfg.upstreamBase.replace(/\/$/, '')}${camera.sourceUrl}`;
  }

  private buildArgs(camera: CameraSource, position: number): string[] {
    const canCopy =
      !this.cfg.forceTranscode && !!camera.codec && COPYABLE_CODECS.has(camera.codec.toLowerCase());

    const args = [
      '-hide_banner',
      '-loglevel', 'warning',
      '-nostdin',
      '-user_agent', POLITENESS.userAgent,
      // Survive the origin's habit of dropping long-lived range reads.
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_on_network_error', '1',
      '-reconnect_delay_max', '10',
      '-rw_timeout', '30000000',
      // Input seek: FFmpeg turns this into an HTTP range request rather than reading from byte 0.
      '-ss', position.toFixed(3),
      // Pace the file at real time so downstream sees a genuine live stream, not a fast dump.
      '-re',
      '-i', this.upstreamUrl(camera),
      // Surveillance sources carry no useful audio and MediaMTX is happier without it.
      '-an',
    ];

    if (canCopy) {
      args.push('-c:v', 'copy');
    } else {
      // The AVI sources (cameras 6 and 23) land here.
      args.push(
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-tune', 'zerolatency',
        '-g', '50',
        '-pix_fmt', 'yuv420p',
      );
    }

    args.push(
      '-f', 'rtsp',
      '-rtsp_transport', 'tcp',
      this.rtspUrl(camera.id),
    );
    return args;
  }

  /**
   * Supervise one camera for the lifetime of the process: seek, publish, and on any exit
   * recompute the slot position and resume. Never busy-loops — failures back off.
   */
  private async runForever(camera: CameraSource): Promise<void> {
    let state = this.state(camera.id);
    this.states.set(camera.id, state);

    while (!this.stopping.has(camera.id)) {
      const position = playbackPositionSeconds({
        durationSeconds: camera.durationSeconds,
        loop: true,
      });

      state.seekedTo = position;
      state.startedAt = Date.now();
      state.status = 'unknown';
      state.detail = `seeking to ${position.toFixed(1)}s`;

      const args = this.buildArgs(camera, position);
      const proc = spawn(this.cfg.ffmpegPath ?? 'ffmpeg', args, {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      this.procs.set(camera.id, proc);

      const exitCode = await this.superviseProcess(camera, proc, state);
      this.procs.delete(camera.id);

      if (this.stopping.has(camera.id)) break;

      state.restarts += 1;

      // A clean exit at roughly the file's end is a loop, not a failure — restart immediately.
      const runway = secondsUntilLoop(position, camera.durationSeconds);
      const ranToEnd =
        exitCode === 0 ||
        (runway !== null && Date.now() - (state.startedAt ?? 0) >= runway * 1000 * 0.9);

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
  }

  private superviseProcess(
    camera: CameraSource,
    proc: ChildProcess,
    state: PublisherState,
  ): Promise<number | null> {
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
          state.lastFrameAt = Date.now();
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
