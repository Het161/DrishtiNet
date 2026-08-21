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

/**
 * How much we actually know about where a camera is.
 *   verified    — an identifiable junction; draw a confident marker
 *   approximate — right town/area, junction position estimated
 *   unverified  — district centroid only; draw a hollow marker + uncertainty circle
 */
export type LocationStatus = 'verified' | 'approximate' | 'unverified';

/** Measured availability. Distinct from what the portal claims — see `statusSource`. */
export type CameraStatus = 'online' | 'degraded' | 'offline';

/**
 * Whether `status` reflects our own probe or merely the portal's assertion.
 * This distinction is not pedantry: `/api/cameras` reports camera 6 as `"live"` while its media
 * endpoint returns HTTP 500. A registry that repeats an upstream claim as though it had checked is
 * exactly the kind of thing an SCRB evaluator should not have to catch for us.
 */
export type StatusSource = 'measured' | 'portal_claim';

export interface CameraConfigEntry extends CameraSource {
  label: string;
  labelNumber: number | null;
  district: string | null;
  /** Always 'unassigned' for the Sentinel feeds — the portal exposes no department field. */
  department: string;
  departmentGuess: string | null;
  lat: number | null;
  lng: number | null;
  locationStatus: LocationStatus;
  /** Radius in metres the map draws around the marker. Always set. */
  locationUncertaintyM: number;
  /** Why that radius — shown to the operator so the number is auditable. */
  locationBasis: string | null;
  status: CameraStatus;
  statusSource: StatusSource;
  lastError: string | null;
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

const VALID_LOCATION_STATUS: ReadonlySet<string> = new Set([
  'verified', 'approximate', 'unverified',
]);
const VALID_STATUS: ReadonlySet<string> = new Set(['online', 'degraded', 'offline']);
const VALID_STATUS_SOURCE: ReadonlySet<string> = new Set(['measured', 'portal_claim']);

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

    const locationStatus = String(c.location_status ?? defaults.location_status ?? 'unverified');
    if (!VALID_LOCATION_STATUS.has(locationStatus)) {
      throw new Error(`camera ${id}: unknown location_status "${locationStatus}"`);
    }

    const status = String(c.status ?? defaults.status ?? 'online');
    if (!VALID_STATUS.has(status)) {
      throw new Error(`camera ${id}: unknown status "${status}"`);
    }

    const statusSource = String(c.status_source ?? 'portal_claim');
    if (!VALID_STATUS_SOURCE.has(statusSource)) {
      throw new Error(`camera ${id}: unknown status_source "${statusSource}"`);
    }

    const uncertainty = c.location_uncertainty_m;
    if (typeof uncertainty !== 'number' || !Number.isFinite(uncertainty) || uncertainty < 0) {
      throw new Error(`camera ${id}: location_uncertainty_m must be a non-negative number`);
    }

    // A coordinate is either fully present or fully absent; half a point is a bug, not a location.
    const hasLat = c.lat !== null && c.lat !== undefined;
    const hasLng = c.lng !== null && c.lng !== undefined;
    if (hasLat !== hasLng) {
      throw new Error(`camera ${id}: lat and lng must both be set or both be null`);
    }
    if (hasLat && locationStatus === 'unverified') {
      throw new Error(`camera ${id}: has coordinates but is flagged location_status=unverified`);
    }
    if (!hasLat && locationStatus !== 'unverified') {
      throw new Error(`camera ${id}: no coordinates, so location_status must be "unverified"`);
    }
    // An offline camera must say why. Silent unavailability is unactionable for an operator.
    if (status !== 'online' && !c.last_error) {
      throw new Error(`camera ${id}: status "${status}" requires a last_error explaining it`);
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
      locationStatus: locationStatus as LocationStatus,
      locationUncertaintyM: uncertainty,
      locationBasis: c.location_basis ?? null,
      status: status as CameraStatus,
      statusSource: statusSource as StatusSource,
      lastError: c.last_error ?? null,
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

/** Cameras whose position is still unresolved. The map renders these as hollow + uncertainty circle. */
export function unlocatedCameras(cfg: CamerasConfig): CameraConfigEntry[] {
  return cfg.cameras.filter((c) => c.locationStatus === 'unverified');
}
