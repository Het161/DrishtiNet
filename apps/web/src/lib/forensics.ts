/**
 * Forensic search over the live index.
 *
 * Every query here reads rows the analytics pipeline already wrote — never video. That is the whole
 * point of indexing continuously: an operator asking "where has this vehicle been" gets an answer in
 * milliseconds from Postgres, instead of waiting on a decode of footage that, on a live grid with no
 * seeking, could not be replayed anyway.
 *
 * The budget in CLAUDE.md is under 200 ms, and every function returns the time it actually took so
 * the interface can show the measurement rather than the aspiration.
 */
import 'server-only';

import { prisma } from '@drishtinet/db';

export interface SignatureHit {
  trackId: string;
  cameraId: string;
  cameraLabel: string;
  cameraName: string;
  district: string | null;
  cls: string;
  colour: string | null;
  colourConfidence: number | null;
  /** The pipeline's own doubt, carried through to the screen rather than rounded away. */
  colourUncertain: boolean;
  partialPlate: string | null;
  embeddingModel: string | null;
  hasEmbedding: boolean;
  firstSeen: Date;
  lastSeen: Date;
  frameCount: number;
}

export interface SearchFilters {
  cls?: string;
  colour?: string;
  cameraId?: string;
  /** Free text matched against a partial plate. */
  plate?: string;
  limit?: number;
}

export interface SearchResult {
  hits: SignatureHit[];
  total: number;
  /** Measured server-side, so the page can state the real number against the 200 ms budget. */
  queryMs: number;
}

/**
 * Search vehicle signatures.
 *
 * Deliberately not a text search over everything: the fields an operator actually has from a
 * witness are the vehicle type, its colour, where and when. Plate is offered but rarely populated
 * on this grid — see `signature.py` for the measurement — so it is one filter among several rather
 * than the primary key the interface is built around.
 */
export async function searchSignatures(filters: SearchFilters = {}): Promise<SearchResult> {
  const started = performance.now();
  const limit = Math.min(filters.limit ?? 100, 500);

  const where: Record<string, unknown> = {};
  if (filters.cls) where.cls = filters.cls;
  if (filters.colour) where.colour = filters.colour;
  if (filters.plate) {
    where.partialPlate = { contains: filters.plate.toUpperCase().replace(/\s+/g, '') };
  }

  const trackWhere = filters.cameraId ? { cameraId: filters.cameraId } : {};

  const [rows, total] = await Promise.all([
    prisma.vehicleSignature.findMany({
      where: { ...where, track: trackWhere },
      take: limit,
      orderBy: { track: { startedRecordedAt: 'desc' } },
      include: {
        track: { include: { camera: { select: { label: true, name: true, district: true } } } },
      },
    }),
    prisma.vehicleSignature.count({ where: { ...where, track: trackWhere } }),
  ]);

  const hits: SignatureHit[] = rows.map((row) => ({
    trackId: row.trackId,
    cameraId: row.track.cameraId,
    cameraLabel: row.track.camera.label,
    cameraName: row.track.camera.name,
    district: row.track.camera.district,
    cls: row.cls,
    colour: row.colour,
    colourConfidence: row.colourConfidence,
    colourUncertain: row.colourUncertain,
    partialPlate: row.partialPlate,
    embeddingModel: row.embeddingModel,
    hasEmbedding: row.embedding.length > 0,
    firstSeen: row.track.startedRecordedAt,
    lastSeen: row.track.endedRecordedAt ?? row.track.startedRecordedAt,
    frameCount: row.track.frameCount,
  }));

  return { hits, total, queryMs: Math.round(performance.now() - started) };
}

export interface IndexSummary {
  detections: number;
  tracks: number;
  signatures: number;
  cameras: number;
  /** Null when nothing has been indexed yet, which the page must say rather than showing zeroes. */
  earliest: Date | null;
  latest: Date | null;
  byClass: { cls: string; count: number }[];
  byCamera: { cameraId: string; label: string; name: string; tracks: number }[];
  queryMs: number;
}

/** What the index actually holds right now. */
export async function indexSummary(): Promise<IndexSummary> {
  const started = performance.now();

  const [detections, tracks, signatures, span, byClass, byCameraRaw] = await Promise.all([
    prisma.detection.count(),
    prisma.track.count(),
    prisma.vehicleSignature.count(),
    prisma.track.aggregate({
      _min: { startedRecordedAt: true },
      _max: { endedRecordedAt: true },
    }),
    prisma.track.groupBy({ by: ['cls'], _count: { _all: true }, orderBy: { _count: { cls: 'desc' } } }),
    prisma.track.groupBy({ by: ['cameraId'], _count: { _all: true } }),
  ]);

  const cameras = await prisma.camera.findMany({
    where: { id: { in: byCameraRaw.map((r) => r.cameraId) } },
    select: { id: true, label: true, name: true },
  });
  const cameraById = new Map(cameras.map((c) => [c.id, c]));

  return {
    detections,
    tracks,
    signatures,
    cameras: byCameraRaw.length,
    earliest: span._min.startedRecordedAt,
    latest: span._max.endedRecordedAt,
    byClass: byClass.map((r) => ({ cls: r.cls, count: r._count._all })),
    byCamera: byCameraRaw
      .map((r) => ({
        cameraId: r.cameraId,
        label: cameraById.get(r.cameraId)?.label ?? r.cameraId,
        name: cameraById.get(r.cameraId)?.name ?? r.cameraId,
        tracks: r._count._all,
      }))
      .sort((a, b) => b.tracks - a.tracks),
    queryMs: Math.round(performance.now() - started),
  };
}

export interface RecentAlert {
  id: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  status: string;
  entityType: string;
  entityValue: string;
  reason: string;
  source: string;
  mock: boolean;
  confidence: number;
  matchedVia: string | null;
  repaired: boolean;
  cameraLabel: string;
  cameraName: string;
  /** detection → alert, measured server-side. Null on older rows written before instrumentation. */
  pipelineLatencyMs: number | null;
  recordedAt: Date;
  createdAt: Date;
}

/** Alerts already raised. The live feed layers on top of this, so a reload never starts empty. */
export async function recentAlerts(limit = 50): Promise<RecentAlert[]> {
  const rows = await prisma.alert.findMany({
    take: limit,
    orderBy: { createdAt: 'desc' },
    include: { camera: { select: { label: true, name: true } } },
  });

  return rows.map((row) => ({
    id: row.id,
    priority: row.priority,
    status: row.status,
    entityType: row.entityType,
    entityValue: row.entityValue,
    reason: row.reason,
    source: row.source,
    mock: row.mock,
    confidence: row.confidence,
    matchedVia: row.matchedVia,
    repaired: row.repaired,
    cameraLabel: row.camera.label,
    cameraName: row.camera.name,
    pipelineLatencyMs: row.pipelineLatencyMs,
    recordedAt: row.recordedAt,
    createdAt: row.createdAt,
  }));
}

/** Distinct values actually present, so filters only ever offer something that returns results. */
export async function availableFilters() {
  const [classes, colours, cameras] = await Promise.all([
    prisma.vehicleSignature.groupBy({ by: ['cls'], orderBy: { cls: 'asc' } }),
    prisma.vehicleSignature.groupBy({ by: ['colour'], orderBy: { colour: 'asc' } }),
    prisma.track.groupBy({ by: ['cameraId'] }),
  ]);

  const cameraRows = await prisma.camera.findMany({
    where: { id: { in: cameras.map((c) => c.cameraId) } },
    select: { id: true, label: true, name: true },
    orderBy: { label: 'asc' },
  });

  return {
    classes: classes.map((c) => c.cls),
    colours: colours.map((c) => c.colour).filter((c): c is string => Boolean(c)),
    cameras: cameraRows,
  };
}
