-- Portal ids are positional and get reused when a camera leaves the roster. A departed camera must
-- release its id rather than hold one that now points at a different physical camera.
-- Postgres allows multiple NULLs under a unique index, so uniqueness among live ids is preserved.
ALTER TABLE "cameras" ALTER COLUMN "portal_id" DROP NOT NULL;
ALTER TABLE "cameras" ADD COLUMN IF NOT EXISTS "last_portal_id" TEXT;
