/**
 * The standardized alert envelope.
 *
 * Every alert — whether raised by our own ANPR pipeline or ingested from a mock (later: real)
 * external source such as eGujCop or a NAFIS match webhook — is normalized into this one shape.
 * That is the whole point: swapping a mock adapter for a real one must not require a redesign of
 * the triage UI, the audit trail, or the evidence export.
 */
import { z } from 'zod';

export const AlertPriority = z.enum(['critical', 'high', 'medium', 'low']);
export type AlertPriority = z.infer<typeof AlertPriority>;

export const PRIORITY_ORDER: Record<AlertPriority, number> = {
  critical: 0, high: 1, medium: 2, low: 3,
};

export const AlertStatus = z.enum(['new', 'acknowledged', 'escalated', 'resolved', 'false_positive']);
export type AlertStatus = z.infer<typeof AlertStatus>;

export const EntityType = z.enum(['vehicle_plate', 'vehicle_attributes', 'person', 'object']);
export type EntityType = z.infer<typeof EntityType>;

/**
 * Where the alert came from. `internal_anpr` is ours; every other value is an external system and
 * is rendered with a MOCK badge until a real adapter is certified.
 */
export const AlertSource = z.enum([
  'internal_anpr', 'internal_reid', 'vahan', 'sarthi', 'egujcop', 'afis', 'nafis', 'manual',
]);
export type AlertSource = z.infer<typeof AlertSource>;

export const EXTERNAL_SOURCES: readonly AlertSource[] = ['vahan', 'sarthi', 'egujcop', 'afis', 'nafis'];

export const AlertEvidence = z.object({
  clip_key: z.string().nullable(),
  snapshot_key: z.string().nullable(),
  crop_key: z.string().nullable(),
  sha256: z.string().nullable(),
});

/**
 * Enrichment attached from an integration adapter. `mock` is not optional — an unlabelled
 * enrichment must be impossible to construct.
 */
export const AlertEnrichment = z.object({
  source: AlertSource,
  mock: z.boolean(),
  fetched_at: z.string(),
  /** Free-form payload as returned by the adapter, kept verbatim for audit. */
  payload: z.record(z.unknown()),
  error: z.string().nullable().default(null),
});
export type AlertEnrichment = z.infer<typeof AlertEnrichment>;

export const Alert = z.object({
  id: z.string(),
  source: AlertSource,
  /** True whenever any part of this alert came from a mocked external system. */
  mock: z.boolean(),
  priority: AlertPriority,
  status: AlertStatus,
  entity_type: EntityType,
  /** Canonical plate for vehicle_plate alerts; a descriptor otherwise. */
  entity_value: z.string(),
  /** Why this is on a watchlist, in operator-facing language. */
  reason: z.string(),
  watchlist_id: z.string().nullable(),
  watchlist_entry_id: z.string().nullable(),
  camera_id: z.string(),
  camera_name: z.string(),
  district: z.string().nullable(),
  lat: z.number().nullable(),
  lon: z.number().nullable(),
  /** When the frame was captured — NOT when we processed it. Drives the latency metric. */
  captured_at: z.string(),
  created_at: z.string(),
  /** Confidence of the underlying read. Always shown; never rounded up in the UI. */
  confidence: z.number().min(0).max(1),
  /** True when OCR confusion-pair repair produced the matching plate. Operators must see this. */
  repaired: z.boolean().default(false),
  track_id: z.number().int().nullable(),
  evidence: AlertEvidence,
  enrichments: z.array(AlertEnrichment).default([]),
  /** detection→alert-emitted, measured server-side. The UI adds its own render delta. */
  pipeline_latency_ms: z.number().nullable(),
});
export type Alert = z.infer<typeof Alert>;

/* ------------------------------------------------------------------ */
/* WebSocket contract (alerts service → browser)                       */
/* ------------------------------------------------------------------ */

export const WsAlertCreated = z.object({
  type: z.literal('alert.created'),
  ts: z.number(),
  alert: Alert,
});

export const WsAlertUpdated = z.object({
  type: z.literal('alert.updated'),
  ts: z.number(),
  alert_id: z.string(),
  status: AlertStatus,
  actor: z.string(),
  note: z.string().nullable(),
});

export const WsTrackUpdated = z.object({
  type: z.literal('track.updated'),
  ts: z.number(),
  camera_id: z.string(),
  track_id: z.number().int(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  cls: z.string(),
  plate: z.string().nullable(),
});

export const WsCameraHealth = z.object({
  type: z.literal('camera.health'),
  ts: z.number(),
  camera_id: z.string(),
  status: z.enum(['online', 'degraded', 'offline', 'unknown']),
  fps: z.number().nullable(),
});

export const WsDetectionNew = z.object({
  type: z.literal('detection.new'),
  ts: z.number(),
  camera_id: z.string(),
  cls: z.string(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  confidence: z.number(),
  track_id: z.number().int().nullable(),
});

/** Server→client heartbeat. Carries server time so the UI can flag clock skew at the venue. */
export const WsHeartbeat = z.object({
  type: z.literal('heartbeat'),
  ts: z.number(),
  server_time_ist: z.string(),
  connected_clients: z.number().int(),
});

export const WsServerMessage = z.discriminatedUnion('type', [
  WsAlertCreated, WsAlertUpdated, WsTrackUpdated, WsCameraHealth, WsDetectionNew, WsHeartbeat,
]);
export type WsServerMessage = z.infer<typeof WsServerMessage>;

/** Client→server. Subscriptions keep the 50-tile wall from receiving 50 cameras' worth of boxes. */
export const WsClientMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('subscribe'),
    /** Camera ids to receive detection/track events for. Empty array = alerts only. */
    cameras: z.array(z.string()),
  }),
  z.object({ type: z.literal('ping'), ts: z.number() }),
]);
export type WsClientMessage = z.infer<typeof WsClientMessage>;
