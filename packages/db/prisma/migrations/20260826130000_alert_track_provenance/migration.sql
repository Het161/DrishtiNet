-- Tie an alert to the track that produced it.
--
-- Without this an alert names a camera and a time but not the evidence: there is no way to get from
-- "this vehicle was flagged" back to the detections, the crops or the signature that caused it. For
-- a system whose output may be used in an investigation that is not a reporting gap, it is a
-- chain-of-custody gap.
--
-- It also makes de-duplication possible. A vehicle crossing a junction is identified several times
-- as more views accumulate, and without a key to suppress on, one vehicle raises one alert per
-- sighting. Thirty alerts for one car is how a control room learns to ignore the alert panel.
ALTER TABLE "alerts" ADD COLUMN "track_id" TEXT;

ALTER TABLE "alerts"
  ADD CONSTRAINT "alerts_track_id_fkey"
  FOREIGN KEY ("track_id") REFERENCES "tracks"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- One alert per (track, watchlist entry). A later, better-supported identification updates the
-- existing alert rather than adding another line to the operator's screen.
CREATE UNIQUE INDEX "alerts_track_entry_unique"
  ON "alerts"("track_id", "watchlist_entry_id")
  WHERE "track_id" IS NOT NULL AND "watchlist_entry_id" IS NOT NULL;

CREATE INDEX "alerts_track_id_idx" ON "alerts"("track_id");
