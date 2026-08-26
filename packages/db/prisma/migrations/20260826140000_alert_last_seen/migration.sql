-- Separate "first flagged" from "still being seen".
--
-- recorded_at marks the moment a vehicle was first identified as wanted — the fact an officer asked
-- to intercept it needs. A vehicle is re-identified as more views accumulate, and folding those
-- into recorded_at left every alert permanently claiming it had just been raised, which is exactly
-- backwards: the longer a vehicle had been tracked, the fresher its alert appeared.
ALTER TABLE "alerts" ADD COLUMN "last_seen_at" TIMESTAMP(3);
