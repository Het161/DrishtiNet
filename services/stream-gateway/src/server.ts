#!/usr/bin/env tsx
/**
 * Stream gateway HTTP service.
 *
 * The single place the rest of the system asks "how do I watch camera X?", so that nothing else
 * ever needs to know whether the answer is RTSP, HLS, WHEP or a local mirror. That indirection is
 * what let the portal switch from progressive files to live RTSP without the web app changing.
 *
 * ── The rules this service enforces ──────────────────────────────────────────────────────────
 *
 * The organisers give each client its own copy of a stream, so consumption is a cost we impose on
 * shared infrastructure. Three guards, all here rather than scattered:
 *
 *   • LAZY   — nothing is pulled until something subscribes (POST /subscribe).
 *   • BOUNDED — at most LIVE_PULL_MAX cameras are pulled at once; the (LIVE_PULL_MAX+1)th
 *               subscribe is refused with 429 rather than quietly opening another connection.
 *   • RELEASED — a subscriber that leaves starts a 60 s idle timer; the upstream closes after it.
 *
 * The gateway is consume-only. It never publishes to the organisers' server and never calls their
 * control API.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadCamerasConfig, type CameraConfigEntry } from './config.js';
import { admitPull, type PullSlot } from './live/pull-budget.js';
import { FfmpegPublisher } from './publisher.js';
import {
  describeSlot,
  isTimeShifted,
  now,
  playbackPositionSeconds,
  recordedAtMs,
  slotTimeMs,
  secondsUntilSlotRollover,
} from './slot.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');

const PORT = Number(process.env.STREAM_GATEWAY_PORT ?? 4001);
const CAMERAS_CONFIG = process.env.CAMERAS_CONFIG ?? resolve(ROOT, 'config/cameras.yaml');

/**
 * Hard ceiling on concurrent upstream pulls. Not a performance tuning knob — a politeness limit.
 * Each pull is a separate copy of a stream on infrastructure shared with every other team.
 */
const LIVE_PULL_MAX = Number(process.env.LIVE_PULL_MAX ?? 5);

const MEDIAMTX_RTSP_HOST = process.env.MEDIAMTX_RTSP_HOST ?? '127.0.0.1';
const MEDIAMTX_RTSP_PORT = Number(process.env.MEDIAMTX_RTSP_PORT ?? 8554);
const MEDIAMTX_WEBRTC_URL = process.env.NEXT_PUBLIC_WEBRTC_BASE_URL ?? 'http://localhost:8889';
const UPSTREAM_BASE = process.env.SENTINEL_BASE ?? 'https://live.corp8.cloud';
const IDLE_TIMEOUT_MS = Number(process.env.UPSTREAM_IDLE_TIMEOUT_S ?? 60) * 1000;

const publisher = new FfmpegPublisher({
  upstreamBase: UPSTREAM_BASE,
  rtspHost: MEDIAMTX_RTSP_HOST,
  rtspPort: MEDIAMTX_RTSP_PORT,
  idleTimeoutMs: IDLE_TIMEOUT_MS,
});

let cameras: CameraConfigEntry[] = [];
let loadedAt = 0;

async function catalogue(): Promise<CameraConfigEntry[]> {
  // Registry polling is capped at 60 s by policy; re-reading a local file more often than that is
  // pointless anyway.
  if (cameras.length === 0 || Date.now() - loadedAt > 60_000) {
    cameras = (await loadCamerasConfig(CAMERAS_CONFIG)).cameras;
    loadedAt = Date.now();
  }
  return cameras;
}

/** Look up by internal key, portal id, or label — callers should not have to care which. */
async function findCamera(key: string): Promise<CameraConfigEntry | undefined> {
  const all = await catalogue();
  return all.find((c) => c.id === key || c.portalId === key || c.label === key);
}

/**
 * The uniform contract. Every source type answers these four questions the same way, which is why
 * a change of upstream protocol does not reach the web app.
 */
function endpointsFor(camera: CameraConfigEntry) {
  const path = `cam/${encodeURIComponent(camera.id)}`;
  return {
    // What the browser plays: WHEP from OUR MediaMTX, never the organisers' directly.
    browserUrl: `${MEDIAMTX_WEBRTC_URL.replace(/\/$/, '')}/${path}/whep`,
    // What analytics opens: RTSP from OUR MediaMTX, over TCP.
    analyticsUrl: publisher.rtspUrl(camera.id),
    snapshotUrl: `/cameras/${camera.id}/snapshot`,
    healthUrl: `/cameras/${camera.id}/health`,
    // Upstream, for reference only. Stored from /api/ingest, never constructed.
    upstream: {
      rtsp: camera.rtspUrl,
      webrtc: camera.webrtcUrl,
      hls: camera.hlsUrl,
      note: 'consume-only; the gateway never publishes to these',
    },
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

/**
 * Cameras holding an upstream connection right now.
 *
 * Deliberately NOT "cameras with subscribers": `release()` drops the subscriber count to zero but
 * leaves ffmpeg connected for the idle window, so a camera still holding a connection is still
 * spending a slot. The policy that consumes this lives in live/pull-budget.ts.
 */
function activePulls(): PullSlot[] {
  return publisher
    .allStates()
    .filter((s) => s.subscribers > 0 || publisher.isPublishing(s.cameraId))
    .map((s) => ({
      cameraId: s.cameraId,
      subscribers: s.subscribers,
      draining: s.subscribers === 0,
    }));
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const path = url.pathname.replace(/\/$/, '') || '/';

  if (path === '/health') {
    const t = now();
    return json(res, 200, {
      ok: true,
      slot: describeSlot(t),
      hoursUntilRollover: Number((secondsUntilSlotRollover(t) / 3600).toFixed(2)),
      timeShifted: isTimeShifted(),
      activePulls: activePulls(),
      livePullMax: LIVE_PULL_MAX,
      upstream: UPSTREAM_BASE,
    });
  }

  if (path === '/cameras') {
    const all = await catalogue();
    return json(res, 200, {
      count: all.length,
      cameras: all.map((c) => ({
        id: c.id,
        portalId: c.portalId,
        label: c.label,
        name: c.name,
        district: c.district,
        status: c.status,
        statusSource: c.statusSource,
        locationStatus: c.locationStatus,
        subscribers: publisher.subscriberCount(c.id),
      })),
    });
  }

  const cameraMatch = /^\/cameras\/([^/]+)(?:\/(urls|health|snapshot|time))?$/.exec(path);
  if (cameraMatch) {
    const camera = await findCamera(decodeURIComponent(cameraMatch[1]!));
    if (!camera) return json(res, 404, { error: 'camera not found' });
    const action = cameraMatch[2] ?? 'urls';

    if (action === 'urls') return json(res, 200, { id: camera.id, ...endpointsFor(camera) });

    if (action === 'health') {
      const state = publisher.state(camera.id);
      return json(res, 200, {
        id: camera.id,
        label: camera.label,
        // What the registry believes, and where that belief came from.
        registryStatus: camera.status,
        statusSource: camera.statusSource,
        lastError: camera.lastError,
        // What the pull is actually doing right now.
        pull: {
          publishing: publisher.isPublishing(camera.id),
          subscribers: state.subscribers,
          status: state.status,
          fps: state.fps,
          driftSeconds: state.driftSeconds,
          reseeks: state.reseeks,
          restarts: state.restarts,
          detail: state.detail,
        },
      });
    }

    if (action === 'time') {
      // Both time bases, so a caller can never accidentally use the wrong one.
      //
      // The drift correction lives in the `time_sync` table, which this service does not read.
      // Rather than quietly return an uncorrected number under a corrected-sounding name, the
      // correction is reported as absent. A caller that needs forensic accuracy must apply the
      // camera's drift model itself — see recordedAtMs(position, driftModel).
      const position = playbackPositionSeconds({ durationSeconds: camera.durationSeconds });
      return json(res, 200, {
        id: camera.id,
        positionSeconds: Number(position.toFixed(3)),
        recordedAtUncorrected: new Date(recordedAtMs(position, 0)).toISOString(),
        slotTime: new Date(slotTimeMs(position)).toISOString(),
        driftCorrectionApplied: false,
        note:
          'recordedAtUncorrected omits this camera\'s clock offset. Do not use it for ' +
          'cross-camera correlation; apply the drift model from time_sync first.',
      });
    }

    if (action === 'snapshot') {
      // Snapshots come from our MediaMTX, so the organisers see no extra connection.
      return json(res, 501, {
        error: 'not implemented',
        hint: `fetch ${MEDIAMTX_WEBRTC_URL}/cam/${camera.id}/frame.jpeg once a pull is active`,
      });
    }
  }

  if (path === '/subscribe' && req.method === 'POST') {
    const body = await readBody(req);
    const camera = await findCamera(String(body.camera ?? ''));
    if (!camera) return json(res, 404, { error: 'camera not found' });

    // The politeness ceiling. Refusing loudly beats opening a sixth copy of someone else's stream.
    const active = activePulls();
    const decision = admitPull(camera.id, active, LIVE_PULL_MAX);
    if (!decision.admit) {
      return json(res, 429, {
        error: 'live pull limit reached',
        livePullMax: LIVE_PULL_MAX,
        activePulls: active,
        hint: decision.drainingSoon.length
          ? `slots free automatically once these finish draining: ${decision.drainingSoon.join(', ')}`
          : 'release a camera before subscribing to another',
      });
    }

    await publisher.acquire(camera);
    return json(res, 200, {
      id: camera.id,
      subscribers: publisher.subscriberCount(camera.id),
      ...endpointsFor(camera),
    });
  }

  if (path === '/release' && req.method === 'POST') {
    const body = await readBody(req);
    const camera = await findCamera(String(body.camera ?? ''));
    if (!camera) return json(res, 404, { error: 'camera not found' });
    publisher.release(camera.id);
    return json(res, 200, {
      id: camera.id,
      subscribers: publisher.subscriberCount(camera.id),
      note: `upstream closes ${IDLE_TIMEOUT_MS / 1000}s after the last subscriber leaves`,
    });
  }

  json(res, 404, {
    error: 'not found',
    routes: [
      'GET  /health',
      'GET  /cameras',
      'GET  /cameras/:id/urls',
      'GET  /cameras/:id/health',
      'GET  /cameras/:id/time',
      'POST /subscribe  {"camera":"10"}',
      'POST /release    {"camera":"10"}',
    ],
  });
}

const server = createServer((req, res) => {
  void handle(req, res).catch((err) => {
    if (!res.headersSent) json(res, 500, { error: String(err) });
  });
});

server.listen(PORT, () => {
  console.error(`stream-gateway on http://127.0.0.1:${PORT}`);
  console.error(`  upstream      : ${UPSTREAM_BASE} (consume-only)`);
  console.error(`  live pull max : ${LIVE_PULL_MAX}`);
  console.error(`  idle timeout  : ${IDLE_TIMEOUT_MS / 1000}s`);
  console.error(`  catalogue     : ${CAMERAS_CONFIG}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.error('\nshutting down — releasing all upstream pulls');
    void publisher.stopAll().then(() => server.close(() => process.exit(0)));
  });
}
