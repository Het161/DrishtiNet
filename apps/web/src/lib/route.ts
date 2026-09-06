/**
 * Cross-camera route reconstruction.
 *
 * ── Why appearance similarity alone is not a route ───────────────────────────────────────────────
 *
 * Measured on the indexed data: at a cosine threshold of 0.82, cameras 5 and 16 — one junction seen
 * from two angles — produce 949 same-class matches, which is the system working. The same threshold
 * also produces 20 matches between cameras 5 and 10, which are roughly 300 km apart in different
 * districts. Those are not sightings. They are two white cars that look alike.
 *
 * An appearance model cannot tell the difference, because it was never asked about geography. So a
 * route is not "everything that looks similar" — it is a sequence of sightings that a single vehicle
 * could physically have made:
 *
 *   1. it looks the same        (appearance, necessary but not sufficient)
 *   2. it is the same kind of thing  (a car does not become a motorcycle between cameras)
 *   3. it moved forward in time      (sightings are ordered by recorded_at)
 *   4. it could have got there       (distance ÷ elapsed time is a speed a vehicle can reach)
 *
 * The fourth is what removes the 300 km false positives, and it is the reason this is worth
 * building rather than displaying a similarity list. An investigator shown an impossible route
 * stops trusting the possible ones.
 */
import 'server-only';

import { prisma } from '@drishtinet/db';

import { APPEARANCE_THRESHOLD, cosine, legIsPossible } from './route-rules';

export { APPEARANCE_THRESHOLD, MAX_PLAUSIBLE_SPEED_KMH } from './route-rules';

export interface Sighting {
  trackId: string;
  cameraId: string;
  cameraLabel: string;
  cameraName: string;
  lat: number | null;
  lng: number | null;
  /** True when the camera has no placed position and this is a district centroid. */
  positionApproximate: boolean;
  cls: string;
  colour: string | null;
  colourUncertain: boolean;
  partialPlate: string | null;
  recordedAt: Date;
  frameCount: number;
  /** Similarity to the track the route started from. Null for the seed itself. */
  similarity: number | null;
  /** Straight-line km from the previous sighting. Null for the first. */
  legKm: number | null;
  /** Implied speed for that leg. Null when the leg is too short to be meaningful. */
  legSpeedKmh: number | null;
  /**
   * False when this leg could not be checked because a camera has no placed position.
   *
   * Measured on the current data: camera 10 is unplaced, and it is exactly the camera producing
   * matches 300 km from Ahmedabad. Those legs are shown, because a mapping gap is not evidence of
   * absence — but they are shown as unverified, so nobody reads "not disproved" as "confirmed".
   */
  legVerifiable: boolean;
}

export interface Route {
  seedTrackId: string;
  sightings: Sighting[];
  /** Candidates that looked alike but could not physically have been the same vehicle. */
  rejectedAsImpossible: number;
  /** Legs accepted without a geographic check, because a camera on them has no placed position. */
  unverifiableLegs: number;
  queryMs: number;
}

interface SignatureRow {
  track_id: string;
  cls: string;
  colour: string | null;
  colour_uncertain: boolean;
  partial_plate: string | null;
  embedding: number[];
  camera_id: string;
  label: string;
  name: string;
  lat: number | null;
  lng: number | null;
  location_status: string;
  started_recorded_at: Date;
  frame_count: number;
}

function toRow(r: SignatureRow): Row {
  return {
    trackId: r.track_id,
    cls: r.cls,
    colour: r.colour,
    colourUncertain: r.colour_uncertain,
    partialPlate: r.partial_plate,
    embedding: r.embedding,
    cameraId: r.camera_id,
    cameraLabel: r.label,
    cameraName: r.name,
    lat: r.lat,
    lng: r.lng,
    positionApproximate: r.location_status !== 'verified',
    recordedAt: r.started_recorded_at,
    frameCount: r.frame_count,
  };
}

interface Row {
  trackId: string;
  cls: string;
  colour: string | null;
  colourUncertain: boolean;
  partialPlate: string | null;
  embedding: number[];
  cameraId: string;
  cameraLabel: string;
  cameraName: string;
  lat: number | null;
  lng: number | null;
  positionApproximate: boolean;
  recordedAt: Date;
  frameCount: number;
}

/**
 * The track the operator actually clicked, fetched without the quality filter.
 *
 * `loadSignatures` requires three frames and a full embedding, which is right for *candidates* —
 * a one-frame track carries too little to match on. But applying it to the seed made 408 of 973
 * signatures return 404 from a link the search results themselves offered. A page must be able to
 * show you the thing you just clicked, even when the answer is "this one is too thin to trace".
 */
async function loadSeed(trackId: string): Promise<Row | null> {
  const rows = await prisma.$queryRaw<SignatureRow[]>`
    select s.track_id, s.cls, s.colour, s.colour_uncertain, s.partial_plate, s.embedding,
           t.camera_id, c.label, c.name,
           st_y(c.geom::geometry) as lat, st_x(c.geom::geometry) as lng,
           c.location_status, t.started_recorded_at, t.frame_count
    from vehicle_signatures s
    join tracks t on t.id = s.track_id
    join cameras c on c.id = t.camera_id
    where s.track_id = ${trackId}
    limit 1
  `;
  return rows.length ? toRow(rows[0]!) : null;
}

async function loadSignatures(): Promise<Row[]> {
  // Raw SQL: the camera position is PostGIS geography, which Prisma cannot express.
  const rows = await prisma.$queryRaw<SignatureRow[]>`
    select s.track_id, s.cls, s.colour, s.colour_uncertain, s.partial_plate, s.embedding,
           t.camera_id, c.label, c.name,
           st_y(c.geom::geometry) as lat, st_x(c.geom::geometry) as lng,
           c.location_status, t.started_recorded_at, t.frame_count
    from vehicle_signatures s
    join tracks t on t.id = s.track_id
    join cameras c on c.id = t.camera_id
    where array_length(s.embedding, 1) = 512
      and t.frame_count >= 3
  `;

  return rows.map(toRow);
}

/**
 * Reconstruct where one vehicle went.
 *
 * The seed is a track an operator picked — from a search result, or from an alert. Everything that
 * looks like it is gathered, sorted by forensic time, and then walked forward keeping only the
 * sightings a single vehicle could actually have reached.
 */
export async function reconstructRoute(seedTrackId: string): Promise<Route | null> {
  const started = performance.now();
  const [all, seed] = await Promise.all([loadSignatures(), loadSeed(seedTrackId)]);
  if (!seed) return null;

  const lookalikes = all
    .filter((r) => r.trackId !== seed.trackId)
    // The seed speaks for its own camera. Without this, the one-sighting-per-camera rule below
    // could drop the very track the operator selected in favour of an earlier lookalike on the
    // same camera — a route that does not contain the thing it was asked about.
    .filter((r) => r.cameraId !== seed.cameraId)
    .filter((r) => r.cls === seed.cls) // a car does not become a motorcycle between cameras
    .map((r) => ({ row: r, similarity: cosine(seed.embedding, r.embedding) }))
    .filter((c) => c.similarity >= APPEARANCE_THRESHOLD);

  /**
   * The whole journey, in true chronological order — not only what happened after the seed.
   *
   * An investigator starting from a sighting almost always wants to know where the vehicle came
   * from as much as where it went. Anchoring the sequence on the seed produced routes that ran
   * backwards, with a later camera listed first and an earlier one second, which reads as the
   * vehicle travelling into the past.
   */
  const ordered = [{ row: seed, similarity: null as number | null }, ...lookalikes].sort(
    (a, b) => a.row.recordedAt.getTime() - b.row.recordedAt.getTime(),
  );

  const sightings: Sighting[] = [];
  let rejected = 0;
  let previous: Row | null = null;

  for (const { row, similarity } of ordered) {
    // One sighting per camera: a vehicle passing one camera is one visit, and that camera's other
    // lookalike tracks are the same moment seen again, not a new place.
    if (sightings.some((s) => s.cameraId === row.cameraId)) continue;

    let legKm: number | null = null;
    let legSpeedKmh: number | null = null;
    let legVerifiable = true;

    if (previous !== null) {
      const leg = legIsPossible(
        previous.lat, previous.lng, previous.recordedAt,
        row.lat, row.lng, row.recordedAt,
      );
      if (!leg.possible) {
        rejected += 1;
        continue;
      }
      legKm = leg.km === null ? null : Number(leg.km.toFixed(2));
      legSpeedKmh = leg.speedKmh === null ? null : Number(leg.speedKmh.toFixed(1));
      legVerifiable = leg.verifiable;
    }

    sightings.push({
      trackId: row.trackId,
      cameraId: row.cameraId,
      cameraLabel: row.cameraLabel,
      cameraName: row.cameraName,
      lat: row.lat,
      lng: row.lng,
      positionApproximate: row.positionApproximate,
      cls: row.cls,
      colour: row.colour,
      colourUncertain: row.colourUncertain,
      partialPlate: row.partialPlate,
      recordedAt: row.recordedAt,
      frameCount: row.frameCount,
      similarity: similarity === null ? null : Number(similarity.toFixed(3)),
      legKm,
      legSpeedKmh,
      legVerifiable,
    });
    previous = row;
  }

  return {
    seedTrackId,
    sightings,
    rejectedAsImpossible: rejected,
    unverifiableLegs: sightings.filter((s) => !s.legVerifiable).length,
    queryMs: Math.round(performance.now() - started),
  };
}
