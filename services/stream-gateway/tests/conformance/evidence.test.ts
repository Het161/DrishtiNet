import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { rm, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  cutEvidenceClip,
  verifyEvidenceClip,
  ringSegments,
  sha256File,
  PRE_ROLL_SECONDS,
  POST_ROLL_SECONDS,
} from '../../src/live/evidence.js';

/**
 * Evidence clips must be cut from footage we already received, and must be verifiable afterwards.
 * These run against the ring buffer the self-test grid is filling.
 */
const ROOT = resolve(import.meta.dirname, '../../../..');
const RING = resolve(ROOT, 'data/ring');
const OUT = resolve(ROOT, '.cache/scratch/evidence');

let haveSegments = false;

beforeAll(async () => {
  haveSegments = (await ringSegments(RING, 'stream/sane')).length > 0;
  if (!haveSegments) {
    console.warn('\n  no ring segments — start the grid with `make selftest-up` and wait ~30s\n');
  }
  await rm(OUT, { recursive: true, force: true });
});

function request(overrides: Partial<Parameters<typeof cutEvidenceClip>[0]> = {}) {
  const now = Date.now();
  return {
    cameraId: 'cmt1testinternalid000000',
    pathName: 'stream/sane',
    startMs: now - 20_000,
    endMs: now - 10_000,
    actor: 'e2e',
    reason: 'conformance test',
    portalIdAtTime: '10',
    recordedAtRange: { startIso: new Date(now - 20_000).toISOString(), endIso: new Date(now - 10_000).toISOString() },
    slotTimeRange: { startIso: new Date(now - 20_000).toISOString(), endIso: new Date(now - 10_000).toISOString() },
    ...overrides,
  };
}

describe('evidence ring buffer', () => {
  it('records segments only for active paths', async () => {
    if (!haveSegments) return;
    const active = await ringSegments(RING, 'stream/sane');
    expect(active.length).toBeGreaterThan(0);
    // A path nobody publishes has no footage — the lazy policy made structural.
    const inactive = await ringSegments(RING, 'stream/does-not-exist');
    expect(inactive).toHaveLength(0);
  });

  it('cuts a clip that exists, decodes, and covers the window', async () => {
    if (!haveSegments) return;
    const res = await cutEvidenceClip(request(), { ringDir: RING, outDir: OUT });
    expect(res.error).toBeUndefined();
    expect(res.ok).toBe(true);
    expect(res.sizeBytes!).toBeGreaterThan(1024);

    // It must actually decode — a file that exists but will not open is not evidence.
    const probe = spawnSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', res.clipPath!,
    ], { encoding: 'utf8', timeout: 60_000 });
    expect(probe.status).toBe(0);
    const duration = Number(probe.stdout.trim());
    expect(duration).toBeGreaterThan(0);

    // Pre- and post-roll are included around the incident.
    expect(res.durationSeconds).toBe(10 + PRE_ROLL_SECONDS + POST_ROLL_SECONDS);
  }, 120_000);

  it('hashes the clip and the hash verifies', async () => {
    if (!haveSegments) return;
    const res = await cutEvidenceClip(request(), { ringDir: RING, outDir: OUT });
    expect(res.ok).toBe(true);
    expect(res.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyEvidenceClip(res.clipPath!, res.sidecarPath!)).toBe(true);
    // The hash is over the bytes, so it must match an independent computation.
    expect(await sha256File(res.clipPath!)).toBe(res.sha256);
  }, 120_000);

  it('records the portal id as a historical attribute, not as identity', async () => {
    if (!haveSegments) return;
    const res = await cutEvidenceClip(request({ portalIdAtTime: '22' }), { ringDir: RING, outDir: OUT });
    const sidecar = JSON.parse(await readFile(res.sidecarPath!, 'utf8'));
    expect(sidecar.camera.internalId).toBe('cmt1testinternalid000000');
    expect(sidecar.camera.portalIdAtTimeOfCapture).toBe('22');
    // Both time bases travel with the clip.
    expect(sidecar.recordedAt.startIso).toBeTruthy();
    expect(sidecar.slotTime.startIso).toBeTruthy();
    expect(sidecar.custody.actor).toBe('e2e');
  }, 120_000);

  it('refuses rather than inventing a clip when the camera was never watched', async () => {
    const res = await cutEvidenceClip(request({ pathName: 'stream/never-watched' }), {
      ringDir: RING, outDir: OUT,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no ring segments/);
  });

  it('detects tampering', async () => {
    if (!haveSegments) return;
    const res = await cutEvidenceClip(request(), { ringDir: RING, outDir: OUT });
    const { writeFile } = await import('node:fs/promises');
    const bytes = await readFile(res.clipPath!);
    const lastIndex = bytes.length - 1;
    bytes[lastIndex] = (bytes[lastIndex] ?? 0) ^ 0xff;   // flip one bit in the last byte
    await writeFile(res.clipPath!, bytes);
    expect(await verifyEvidenceClip(res.clipPath!, res.sidecarPath!)).toBe(false);
  }, 120_000);
});
