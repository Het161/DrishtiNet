/**
 * MP4_PROGRESSIVE — the adapter for the feeds the organisers actually provide.
 *
 * Discovery (see data/probe/REPORT.md) established that every one of the 31 published
 * cameras reports `delivery: "progressive"` with `hls_url: null`, served from `/stream/{id}` as
 * `video/mp4` with `accept-ranges: bytes`. The player's HLS path exists in the code but is dark:
 * `/api/prepare/status` reports nothing prepared, so HLS is a mode the organisers can switch on
 * later, not what is live today. This adapter therefore treats progressive MP4 as the real source
 * and `hls_url` as an upgrade it will take for free if it ever appears.
 *
 * The adapter does not stream to consumers itself — it delegates to FfmpegPublisher, which holds
 * the single upstream connection per camera and republishes through MediaMTX. See publisher.ts
 * for why that indirection is the point rather than an accident.
 */
import { request } from 'undici';

import {
  AdapterNotImplementedError,
  POLITENESS,
  type BrowserEndpoint,
  type CameraSource,
  type SourceAdapter,
  type SourceHealth,
} from './types.js';
import type { FfmpegPublisher } from '../publisher.js';

export interface Mp4ProgressiveConfig {
  /** Base URL the browser uses to reach MediaMTX's WebRTC endpoint. */
  webrtcBaseUrl: string;
  /** Base URL of MediaMTX's control API, used for snapshots and path status. */
  mediamtxApiUrl: string;
  publisher: FfmpegPublisher;
}

interface CachedSnapshot {
  buffer: Buffer;
  fetchedAt: number;
}

export class Mp4ProgressiveAdapter implements SourceAdapter {
  readonly kind = 'MP4_PROGRESSIVE' as const;

  private readonly snapshotCache = new Map<string, CachedSnapshot>();
  private readonly inFlight = new Map<string, Promise<Buffer>>();

  constructor(private readonly cfg: Mp4ProgressiveConfig) {}

  /**
   * The browser always plays our republished WebRTC stream, never the portal directly.
   * MediaMTX exposes WHEP at /{path}/whep.
   */
  browserEndpoint(camera: CameraSource): BrowserEndpoint {
    const base = this.cfg.webrtcBaseUrl.replace(/\/$/, '');
    return {
      kind: 'webrtc-whep',
      url: `${base}/cam/${encodeURIComponent(camera.id)}/whep`,
      viaGateway: true,
    };
  }

  /** Analytics reads MediaMTX's RTSP, so the portal never sees a second connection. */
  analyticsUrl(camera: CameraSource): string {
    return this.cfg.publisher.rtspUrl(camera.id);
  }

  /**
   * A consumer starts watching. Refcounted: the first subscriber opens the single upstream
   * connection, and it closes on an idle timeout after the last one leaves.
   */
  async ensureStarted(camera: CameraSource): Promise<void> {
    await this.cfg.publisher.acquire(camera);
  }

  /** A consumer stops watching. Does not tear the stream down while others are still attached. */
  release(camera: CameraSource): void {
    this.cfg.publisher.release(camera.id);
  }

  async stop(camera: CameraSource): Promise<void> {
    await this.cfg.publisher.stop(camera.id);
  }

  /**
   * One JPEG from MediaMTX, cached for at least the politeness interval.
   * Concurrent callers share a single in-flight fetch — 50 tiles refreshing together must not
   * become 50 simultaneous requests.
   */
  async snapshot(camera: CameraSource): Promise<Buffer> {
    const cached = this.snapshotCache.get(camera.id);
    if (cached && Date.now() - cached.fetchedAt < POLITENESS.minSnapshotIntervalMs) {
      return cached.buffer;
    }

    const existing = this.inFlight.get(camera.id);
    if (existing) return existing;

    const task = this.fetchSnapshot(camera)
      .then((buffer) => {
        this.snapshotCache.set(camera.id, { buffer, fetchedAt: Date.now() });
        return buffer;
      })
      .finally(() => {
        this.inFlight.delete(camera.id);
      });

    this.inFlight.set(camera.id, task);
    return task;
  }

  private async fetchSnapshot(camera: CameraSource): Promise<Buffer> {
    const base = this.cfg.webrtcBaseUrl.replace(/\/$/, '');
    const url = `${base}/cam/${encodeURIComponent(camera.id)}/frame.jpeg`;
    const res = await request(url, {
      method: 'GET',
      headers: { 'user-agent': POLITENESS.userAgent },
      headersTimeout: 5000,
      bodyTimeout: 5000,
    });
    if (res.statusCode !== 200) {
      // Serve a stale frame rather than a broken tile — an operator would rather see the last
      // known image with an age badge than a grey rectangle.
      const stale = this.snapshotCache.get(camera.id);
      if (stale) return stale.buffer;
      throw new Error(`snapshot failed: HTTP ${res.statusCode}`);
    }
    return Buffer.from(await res.body.arrayBuffer());
  }

  async health(camera: CameraSource): Promise<SourceHealth> {
    const s = this.cfg.publisher.state(camera.id);
    // A publisher that has not produced a frame in 15 s is degraded even if ffmpeg is alive.
    const stale = s.lastFrameAt !== null && Date.now() - s.lastFrameAt > 15_000;
    return {
      cameraId: camera.id,
      status: stale && s.status === 'online' ? 'degraded' : s.status,
      lastFrameAt: s.lastFrameAt,
      fps: s.fps,
      latencyMs: null,
      detail: stale ? 'no frames for >15s' : s.detail,
    };
  }
}

/**
 * Direct-from-portal fallback.
 *
 * Only for the situation where MediaMTX is unavailable and we must show something. It replicates
 * the portal's own client-side seek, and it is deliberately NOT the default: pointed at 50 tiles
 * it would open 50 upstream connections. The wall enforces a hard cap on how many of these it will
 * ever create.
 */
export function directPortalEndpoint(camera: CameraSource, upstreamBase: string): BrowserEndpoint {
  const base = upstreamBase.replace(/\/$/, '');
  return {
    kind: 'mp4',
    url: `${base}${camera.sourceUrl}`,
    viaGateway: false,
  };
}

export function assertGatewayPath(endpoint: BrowserEndpoint, tileCount: number): void {
  if (!endpoint.viaGateway && tileCount > 2) {
    throw new AdapterNotImplementedError(
      'MP4_PROGRESSIVE',
      `refusing to open ${tileCount} direct upstream connections — route through the gateway`,
    );
  }
}
