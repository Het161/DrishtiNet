/**
 * Adapter stubs for the source types a real statewide deployment must absorb.
 *
 * These are deliberately unimplemented and deliberately present. The Sentinel challenge asks for a
 * platform that federates 80,000 cameras across 26 departments — hardware from Hikvision, Dahua,
 * CP Plus, Bosch and Axis, behind Milestone XProtect, Genetec, HikCentral and Dahua DSS, plus
 * analog cameras reaching the network only through DVR/encoder RTSP. Shipping only the adapter for
 * the one protocol this year's portal happens to serve would be a demo, not an architecture.
 *
 * Each stub records exactly what implementing it involves, so the design is auditable rather than
 * aspirational. None of them silently return fake data: every method throws, because a stub that
 * quietly returns a placeholder frame is how a demo lies to its operator.
 */
import {
  AdapterNotImplementedError,
  type BrowserEndpoint,
  type CameraSource,
  type SourceAdapter,
  type SourceHealth,
} from './types.js';

abstract class StubAdapter implements SourceAdapter {
  abstract readonly kind: SourceAdapter['kind'];
  protected abstract readonly plan: string;

  browserEndpoint(_camera: CameraSource): BrowserEndpoint {
    throw new AdapterNotImplementedError(this.kind, this.plan);
  }
  analyticsUrl(_camera: CameraSource): string {
    throw new AdapterNotImplementedError(this.kind, this.plan);
  }
  async snapshot(_camera: CameraSource): Promise<Buffer> {
    throw new AdapterNotImplementedError(this.kind, this.plan);
  }
  async health(camera: CameraSource): Promise<SourceHealth> {
    return {
      cameraId: camera.id,
      status: 'unknown',
      lastFrameAt: null,
      fps: null,
      latencyMs: null,
      detail: `${this.kind} adapter not implemented — ${this.plan}`,
    };
  }
}

/**
 * The single most important adapter for a real deployment: essentially every IP camera and every
 * DVR/encoder fronting an analog camera speaks RTSP.
 */
export class RtspAdapter extends StubAdapter {
  readonly kind = 'RTSP' as const;
  protected readonly plan =
    'point MediaMTX at the camera with `source: rtsp://…` and `sourceProtocol: tcp`, then reuse ' +
    'the existing WebRTC/snapshot/RTSP fan-out unchanged. Roughly a config entry plus credential ' +
    'handling; no new media code. Expect sub-second glass-to-glass because H.264 passes through ' +
    'without a re-encode.';
}

/**
 * Present because the portal's own player already contains an HLS path (`feed.hls_url`) that is
 * currently dark. If the organisers run their prepare step before the finale, this becomes live
 * and we want the switch to be a config change.
 */
export class HlsAdapter extends StubAdapter {
  readonly kind = 'HLS' as const;
  protected readonly plan =
    'MediaMTX accepts an HLS URL as a source directly. Latency is bounded below by segment ' +
    'duration (typically 2-6 s), so HLS is acceptable for wall thumbnails but must never back the ' +
    'focused tile — re-publish to WebRTC for that. Use `-live_start_index -1` when ingesting to ' +
    'start at the newest segment rather than the beginning of the playlist.';
}

/**
 * Common on older municipal installations and the cheapest possible browser path — an <img> tag
 * plays it natively with no JavaScript at all.
 */
export class MjpegAdapter extends StubAdapter {
  readonly kind = 'MJPEG' as const;
  protected readonly plan =
    'serve `multipart/x-mixed-replace` straight to an <img> for sub-500 ms latency, and open it ' +
    'with OpenCV VideoCapture for analytics. The catch is bandwidth — a full JPEG per frame — so ' +
    'the wall must render only visible tiles and throttle hidden ones hard.';
}

/**
 * Offline demo path. Also the on-site insurance policy: if the venue has no route to the portal,
 * the recorded sample set in data/samples/ is loaded through this adapter and the entire demo
 * runs with no network at all.
 */
export class FileLoopAdapter extends StubAdapter {
  readonly kind = 'FILE_LOOP' as const;
  protected readonly plan =
    'ffmpeg `-re -stream_loop -1 -i <file>` into MediaMTX, identical downstream to the live path. ' +
    'Wire this to data/samples/ for the fully offline rehearsal and the demo-day fallback.';
}

/**
 * ONVIF is the standard that makes camera onboarding scale: WS-Discovery finds devices on a
 * subnet, Profile S returns the RTSP URL, and the operator never types a URL by hand.
 */
export class OnvifStubAdapter extends StubAdapter {
  readonly kind = 'ONVIF_STUB' as const;
  protected readonly plan =
    'WS-Discovery probe to enumerate devices on a subnet, then Profile S GetStreamUri to resolve ' +
    'each RTSP endpoint, Profile G for edge recording retrieval, Profile T for H.265, Profile M ' +
    'for vendor analytics metadata. Once the URI is resolved this delegates to RtspAdapter, so ' +
    'ONVIF is an onboarding concern rather than a streaming one.';
}

/**
 * The federation story for Reference Models 2 and 3: departments that will not expose raw RTSP but
 * will expose their VMS API.
 */
export class VmsSdkStubAdapter extends StubAdapter {
  readonly kind = 'VMS_SDK_STUB' as const;
  protected readonly plan =
    'per-vendor connectors (Milestone XProtect MIP, Genetec Security Center SDK, HikCentral ' +
    'OpenAPI, Dahua DSS) that authenticate, list cameras, and return a playable URI plus recorded ' +
    'segments. Each is licence-gated and cannot be built or tested without vendor credentials, so ' +
    'it is documented as an integration contract rather than stubbed out with invented endpoints.';
}

export const STUB_ADAPTERS = {
  RTSP: RtspAdapter,
  HLS: HlsAdapter,
  MJPEG: MjpegAdapter,
  FILE_LOOP: FileLoopAdapter,
  ONVIF_STUB: OnvifStubAdapter,
  VMS_SDK_STUB: VmsSdkStubAdapter,
} as const;
