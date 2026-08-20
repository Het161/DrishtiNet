/**
 * The uniform source-adapter contract.
 *
 * Everything downstream — the video wall, the analytics workers, the health map — talks only to
 * this interface. That is the whole "heterogeneous sources" story from Reference Model 2/3 made
 * concrete: Gujarat's 80,000 cameras sit behind Hikvision, Dahua, CP Plus and Bosch hardware and
 * Milestone/Genetec/HikCentral VMS platforms, and no central platform can care which. The Sentinel
 * portal happens to serve progressive MP4; a district NETRAM control room will serve RTSP; a
 * modern VMS will offer ONVIF. All of them satisfy this same four-method contract.
 */

export type SourceType =
  | 'MP4_PROGRESSIVE'
  | 'RTSP'
  | 'HLS'
  | 'MJPEG'
  | 'FILE_LOOP'
  | 'ONVIF_STUB'
  | 'VMS_SDK_STUB';

export interface CameraSource {
  /** Stable primary key. For the portal this is `portal_id`, never the display label number. */
  id: string;
  name: string;
  sourceType: SourceType;
  /** Absolute or portal-relative URL of the upstream media. */
  sourceUrl: string;
  /** Measured file duration in seconds; null until probed. Drives the loop arithmetic. */
  durationSeconds: number | null;
  /** Upstream container/codec, used to decide copy-vs-transcode. */
  codec: string | null;
  container: string | null;
}

export type HealthStatus = 'online' | 'degraded' | 'offline' | 'unknown';

export interface SourceHealth {
  cameraId: string;
  status: HealthStatus;
  /** Epoch ms of the last frame we actually saw. Null when never connected. */
  lastFrameAt: number | null;
  /** Measured frames per second on the analysed path, not the nominal container rate. */
  fps: number | null;
  /** Time from request to first byte, in ms. */
  latencyMs: number | null;
  detail: string | null;
}

/**
 * What the browser plays for a given camera.
 * `kind` matters because the video wall renders each differently: a WebRTC tile needs a peer
 * connection, an MJPEG tile is just an <img>, and an HLS tile needs hls.js.
 */
export interface BrowserEndpoint {
  kind: 'webrtc-whep' | 'hls' | 'mjpeg' | 'mp4';
  url: string;
  /**
   * True when the browser is served by our own gateway rather than by the upstream origin.
   * The video wall refuses to open more than a handful of direct-upstream tiles, because that
   * would fan out one connection per viewer onto shared infrastructure.
   */
  viaGateway: boolean;
}

export interface SourceAdapter {
  readonly kind: SourceType;

  /** What the web tile plays. WebRTC/WHEP preferred; falls back to the native format. */
  browserEndpoint(camera: CameraSource): BrowserEndpoint;

  /** What OpenCV/PyAV opens for analysis — the low-resolution path where one exists. */
  analyticsUrl(camera: CameraSource): string;

  /** One JPEG. Implementations MUST cache for at least `minSnapshotIntervalMs`. */
  snapshot(camera: CameraSource): Promise<Buffer>;

  health(camera: CameraSource): Promise<SourceHealth>;

  /**
   * Start whatever long-lived work the adapter needs (e.g. an ffmpeg publisher into MediaMTX).
   * Idempotent: calling it twice for the same camera must not open a second upstream connection.
   */
  ensureStarted?(camera: CameraSource): Promise<void>;

  stop?(camera: CameraSource): Promise<void>;
}

/**
 * Politeness budget. The Sentinel portal is shared government infrastructure used by every
 * competing team simultaneously, so these are hard limits, not suggestions.
 */
export const POLITENESS = {
  /** Never poll a snapshot faster than this. */
  minSnapshotIntervalMs: 2000,
  /** At most one upstream connection per camera, across the entire system. */
  maxUpstreamConnectionsPerCamera: 1,
  /** Backoff schedule after an upstream failure. */
  retryBackoffMs: [1000, 2000, 4000, 8000, 16000, 30000],
  userAgent:
    'DrishtiNet-Sentinel2026/0.1 (Gujarat Police Innovation Challenge participant; hetpatelsk@gmail.com)',
} as const;

export class AdapterNotImplementedError extends Error {
  constructor(kind: SourceType, detail: string) {
    super(`${kind} adapter is a stub: ${detail}`);
    this.name = 'AdapterNotImplementedError';
  }
}
