import 'server-only';

import { access } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * Are the PMTiles road archives actually on disk?
 *
 * Checked server-side rather than by letting the browser discover a 404: MapLibre reports a
 * missing vector source as a non-fatal error and simply renders nothing, which on a projector
 * looks identical to a working map over empty terrain. Better to know before we build the style
 * and fall back to district outlines deliberately.
 */
const ARCHIVES = ['gujarat-z10.pmtiles', 'junagadh-detail.pmtiles', 'corridor-detail.pmtiles'];

export async function hasPmtilesArchives(): Promise<boolean> {
  const dir = resolve(process.cwd(), 'public/map');
  try {
    await Promise.all(ARCHIVES.map((f) => access(resolve(dir, f))));
    return true;
  } catch {
    return false;
  }
}
