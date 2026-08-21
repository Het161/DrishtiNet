-- Live endpoints from /api/ingest, plus a snapshot history of the discovery endpoint.
-- Additive except for the label uniqueness constraint, which encodes the reconciliation key.

ALTER TABLE "streams" ADD COLUMN IF NOT EXISTS "rtsp_url"     TEXT;
ALTER TABLE "streams" ADD COLUMN IF NOT EXISTS "webrtc_url"   TEXT;
ALTER TABLE "streams" ADD COLUMN IF NOT EXISTS "hls_url"      TEXT;
ALTER TABLE "streams" ADD COLUMN IF NOT EXISTS "portal_live"  BOOLEAN;
ALTER TABLE "streams" ADD COLUMN IF NOT EXISTS "bitrate_kbps" INTEGER;

CREATE TABLE IF NOT EXISTS "api_snapshots" (
  "id"           TEXT NOT NULL,
  "endpoint"     TEXT NOT NULL,
  "fetched_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "camera_count" INTEGER NOT NULL,
  "digest"       TEXT NOT NULL,
  "payload"      JSONB NOT NULL,
  "diff_summary" TEXT,
  CONSTRAINT "api_snapshots_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "api_snapshots_endpoint_fetched_at_idx"
  ON "api_snapshots" ("endpoint", "fetched_at");

-- The label is the stable identity; portal ids are a positional index that has already shifted.
CREATE UNIQUE INDEX IF NOT EXISTS "cameras_label_key" ON "cameras" ("label");
