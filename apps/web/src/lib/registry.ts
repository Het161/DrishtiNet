/**
 * Server-side registry queries for the GIS view.
 *
 * The shape returned here is what the map and the table both consume, so a camera's honesty
 * markers (`locationStatus`, `statusSource`, `departmentLabel`) travel with it rather than being
 * re-derived in two places and eventually disagreeing.
 */
import 'server-only';

import { prisma, listCameraPoints, registrySummary, coverageByDistrict } from '@drishtinet/db';

/** District centroids for cameras with no verified position. */
import { DISTRICT_CENTROIDS, GUJARAT_CENTROID } from './districts';

export interface RegistryCamera {
  id: string;
  portalId: string;
  name: string;
  label: string;
  district: string | null;
  cluster: string | null;
  /** Where to draw it. Never null — falls back to a district centroid. */
  lat: number;
  lng: number;
  /** True when lat/lng is a district centroid rather than the camera's own position. */
  positionIsFallback: boolean;
  locationStatus: 'verified' | 'approximate' | 'unverified';
  locationUncertaintyM: number;
  status: 'online' | 'degraded' | 'offline';
  statusSource: 'measured' | 'portal_claim';
  lastError: string | null;
  departmentLabel: string | null;
  sourceType: string | null;
  isLocalMirror: boolean;
  width: number | null;
  height: number | null;
  fps: number | null;
}

export interface RegistryData {
  cameras: RegistryCamera[];
  summary: {
    total: number;
    online: number;
    degraded: number;
    offline: number;
    statusUnverified: number;
    locationUnverified: number;
    departmentUnassigned: number;
    districtsCovered: number;
  };
  coverage: {
    district: string;
    total: number;
    online: number;
    degraded: number;
    offline: number;
    locationUnverified: number;
    departmentUnassigned: number;
  }[];
}

const n = (v: bigint | number): number => (typeof v === 'bigint' ? Number(v) : v);

export async function getRegistry(): Promise<RegistryData> {
  const [points, summary, coverage, streams, departments] = await Promise.all([
    listCameraPoints(prisma),
    registrySummary(prisma),
    coverageByDistrict(prisma),
    prisma.stream.findMany({
      select: {
        cameraId: true, sourceType: true, isLocalMirror: true,
        width: true, height: true, fps: true,
      },
    }),
    prisma.department.findMany({ select: { id: true, name: true } }),
  ]);

  const streamByCamera = new Map(streams.map((s) => [s.cameraId, s]));
  const deptById = new Map(departments.map((d) => [d.id, d.name]));

  const cameras: RegistryCamera[] = points.map((p) => {
    const stream = streamByCamera.get(p.id);

    // A camera with no verified position still has to appear somewhere, or the registry would
    // silently hide the very gaps it is meant to report. We place it at its district centroid and
    // mark it — the map draws it hollow with an uncertainty circle.
    const hasOwnPosition = p.lat !== null && p.lng !== null;
    const fallback =
      (p.district ? DISTRICT_CENTROIDS[p.district] : undefined) ?? GUJARAT_CENTROID;

    return {
      id: p.id,
      portalId: p.portalId,
      name: p.name,
      label: p.name,
      district: p.district,
      cluster: p.cluster,
      lat: hasOwnPosition ? p.lat! : fallback.lat,
      lng: hasOwnPosition ? p.lng! : fallback.lng,
      positionIsFallback: !hasOwnPosition,
      locationStatus: p.locationStatus,
      locationUncertaintyM: p.locationUncertaintyM,
      status: p.status,
      statusSource: p.statusSource,
      lastError: p.lastError,
      departmentLabel: p.departmentId ? (deptById.get(p.departmentId) ?? null) : null,
      sourceType: stream?.sourceType ?? null,
      isLocalMirror: stream?.isLocalMirror ?? false,
      width: stream?.width ?? null,
      height: stream?.height ?? null,
      fps: stream?.fps ?? null,
    };
  });

  return {
    cameras,
    summary: {
      total: n(summary.cameras_total),
      online: n(summary.online),
      degraded: n(summary.degraded),
      offline: n(summary.offline),
      statusUnverified: n(summary.status_unverified),
      locationUnverified: n(summary.location_unverified),
      departmentUnassigned: n(summary.department_unassigned),
      districtsCovered: n(summary.districts_covered),
    },
    coverage: coverage.map((c) => ({
      district: c.district,
      total: n(c.cameras_total),
      online: n(c.cameras_online),
      degraded: n(c.cameras_degraded),
      offline: n(c.cameras_offline),
      locationUnverified: n(c.location_unverified),
      departmentUnassigned: n(c.department_unassigned),
    })),
  };
}
