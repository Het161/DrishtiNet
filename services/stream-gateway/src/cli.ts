#!/usr/bin/env tsx
/**
 * Camera registry CLI.
 *
 * Exists so shell scripts and the Python analytics service never parse config/cameras.yaml
 * themselves. The loader in config.ts already validates every row (coordinate/confidence
 * coherence, known source types, unique ids); re-implementing that in bash with `yq` — which is
 * not installed on the demo laptop anyway — would guarantee the two parsers eventually disagree.
 *
 * Usage:
 *   tsx src/cli.ts list                 # human-readable table
 *   tsx src/cli.ts list --json          # full JSON
 *   tsx src/cli.ts list --tsv id,url    # id<TAB>url per line, for shell loops
 *   tsx src/cli.ts slot                 # current slot position, for sanity-checking the clock
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { loadCamerasConfig, unlocatedCameras, type CameraConfigEntry } from './config.js';
import { describeSlot, playbackPositionSeconds, secondsUntilSlotRollover, slotOffsetSeconds } from './slot.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = resolve(HERE, '../../../config/cameras.yaml');

function field(cam: CameraConfigEntry, name: string): string {
  const map: Record<string, unknown> = {
    id: cam.id,
    name: cam.name,
    label: cam.label,
    url: cam.sourceUrl,
    type: cam.sourceType,
    district: cam.district ?? '',
    department: cam.department,
    lat: cam.lat ?? '',
    lng: cam.lng ?? '',
    geo: cam.locationStatus,
    status: cam.status,
    uncertainty: String(cam.locationUncertaintyM),
    cluster: cam.cluster ?? '',
    duration: cam.durationSeconds ?? '',
    // Where "now" sits inside this camera's file. Falls back to the raw slot offset when we have
    // not probed the duration yet, which is correct because every measured file is ~12 h.
    position: playbackPositionSeconds({ durationSeconds: cam.durationSeconds }).toFixed(3),
  };
  if (!(name in map)) throw new Error(`unknown field "${name}"`);
  return String(map[name] ?? '');
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0] ?? 'list';
  const configPath = process.env.CAMERAS_CONFIG ?? DEFAULT_CONFIG;

  if (command === 'slot') {
    const now = Date.now();
    console.log(describeSlot(now));
    console.log(`slot_offset          ${slotOffsetSeconds(now).toFixed(3)} s`);
    console.log(`until next rollover  ${(secondsUntilSlotRollover(now) / 3600).toFixed(2)} h`);
    console.log(
      `position in a 12h file  ${playbackPositionSeconds({ durationSeconds: 43200, nowMs: now }).toFixed(1)} s`,
    );
    return 0;
  }

  if (command !== 'list') {
    console.error(`unknown command "${command}" (expected: list | slot)`);
    return 2;
  }

  const cfg = await loadCamerasConfig(configPath);

  if (argv.includes('--json')) {
    console.log(JSON.stringify(cfg, null, 2));
    return 0;
  }

  const tsvIdx = argv.indexOf('--tsv');
  if (tsvIdx !== -1) {
    const fields = (argv[tsvIdx + 1] ?? 'id,url').split(',');
    for (const cam of cfg.cameras) {
      console.log(fields.map((f) => field(cam, f.trim())).join('\t'));
    }
    return 0;
  }

  const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);
  console.log(`${cfg.cameras.length} cameras from ${configPath}`);
  console.log(`upstream: ${cfg.meta.source}  slot: ${cfg.meta.slotSeconds}s  tz: ${cfg.meta.timezone}`);
  console.log('');
  console.log(
    `${pad('id', 4)} ${pad('name', 32)} ${pad('district', 14)} ${pad('location', 12)} ${pad('cluster', 18)} url`,
  );
  for (const cam of cfg.cameras) {
    console.log(
      `${pad(cam.id, 4)} ${pad(cam.name, 32)} ${pad(cam.district ?? '—', 14)} ` +
        `${pad(cam.locationStatus, 12)} ${pad(cam.cluster ?? '—', 18)} ${cam.sourceUrl}`,
    );
  }

  const unlocated = unlocatedCameras(cfg);
  if (unlocated.length) {
    console.log('');
    console.log(
      `${unlocated.length} camera(s) still need a position: ${unlocated.map((c) => c.id).join(', ')}`,
    );
    console.log('  resolve with: python3 scripts/geocode.py   (requires internet, run manually)');
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
