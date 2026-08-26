/**
 * Event contract shared by analytics (Python producer), alerts (Node consumer) and web (browser).
 *
 * Wire format is JSON on Redis Streams. Field names are snake_case because the Python producer is
 * the source of truth for this schema — keeping one casing across the bus avoids a translation
 * layer that would only ever be a place for bugs to hide.
 *
 * Every event carries `captured_at_ms` (when the frame was grabbed) so we can measure true
 * detection→UI latency against the < 500 ms budget instead of measuring our own bus.
 */
import { z } from 'zod';

export const STREAM_KEYS = {
  detections: 'drishti:detections',
  tracks: 'drishti:tracks',
  plates: 'drishti:plates',
  cameraHealth: 'drishti:camera-health',
  alerts: 'drishti:alerts',
  signatures: 'drishti:signatures',
} as const;

export const CONSUMER_GROUPS = {
  alertsEngine: 'alerts-engine',
} as const;

/** COCO classes we care about, plus the plate class from the dedicated detector. */
export const DetectedClass = z.enum([
  'car', 'motorcycle', 'bus', 'truck', 'bicycle', 'person', 'license_plate', 'auto_rickshaw',
]);
export type DetectedClass = z.infer<typeof DetectedClass>;

export const VEHICLE_CLASSES: readonly DetectedClass[] = [
  'car', 'motorcycle', 'bus', 'truck', 'bicycle', 'auto_rickshaw',
];

/** [x1, y1, x2, y2] in absolute pixels of the analysed (sub-stream) frame. */
export const BBox = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export type BBox = z.infer<typeof BBox>;

export const FrameRef = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** Monotonic frame index within the analytics worker's session, for debugging drops. */
  index: z.number().int().nonnegative(),
});

export const DetectionEvent = z.object({
  type: z.literal('detection.new'),
  event_id: z.string(),
  camera_id: z.string(),
  captured_at_ms: z.number(),
  emitted_at_ms: z.number(),
  frame: FrameRef,
  cls: DetectedClass,
  bbox: BBox,
  confidence: z.number().min(0).max(1),
  track_id: z.number().int().nullable(),
});
export type DetectionEvent = z.infer<typeof DetectionEvent>;

export const TrackEvent = z.object({
  type: z.literal('track.updated'),
  event_id: z.string(),
  camera_id: z.string(),
  captured_at_ms: z.number(),
  emitted_at_ms: z.number(),
  track_id: z.number().int(),
  cls: DetectedClass,
  bbox: BBox,
  /** Set once the track ends (ByteTrack lost it for `track_buffer` frames). */
  ended: z.boolean().default(false),
  /** Coarse appearance attributes used as re-ID fallback when the plate is unreadable. */
  attributes: z
    .object({
      color: z.string().nullable(),
      color_confidence: z.number().min(0).max(1).nullable(),
      vehicle_type: DetectedClass.nullable(),
    })
    .nullable(),
});
export type TrackEvent = z.infer<typeof TrackEvent>;

/**
 * One plate read per track, not per frame. `frames_considered` and `agreement` expose how the
 * winning read was chosen so an operator (and a court) can see it was not a single lucky frame.
 */
export const PlateEvent = z.object({
  type: z.literal('plate.read'),
  event_id: z.string(),
  camera_id: z.string(),
  captured_at_ms: z.number(),
  emitted_at_ms: z.number(),
  track_id: z.number().int(),
  /** Exactly what OCR returned, before normalization. Never overwritten. */
  raw_ocr: z.string(),
  /** Canonical plate, null when the read failed Indian-grammar validation. */
  normalized: z.string().nullable(),
  valid: z.boolean(),
  /** True when OCR confusion-pair repair (O→0 etc.) changed the string. */
  repaired: z.boolean(),
  confidence: z.number().min(0).max(1),
  frames_considered: z.number().int().positive(),
  /** Fraction of considered frames that produced the winning normalized string. */
  agreement: z.number().min(0).max(1),
  bbox: BBox,
  /** Object key of the plate crop in MinIO, for the evidence trail. */
  crop_key: z.string().nullable(),
});
export type PlateEvent = z.infer<typeof PlateEvent>;

export const CameraHealthEvent = z.object({
  type: z.literal('camera.health'),
  event_id: z.string(),
  camera_id: z.string(),
  emitted_at_ms: z.number(),
  status: z.enum(['online', 'degraded', 'offline', 'unknown']),
  /** Measured on the analysed sub-stream, so it reflects what the AI actually sees. */
  fps: z.number().nullable(),
  latency_ms: z.number().nullable(),
  detail: z.string().nullable(),
});
export type CameraHealthEvent = z.infer<typeof CameraHealthEvent>;

/**
 * A finished vehicle signature — the unit the watchlist actually matches against.
 *
 * Emitted once per track, when the track closes, rather than per detection. A detection is not yet
 * an identity, and a busy camera produces roughly eleven thousand of them a minute; publishing
 * those would make the bus the bottleneck and give the matcher nothing it could act on anyway.
 *
 * The embedding is here because on this grid it carries the identification. Measured at the
 * organisers' camera geometry, a plate occupies about 41 px of a median 164 px vehicle box, which
 * nothing reads; the appearance embedding separates same-vehicle (0.950) from different-vehicle
 * (0.544) cleanly. `partial_plate` is corroboration when it happens to be legible, never the key.
 */
export const SignatureEvent = z.object({
  type: z.literal('signature.created'),
  event_id: z.string(),
  /** Internal camera id. Never a portal id — those get reassigned between physical cameras. */
  camera_id: z.string(),
  camera_label: z.string(),
  /** Database track id, so an alert can be traced back to the rows that produced it. */
  track_id: z.string(),
  cls: DetectedClass,
  colour: z.string().nullable(),
  colour_confidence: z.number().min(0).max(1).nullable(),
  /** Set when the light was too poor for colour to be trusted. The UI must show the doubt. */
  colour_uncertain: z.boolean().default(false),
  /** Whatever characters were legible. Never padded, never guessed. */
  partial_plate: z.string().nullable(),
  /** L2-normalised appearance embedding, so cosine similarity is a dot product. */
  embedding: z.array(z.number()),
  embedding_model: z.string().nullable(),
  /** Forensic time — what an operator sees and what cross-camera correlation uses. */
  recorded_at_ms: z.number(),
  /** Wall clock when this became known, so end-to-end alert latency can be measured for real. */
  detected_at_ms: z.number(),
});
export type SignatureEvent = z.infer<typeof SignatureEvent>;

export const BusEvent = z.discriminatedUnion('type', [
  DetectionEvent, TrackEvent, PlateEvent, CameraHealthEvent, SignatureEvent,
]);
export type BusEvent = z.infer<typeof BusEvent>;
