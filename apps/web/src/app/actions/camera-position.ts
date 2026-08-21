'use server';

import { revalidatePath } from 'next/cache';

import { prisma, setCameraPosition } from '@drishtinet/db';

import { requirePermission } from '@/lib/auth';
import { isWithinGujarat } from '@/lib/placement';
import { isTimeShifted } from '@drishtinet/stream-gateway/slot';

/**
 * Set a camera's true position — the drag-to-place tool's server side.
 *
 * This is the only path that can produce a `verified` location. Everything else in the registry is
 * inference: a label that names a junction, a district centroid, a guess from a town name. A
 * verified row means a person looked at the map and said "the camera is *there*", and this action
 * records who they were, what the position was before, and when — because a coordinate on a police
 * GIS map with no provenance is exactly what the whole registry design is trying to avoid.
 */

export interface PlaceCameraResult {
  ok: boolean;
  error?: string;
}

export async function placeCamera(input: {
  cameraId: string;
  lat: number;
  lng: number;
  uncertaintyM: number;
  note?: string;
}): Promise<PlaceCameraResult> {
  let session;
  try {
    session = await requirePermission('camera:write');
  } catch {
    return { ok: false, error: 'You do not have permission to place cameras.' };
  }

  const { cameraId, lat, lng, uncertaintyM, note } = input;

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { ok: false, error: 'Position is not a valid coordinate.' };
  }
  if (!isWithinGujarat(lat, lng)) {
    return { ok: false, error: `Position ${lat.toFixed(4)}, ${lng.toFixed(4)} is outside Gujarat.` };
  }
  if (!Number.isFinite(uncertaintyM) || uncertaintyM < 0 || uncertaintyM > 500) {
    return { ok: false, error: 'Uncertainty must be between 0 and 500 metres.' };
  }

  const before = await prisma.camera.findUnique({
    where: { id: cameraId },
    select: {
      portalId: true, name: true, locationStatus: true,
      locationUncertaintyM: true, locationBasis: true,
    },
  });
  if (!before) return { ok: false, error: 'Camera not found.' };

  const previous = await prisma.$queryRaw<{ lat: number | null; lng: number | null }[]>`
    SELECT ST_Y(geom::geometry) AS lat, ST_X(geom::geometry) AS lng
      FROM cameras WHERE id = ${cameraId}`;

  await setCameraPosition(prisma, cameraId, { lat, lng });
  await prisma.camera.update({
    where: { id: cameraId },
    data: {
      locationStatus: 'verified',
      locationUncertaintyM: Math.round(uncertaintyM),
      locationBasis: note?.trim()
        ? `placed by operator: ${note.trim()}`
        : 'placed by operator on the map',
      locationSetBy: session.username,
      locationSetAt: new Date(),
    },
  });

  await prisma.auditLog.create({
    data: {
      actor: session.username,
      action: 'camera.position.set',
      entity: 'camera',
      entityId: cameraId,
      // Before AND after: an audit entry that only records the new value cannot answer
      // "what did this change?", which is the question an auditor actually asks.
      meta: {
        portalId: before.portalId,
        name: before.name,
        from: {
          lat: previous[0]?.lat ?? null,
          lng: previous[0]?.lng ?? null,
          locationStatus: before.locationStatus,
          uncertaintyM: before.locationUncertaintyM,
          basis: before.locationBasis,
        },
        to: { lat, lng, locationStatus: 'verified', uncertaintyM: Math.round(uncertaintyM) },
        note: note?.trim() || null,
      },
      timeShifted: isTimeShifted(),
    },
  });

  revalidatePath('/registry');
  return { ok: true };
}

/**
 * Undo a placement, returning the camera to unverified at district scale.
 * Also audited — reverting a position is as consequential as setting one.
 */
export async function clearCameraPosition(cameraId: string): Promise<PlaceCameraResult> {
  let session;
  try {
    session = await requirePermission('camera:write');
  } catch {
    return { ok: false, error: 'You do not have permission to place cameras.' };
  }

  const before = await prisma.camera.findUnique({
    where: { id: cameraId },
    select: { portalId: true, name: true, locationSetBy: true },
  });
  if (!before) return { ok: false, error: 'Camera not found.' };

  await setCameraPosition(prisma, cameraId, null);
  await prisma.camera.update({
    where: { id: cameraId },
    data: {
      locationStatus: 'unverified',
      locationUncertaintyM: 15000,
      locationBasis: 'position cleared — shown at district centroid',
      locationSetBy: null,
      locationSetAt: null,
    },
  });
  await prisma.auditLog.create({
    data: {
      actor: session.username,
      action: 'camera.position.cleared',
      entity: 'camera',
      entityId: cameraId,
      meta: { portalId: before.portalId, name: before.name, previouslySetBy: before.locationSetBy },
      timeShifted: isTimeShifted(),
    },
  });

  revalidatePath('/registry');
  return { ok: true };
}
