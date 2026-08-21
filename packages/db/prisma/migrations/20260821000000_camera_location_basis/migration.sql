-- Record WHY a camera's uncertainty radius is what it is, and who placed it if a human did.
-- Purely additive and nullable: no existing row changes, nothing is dropped.
ALTER TABLE "cameras" ADD COLUMN IF NOT EXISTS "location_basis"  TEXT;
ALTER TABLE "cameras" ADD COLUMN IF NOT EXISTS "location_set_by" TEXT;
ALTER TABLE "cameras" ADD COLUMN IF NOT EXISTS "location_set_at" TIMESTAMP(3);
