-- Make the camera reference structural rather than conventional.
--
-- `events.camera_id` and `evidence_clips.camera_id` held camera references with no foreign key, so
-- nothing prevented a portal id being written there. Portal ids are positional and get reassigned;
-- a row pointing at "camera 22" would silently mean a different camera after the next renumbering.
-- Both tables are empty, so this is safe to add now rather than after they fill.
ALTER TABLE "events"
  ADD CONSTRAINT "events_camera_id_fkey"
  FOREIGN KEY ("camera_id") REFERENCES "cameras"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "evidence_clips"
  ADD CONSTRAINT "evidence_clips_camera_id_fkey"
  FOREIGN KEY ("camera_id") REFERENCES "cameras"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "events_camera_id_created_at_idx" ON "events" ("camera_id", "created_at");
