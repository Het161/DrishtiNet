/**
 * PostGIS access.
 *
 * Prisma cannot express `geography`, so `cameras.geom` is declared `Unsupported` and never appears
 * in a generated client query. Every spatial read and write goes through this module, which keeps
 * the raw SQL in one reviewable place instead of scattered through feature code.
 *
 * Coordinates are always (longitude, latitude) in that order, because that is what
 * `ST_MakePoint` and GeoJSON both use. Getting this backwards puts Gujarat in the Indian Ocean, so
 * the helpers below take named fields rather than a positional pair.
 */
import type { PrismaClient } from '@prisma/client';

export interface CameraPoint {
  id: string;
  portalId: string;
  name: string;
  district: string | null;
  cluster: string | null;
  lat: number | null;
  lng: number | null;
  locationStatus: 'verified' | 'approximate' | 'unverified';
  locationUncertaintyM: number;
  status: 'online' | 'degraded' | 'offline';
  statusSource: 'measured' | 'portal_claim';
  lastError: string | null;
  departmentId: string | null;
}

/**
 * Every camera with its coordinates decoded, for the map.
 *
 * Cameras with no verified position are returned with `lat`/`lng` null rather than being dropped —
 * the registry's job includes showing what it does not know.
 */
export async function listCameraPoints(prisma: PrismaClient): Promise<CameraPoint[]> {
  return prisma.$queryRaw<CameraPoint[]>`
    SELECT
      id,
      portal_id                AS "portalId",
      name,
      district,
      cluster,
      ST_Y(geom::geometry)     AS lat,
      ST_X(geom::geometry)     AS lng,
      location_status          AS "locationStatus",
      location_uncertainty_m   AS "locationUncertaintyM",
      status,
      status_source            AS "statusSource",
      last_error               AS "lastError",
      department_id            AS "departmentId"
    FROM cameras
    ORDER BY (geom IS NULL), portal_id::int`;
}

/** Set a camera's position. Pass null coordinates to clear it. */
export async function setCameraPosition(
  prisma: PrismaClient,
  cameraId: string,
  position: { lat: number; lng: number } | null,
): Promise<void> {
  if (position === null) {
    await prisma.$executeRaw`UPDATE cameras SET geom = NULL WHERE id = ${cameraId}`;
    return;
  }
  const { lat, lng } = position;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new Error(`refusing to store an out-of-range position: lat=${lat} lng=${lng}`);
  }
  await prisma.$executeRaw`
    UPDATE cameras
       SET geom = ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography
     WHERE id = ${cameraId}`;
}

export interface NearbyCamera {
  id: string;
  portalId: string;
  name: string;
  distanceM: number;
}

/**
 * Cameras within `radiusM` of a given camera, nearest first.
 *
 * This is the first half of route reconstruction: having seen a vehicle at camera A, which cameras
 * could plausibly see it next? `ST_DWithin` on `geography` uses metres and hits the GiST index.
 */
export async function camerasNear(
  prisma: PrismaClient,
  cameraId: string,
  radiusM: number,
): Promise<NearbyCamera[]> {
  return prisma.$queryRaw<NearbyCamera[]>`
    SELECT
      b.id,
      b.portal_id AS "portalId",
      b.name,
      ST_Distance(a.geom, b.geom) AS "distanceM"
    FROM cameras a
    JOIN cameras b
      ON b.id <> a.id
     AND b.geom IS NOT NULL
     AND ST_DWithin(a.geom, b.geom, ${radiusM})
    WHERE a.id = ${cameraId}
      AND a.geom IS NOT NULL
    ORDER BY "distanceM"`;
}

/**
 * Is a hop between two cameras physically plausible?
 *
 * The second half of route reconstruction. A "match" at two cameras 40 km apart 20 seconds apart is
 * not a route, it is two different vehicles — and presenting it as a route would be actively
 * misleading in an investigation.
 *
 * `CORRELATION_TOLERANCE_MS` (±15 s) is added because the source cameras' clocks disagree by up to
 * ~14 s; without it a genuinely simultaneous pair could be rejected as impossible.
 */
export interface HopPlausibility {
  plausible: boolean;
  distanceM: number;
  elapsedS: number;
  impliedSpeedKmh: number | null;
  reason: string;
}

export async function assessHop(
  prisma: PrismaClient,
  fromCameraId: string,
  toCameraId: string,
  elapsedSeconds: number,
  options: { maxSpeedKmh?: number; toleranceSeconds?: number } = {},
): Promise<HopPlausibility> {
  const maxSpeedKmh = options.maxSpeedKmh ?? 120;
  const toleranceS = options.toleranceSeconds ?? 15;

  const [row] = await prisma.$queryRaw<{ distanceM: number | null }[]>`
    SELECT ST_Distance(a.geom, b.geom) AS "distanceM"
      FROM cameras a, cameras b
     WHERE a.id = ${fromCameraId} AND b.id = ${toCameraId}`;

  const distanceM = row?.distanceM ?? null;
  if (distanceM === null) {
    return {
      plausible: false,
      distanceM: 0,
      elapsedS: elapsedSeconds,
      impliedSpeedKmh: null,
      reason: 'one or both cameras have no verified position',
    };
  }

  // Travelling backwards in time is never a hop.
  if (elapsedSeconds < -toleranceS) {
    return {
      plausible: false, distanceM, elapsedS: elapsedSeconds, impliedSpeedKmh: null,
      reason: 'second sighting precedes the first by more than the clock tolerance',
    };
  }

  // Give the vehicle the benefit of the clock spread before calling a hop impossible.
  const effectiveS = Math.max(elapsedSeconds + toleranceS, 0.001);
  const impliedSpeedKmh = (distanceM / effectiveS) * 3.6;

  return {
    plausible: impliedSpeedKmh <= maxSpeedKmh,
    distanceM,
    elapsedS: elapsedSeconds,
    impliedSpeedKmh,
    reason:
      impliedSpeedKmh <= maxSpeedKmh
        ? `implies ${impliedSpeedKmh.toFixed(1)} km/h`
        : `implies ${impliedSpeedKmh.toFixed(1)} km/h, above the ${maxSpeedKmh} km/h plausibility limit`,
  };
}

export interface CoverageRow {
  district: string;
  cameras_total: bigint;
  cameras_online: bigint;
  cameras_degraded: bigint;
  cameras_offline: bigint;
  status_measured: bigint;
  status_unverified: bigint;
  location_verified: bigint;
  location_approximate: bigint;
  location_unverified: bigint;
  department_unassigned: bigint;
  avg_uncertainty_m: number;
}

export async function coverageByDistrict(prisma: PrismaClient): Promise<CoverageRow[]> {
  return prisma.$queryRaw<CoverageRow[]>`SELECT * FROM gap_analysis_coverage`;
}

export interface RegistrySummary {
  cameras_total: bigint;
  online: bigint;
  degraded: bigint;
  offline: bigint;
  status_unverified: bigint;
  location_unverified: bigint;
  department_unassigned: bigint;
  districts_covered: bigint;
}

export async function registrySummary(prisma: PrismaClient): Promise<RegistrySummary> {
  const [row] = await prisma.$queryRaw<RegistrySummary[]>`SELECT * FROM gap_analysis_summary`;
  if (!row) throw new Error('gap_analysis_summary returned no rows');
  return row;
}
