-- CreateEnum
CREATE TYPE "location_status" AS ENUM ('verified', 'approximate', 'unverified');

-- CreateEnum
CREATE TYPE "camera_status" AS ENUM ('online', 'degraded', 'offline');

-- CreateEnum
CREATE TYPE "status_source" AS ENUM ('measured', 'portal_claim');

-- CreateEnum
CREATE TYPE "source_type" AS ENUM ('MP4_PROGRESSIVE', 'RTSP', 'HLS', 'MJPEG', 'FILE_LOOP', 'ONVIF_STUB', 'VMS_SDK_STUB');

-- CreateEnum
CREATE TYPE "alert_priority" AS ENUM ('critical', 'high', 'medium', 'low');

-- CreateEnum
CREATE TYPE "alert_status" AS ENUM ('new', 'acknowledged', 'escalated', 'resolved', 'false_positive');

-- CreateEnum
CREATE TYPE "entity_type" AS ENUM ('vehicle_plate', 'vehicle_attributes', 'person', 'object');

-- CreateEnum
CREATE TYPE "role" AS ENUM ('state_admin', 'department_admin', 'control_room_operator', 'investigator', 'auditor');

-- CreateTable
CREATE TABLE "departments" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_gu" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "department_assignments" (
    "id" TEXT NOT NULL,
    "camera_id" TEXT NOT NULL,
    "department_id" TEXT NOT NULL,
    "basis" TEXT NOT NULL,
    "rationale" TEXT,
    "confirmed" BOOLEAN NOT NULL DEFAULT false,
    "assigned_by" TEXT NOT NULL,
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "department_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cameras" (
    "id" TEXT NOT NULL,
    "portal_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "label_number" INTEGER,
    "name" TEXT NOT NULL,
    "district" TEXT,
    "cluster" TEXT,
    "department_id" TEXT,
    "geom" geography(Point, 4326),
    "location_status" "location_status" NOT NULL DEFAULT 'unverified',
    "location_uncertainty_m" INTEGER NOT NULL DEFAULT 15000,
    "status" "camera_status" NOT NULL DEFAULT 'online',
    "status_source" "status_source" NOT NULL DEFAULT 'portal_claim',
    "last_error" TEXT,
    "retention_days" INTEGER,
    "storage_type" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "last_seen_at" TIMESTAMP(3),

    CONSTRAINT "cameras_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "streams" (
    "id" TEXT NOT NULL,
    "camera_id" TEXT NOT NULL,
    "source_type" "source_type" NOT NULL,
    "source_url" TEXT NOT NULL,
    "substream_url" TEXT,
    "snapshot_url" TEXT,
    "duration_seconds" DOUBLE PRECISION,
    "codec" TEXT,
    "container" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "fps" DOUBLE PRECISION,
    "size_bytes" BIGINT,
    "is_local_mirror" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "streams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "camera_health" (
    "id" TEXT NOT NULL,
    "camera_id" TEXT NOT NULL,
    "status" "camera_status" NOT NULL,
    "last_frame_at" TIMESTAMP(3),
    "fps" DOUBLE PRECISION,
    "latency_ms" INTEGER,
    "detail" TEXT,
    "observed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "camera_health_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "time_sync" (
    "id" TEXT NOT NULL,
    "camera_id" TEXT NOT NULL,
    "clock_offset_s" DOUBLE PRECISION NOT NULL,
    "measured_from" TEXT NOT NULL,
    "at_position_s" DOUBLE PRECISION,
    "measured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "evidence_path" TEXT,

    CONSTRAINT "time_sync_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "detections" (
    "id" TEXT NOT NULL,
    "camera_id" TEXT NOT NULL,
    "track_id" TEXT,
    "cls" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "bbox" DOUBLE PRECISION[],
    "frame_w" INTEGER NOT NULL,
    "frame_h" INTEGER NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL,
    "observed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "detections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tracks" (
    "id" TEXT NOT NULL,
    "camera_id" TEXT NOT NULL,
    "tracker_id" INTEGER NOT NULL,
    "cls" TEXT NOT NULL,
    "started_recorded_at" TIMESTAMP(3) NOT NULL,
    "ended_recorded_at" TIMESTAMP(3),
    "frame_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "tracks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_signatures" (
    "id" TEXT NOT NULL,
    "track_id" TEXT NOT NULL,
    "cls" TEXT NOT NULL,
    "colour" TEXT,
    "colour_confidence" DOUBLE PRECISION,
    "colour_uncertain" BOOLEAN NOT NULL DEFAULT false,
    "embedding" DOUBLE PRECISION[],
    "embedding_model" TEXT,
    "partial_plate" TEXT,

    CONSTRAINT "vehicle_signatures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plates" (
    "id" TEXT NOT NULL,
    "track_id" TEXT NOT NULL,
    "raw_ocr" TEXT NOT NULL,
    "normalized" TEXT,
    "valid" BOOLEAN NOT NULL DEFAULT false,
    "repaired" BOOLEAN NOT NULL DEFAULT false,
    "confidence" DOUBLE PRECISION NOT NULL,
    "frames_considered" INTEGER NOT NULL DEFAULT 1,
    "agreement" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "alternates" TEXT[],
    "crop_key" TEXT,
    "recorded_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "watchlists" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "watchlists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "watchlist_entries" (
    "id" TEXT NOT NULL,
    "watchlist_id" TEXT NOT NULL,
    "entity_type" "entity_type" NOT NULL,
    "entity_value" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "priority" "alert_priority" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "watchlist_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alerts" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "mock" BOOLEAN NOT NULL DEFAULT false,
    "priority" "alert_priority" NOT NULL,
    "status" "alert_status" NOT NULL DEFAULT 'new',
    "entity_type" "entity_type" NOT NULL,
    "entity_value" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "watchlist_entry_id" TEXT,
    "camera_id" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "repaired" BOOLEAN NOT NULL DEFAULT false,
    "matched_via" TEXT,
    "evidence_clip_id" TEXT,
    "pipeline_latency_ms" INTEGER,
    "recorded_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_acknowledgements" (
    "id" TEXT NOT NULL,
    "alert_id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action" "alert_status" NOT NULL,
    "note" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alert_acknowledgements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_enrichments" (
    "id" TEXT NOT NULL,
    "alert_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "mock" BOOLEAN NOT NULL,
    "payload" JSONB NOT NULL,
    "error" TEXT,
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alert_enrichments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence_clips" (
    "id" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "size_bytes" BIGINT,
    "camera_id" TEXT NOT NULL,
    "start_recorded_at" TIMESTAMP(3) NOT NULL,
    "end_recorded_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "chain_of_custody" JSONB NOT NULL,

    CONSTRAINT "evidence_clips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "events" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "camera_id" TEXT,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "role" NOT NULL,
    "department_id" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "id" TEXT NOT NULL,
    "role" "role" NOT NULL,
    "permission_key" TEXT NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entity_id" TEXT,
    "meta" JSONB,
    "time_shifted" BOOLEAN NOT NULL DEFAULT false,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "departments_slug_key" ON "departments"("slug");

-- CreateIndex
CREATE INDEX "department_assignments_camera_id_idx" ON "department_assignments"("camera_id");

-- CreateIndex
CREATE UNIQUE INDEX "cameras_portal_id_key" ON "cameras"("portal_id");

-- CreateIndex
CREATE INDEX "cameras_district_idx" ON "cameras"("district");

-- CreateIndex
CREATE INDEX "cameras_status_idx" ON "cameras"("status");

-- CreateIndex
CREATE INDEX "cameras_department_id_idx" ON "cameras"("department_id");

-- CreateIndex
CREATE INDEX "streams_camera_id_idx" ON "streams"("camera_id");

-- CreateIndex
CREATE INDEX "camera_health_camera_id_observed_at_idx" ON "camera_health"("camera_id", "observed_at");

-- CreateIndex
CREATE INDEX "time_sync_camera_id_idx" ON "time_sync"("camera_id");

-- CreateIndex
CREATE INDEX "detections_camera_id_recorded_at_idx" ON "detections"("camera_id", "recorded_at");

-- CreateIndex
CREATE INDEX "detections_track_id_idx" ON "detections"("track_id");

-- CreateIndex
CREATE INDEX "tracks_camera_id_started_recorded_at_idx" ON "tracks"("camera_id", "started_recorded_at");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_signatures_track_id_key" ON "vehicle_signatures"("track_id");

-- CreateIndex
CREATE INDEX "plates_normalized_idx" ON "plates"("normalized");

-- CreateIndex
CREATE INDEX "plates_track_id_idx" ON "plates"("track_id");

-- CreateIndex
CREATE INDEX "watchlist_entries_entity_value_idx" ON "watchlist_entries"("entity_value");

-- CreateIndex
CREATE INDEX "watchlist_entries_watchlist_id_idx" ON "watchlist_entries"("watchlist_id");

-- CreateIndex
CREATE INDEX "alerts_status_priority_recorded_at_idx" ON "alerts"("status", "priority", "recorded_at");

-- CreateIndex
CREATE INDEX "alerts_camera_id_recorded_at_idx" ON "alerts"("camera_id", "recorded_at");

-- CreateIndex
CREATE INDEX "alert_acknowledgements_alert_id_idx" ON "alert_acknowledgements"("alert_id");

-- CreateIndex
CREATE INDEX "alert_enrichments_alert_id_idx" ON "alert_enrichments"("alert_id");

-- CreateIndex
CREATE INDEX "evidence_clips_sha256_idx" ON "evidence_clips"("sha256");

-- CreateIndex
CREATE INDEX "events_kind_created_at_idx" ON "events"("kind", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_key_key" ON "permissions"("key");

-- CreateIndex
CREATE UNIQUE INDEX "role_permissions_role_permission_key_key" ON "role_permissions"("role", "permission_key");

-- CreateIndex
CREATE INDEX "audit_log_entity_entity_id_idx" ON "audit_log"("entity", "entity_id");

-- CreateIndex
CREATE INDEX "audit_log_at_idx" ON "audit_log"("at");

-- AddForeignKey
ALTER TABLE "department_assignments" ADD CONSTRAINT "department_assignments_camera_id_fkey" FOREIGN KEY ("camera_id") REFERENCES "cameras"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "department_assignments" ADD CONSTRAINT "department_assignments_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cameras" ADD CONSTRAINT "cameras_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "streams" ADD CONSTRAINT "streams_camera_id_fkey" FOREIGN KEY ("camera_id") REFERENCES "cameras"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "camera_health" ADD CONSTRAINT "camera_health_camera_id_fkey" FOREIGN KEY ("camera_id") REFERENCES "cameras"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_sync" ADD CONSTRAINT "time_sync_camera_id_fkey" FOREIGN KEY ("camera_id") REFERENCES "cameras"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "detections" ADD CONSTRAINT "detections_camera_id_fkey" FOREIGN KEY ("camera_id") REFERENCES "cameras"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "detections" ADD CONSTRAINT "detections_track_id_fkey" FOREIGN KEY ("track_id") REFERENCES "tracks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_camera_id_fkey" FOREIGN KEY ("camera_id") REFERENCES "cameras"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_signatures" ADD CONSTRAINT "vehicle_signatures_track_id_fkey" FOREIGN KEY ("track_id") REFERENCES "tracks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plates" ADD CONSTRAINT "plates_track_id_fkey" FOREIGN KEY ("track_id") REFERENCES "tracks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "watchlist_entries" ADD CONSTRAINT "watchlist_entries_watchlist_id_fkey" FOREIGN KEY ("watchlist_id") REFERENCES "watchlists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_camera_id_fkey" FOREIGN KEY ("camera_id") REFERENCES "cameras"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_watchlist_entry_id_fkey" FOREIGN KEY ("watchlist_entry_id") REFERENCES "watchlist_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_evidence_clip_id_fkey" FOREIGN KEY ("evidence_clip_id") REFERENCES "evidence_clips"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_acknowledgements" ADD CONSTRAINT "alert_acknowledgements_alert_id_fkey" FOREIGN KEY ("alert_id") REFERENCES "alerts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_enrichments" ADD CONSTRAINT "alert_enrichments_alert_id_fkey" FOREIGN KEY ("alert_id") REFERENCES "alerts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
