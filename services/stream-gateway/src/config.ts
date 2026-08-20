/**
 * Loads config/cameras.yaml into the adapter layer's CameraSource shape.
 *
 * The YAML is the human-editable registry seed; the database is the runtime source of truth. This
 * loader is what bridges them, and it is deliberately strict: a malformed camera row fails loudly
 * at startup rather than silently producing a tile that will never play.
 */
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';

import type { CameraSource, SourceType } from './adapters/types.js';

export type GeoConfidence = 'high' | 'approx' | 'geocode';

export interface CameraConfigEntry extends CameraSource {
  label: string;
  labelNumber: number | null;
  district: string | null;
  /** Always 'unassigned' for the Sentinel feeds — the portal exposes no department field. */
  department: string;
  departmentGuess: string | null;
  lat: number | null;
  lng: number | null;
  geoConfidence: GeoConfidence;
  cluster: string | null;
  notes: string | null;
}

export interface CamerasConfig {
  meta: {
    source: string;
    streamPath: string;
    slotSeconds: number;
    slotBoundariesIst: string[];
    timezone: string;
    loop: boolean;
    cameraCount: number;
    discoveredAt: string;
  };
  cameras: CameraConfigEntry[];
}

const VALID_SOURCE_TYPES: ReadonlySet<string> = new Set<SourceType>([
  'MP4_PROGRESSIVE', 'RTSP', 'HLS', 'MJPEG', 'FILE_LOOP', 'ONVIF_STUB', 'VMS_SDK_STUB',
]);

const VALID_GEO: ReadonlySet<string> = new Set(['high', 'approx', 'geocode']);

function req<T>(value: T | undefined | null, field: string, id: unknown): T {
  if (value === undefined || value === null) {
    throw new Error(`camera ${String(id)}: missing required field "${field}"`);
  }
  return value;
}

export async function loadCamerasConfig(path: string): Promise<CamerasConfig> {
  const raw = parse(await readFile(path, 'utf8')) as Record<string, any>;
  if (!raw?.cameras || !Array.isArray(raw.cameras)) {
    throw new Error(`${path}: expected a top-level "cameras" list`);
  }

  const defaults = raw.defaults ?? {};
  const seen = new Set<string>();

  const cameras: CameraConfigEntry[] = raw.cameras.map((c: Record<string, any>) => {
    const id = String(req(c.portal_id, 'portal_id', c.label));
    if (seen.has(id)) throw new Error(`duplicate portal_id "${id}" in ${path}`);
    seen.add(id);

    const sourceType = String(c.source_type ?? defaults.source_type ?? '');
    if (!VALID_SOURCE_TYPES.has(sourceType)) {
      throw new Error(`camera ${id}: unknown source_type "${sourceType}"`);
    }

    const geoConfidence = String(c.geo_confidence ?? 'geocode');
    if (!VALID_GEO.has(geoConfidence)) {
      throw new Error(`camera ${id}: unknown geo_confidence "${geoConfidence}"`);
    }

    // A coordinate is either fully present or fully absent; half a point is a bug, not a location.
    const hasLat = c.lat !== null && c.lat !== undefined;
    const hasLng = c.lng !== null && c.lng !== undefined;
    if (hasLat !== hasLng) {
      throw new Error(`camera ${id}: lat and lng must both be set or both be null`);
    }
    if (hasLat && geoConfidence === 'geocode') {
      throw new Error(`camera ${id}: has coordinates but is still flagged geo_confidence=geocode`);
    }
    if (!hasLat && geoConfidence !== 'geocode') {
      throw new Error(`camera ${id}: no coordinates, so geo_confidence must be "geocode"`);
    }

    return {
      id,
      name: String(c.name ?? c.label ?? `Camera ${id}`),
      label: String(req(c.label, 'label', id)),
      labelNumber: c.label_number ?? null,
      sourceType: sourceType as SourceType,
      sourceUrl: String(req(c.source_url, 'source_url', id)),
      durationSeconds: c.duration_seconds ?? null,
      codec: c.codec ?? null,
      container: c.container ?? null,
      district: c.district ?? null,
      department: String(c.department ?? defaults.department ?? 'unassigned'),
      departmentGuess: c.department_guess ?? null,
      lat: hasLat ? Number(c.lat) : null,
      lng: hasLng ? Number(c.lng) : null,
      geoConfidence: geoConfidence as GeoConfidence,
      cluster: c.cluster ?? null,
      notes: c.notes ?? null,
    };
  });

  const meta = raw.meta ?? {};
  return {
    meta: {
      source: String(meta.source ?? ''),
      streamPath: String(meta.stream_path ?? '/stream/{id}'),
      slotSeconds: Number(meta.slot_seconds ?? 43200),
      slotBoundariesIst: meta.slot_boundaries_ist ?? ['09:00:00', '21:00:00'],
      timezone: String(meta.timezone ?? 'Asia/Kolkata'),
      loop: Boolean(meta.loop ?? true),
      cameraCount: Number(meta.camera_count ?? cameras.length),
      discoveredAt: String(meta.discovered_at ?? ''),
    },
    cameras,
  };
}

/** Cameras whose position is still unresolved. The map renders these differently. */
export function unlocatedCameras(cfg: CamerasConfig): CameraConfigEntry[] {
  return cfg.cameras.filter((c) => c.geoConfidence === 'geocode');
}
