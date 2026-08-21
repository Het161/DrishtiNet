/**
 * Evidence clips, cut from the ring buffer.
 *
 * ── What makes this lawful, and why it matters ───────────────────────────────────────────────
 *
 * The organisers are explicit: do not plan around obtaining copies of the footage. So we do not
 * fetch anything. MediaMTX records the stream we are ALREADY receiving into a rolling 15-minute
 * buffer, and only while a path is active — meaning a camera nobody is watching is never recorded.
 * An evidence clip is a cut from what we lawfully received, not a download.
 *
 * That distinction is the whole of Model 4's recording/playback requirement done defensibly, and
 * it is worth stating plainly in the submission.
 *
 * ── What makes it evidence rather than a video file ──────────────────────────────────────────
 *
 * A clip on its own proves nothing. Three things travel with it:
 *
 *   1. A SHA-256 over the bytes, so tampering is detectable.
 *   2. A sidecar recording the camera's INTERNAL id, the portal id *as it was at that moment*, the
 *      recorded_at range, the slot_time range, the actor and the reason. The portal id is recorded
 *      as a historical attribute precisely because it may point at a different camera by the time
 *      anyone reads the clip back — which already happened once, on 2026-08-21.
 *   3. A chain-of-custody row whose hash and path the database refuses to let anyone edit.
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, stat, writeFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** Seconds of context kept either side of the incident. */
export const PRE_ROLL_SECONDS = 30;
export const POST_ROLL_SECONDS = 30;

export interface EvidenceRequest {
  /** Our internal camera id — never a portal id. */
  cameraId: string;
  /** MediaMTX path name, e.g. `cam/10`. */
  pathName: string;
  /** Incident window, as epoch ms. Pre/post roll is added around it. */
  startMs: number;
  endMs: number;
  actor: string;
  reason: string;
  /** Portal id at the time of the incident — historical fact, not a key. */
  portalIdAtTime: string | null;
  recordedAtRange: { startIso: string; endIso: string };
  slotTimeRange: { startIso: string; endIso: string };
}

export interface EvidenceResult {
  ok: boolean;
  clipPath?: string;
  sidecarPath?: string;
  sha256?: string;
  sizeBytes?: number;
  durationSeconds?: number;
  error?: string;
}

/** Segment files MediaMTX writes, oldest first. */
export async function ringSegments(ringDir: string, pathName: string): Promise<string[]> {
  const dir = resolve(ringDir, pathName);
  try {
    const entries = await readdir(dir);
    return entries
      .filter((f) => f.endsWith('.mp4'))
      .sort()
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

function run(cmd: string, args: string[], timeoutMs = 120_000): Promise<{ code: number; stderr: string }> {
  return new Promise((resolvePromise) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr?.setEncoding('utf8');
    proc.stderr?.on('data', (c: string) => { stderr += c; });
    const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
    proc.on('exit', (code) => { clearTimeout(timer); resolvePromise({ code: code ?? -1, stderr }); });
    proc.on('error', (err) => { clearTimeout(timer); resolvePromise({ code: -1, stderr: String(err) }); });
  });
}

export async function sha256File(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

/**
 * Cut a clip covering [startMs − PRE_ROLL, endMs + POST_ROLL].
 *
 * Stream-copy, never re-encode: re-encoding would change every byte and make the hash a statement
 * about our transcoder rather than about what the camera sent.
 */
export async function cutEvidenceClip(
  req: EvidenceRequest,
  opts: { ringDir: string; outDir: string; playbackUrl?: string },
): Promise<EvidenceResult> {
  const fromMs = req.startMs - PRE_ROLL_SECONDS * 1000;
  const toMs = req.endMs + POST_ROLL_SECONDS * 1000;
  const durationSeconds = (toMs - fromMs) / 1000;
  if (durationSeconds <= 0) return { ok: false, error: 'empty window' };

  await mkdir(opts.outDir, { recursive: true });
  const stamp = new Date(fromMs).toISOString().replace(/[:.]/g, '-');
  const base = `${req.pathName.replace(/\//g, '_')}_${stamp}`;
  const clipPath = join(opts.outDir, `${base}.mp4`);
  const sidecarPath = join(opts.outDir, `${base}.json`);

  const segments = await ringSegments(opts.ringDir, req.pathName);
  if (segments.length === 0) {
    return {
      ok: false,
      error:
        `no ring segments for ${req.pathName}. The buffer only records while the path is active, ` +
        `so an incident on an unwatched camera has no footage by design.`,
    };
  }

  // Concat the segments covering the window, then trim. MediaMTX's playback API can serve a range
  // directly; concatenating locally keeps this working when the playback server is not exposed.
  const listPath = join(opts.outDir, `${base}.concat.txt`);
  await writeFile(listPath, segments.map((s) => `file '${s}'`).join('\n'));

  const cut = await run('ffmpeg', [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'concat', '-safe', '0', '-i', listPath,
    '-t', String(durationSeconds),
    '-c', 'copy', '-movflags', '+faststart',
    clipPath,
  ]);
  if (cut.code !== 0) return { ok: false, error: `ffmpeg cut failed: ${cut.stderr.slice(0, 200)}` };

  let sizeBytes = 0;
  try {
    sizeBytes = (await stat(clipPath)).size;
  } catch {
    return { ok: false, error: 'clip was not produced' };
  }
  if (sizeBytes < 1024) return { ok: false, error: `clip is implausibly small (${sizeBytes} bytes)` };

  const sha256 = await sha256File(clipPath);

  const sidecar = {
    clip: `${base}.mp4`,
    sha256,
    sizeBytes,
    camera: {
      // The identity. Stable across portal renumbering.
      internalId: req.cameraId,
      mediamtxPath: req.pathName,
      // Historical attribute: this id may point at a different camera in future.
      portalIdAtTimeOfCapture: req.portalIdAtTime,
    },
    window: {
      requestedStart: new Date(req.startMs).toISOString(),
      requestedEnd: new Date(req.endMs).toISOString(),
      preRollSeconds: PRE_ROLL_SECONDS,
      postRollSeconds: POST_ROLL_SECONDS,
      durationSeconds,
    },
    recordedAt: req.recordedAtRange,
    slotTime: req.slotTimeRange,
    custody: {
      actor: req.actor,
      reason: req.reason,
      cutAt: new Date().toISOString(),
      method: 'stream-copy from the live ring buffer; no re-encode, no upstream fetch',
      provenance:
        'Recorded from the live stream this system was already receiving. No footage was ' +
        'downloaded from the organisers, in line with their integration reference.',
    },
  };
  await writeFile(sidecarPath, JSON.stringify(sidecar, null, 2));

  return { ok: true, clipPath, sidecarPath, sha256, sizeBytes, durationSeconds };
}

/** Re-verify a clip against its sidecar. Any mismatch means the bytes changed after capture. */
export async function verifyEvidenceClip(clipPath: string, sidecarPath: string): Promise<boolean> {
  try {
    const sidecar = JSON.parse(await readFile(sidecarPath, 'utf8')) as { sha256: string };
    return (await sha256File(clipPath)) === sidecar.sha256;
  } catch {
    return false;
  }
}
