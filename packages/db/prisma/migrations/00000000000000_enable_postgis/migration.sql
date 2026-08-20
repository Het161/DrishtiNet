-- PostGIS must exist before any migration declaring a geography column, including in the shadow
-- database Prisma builds to verify migrations. Keeping this first means `prisma migrate deploy`
-- works on a clean database with no manual bootstrap step.
--
-- The remaining three come preinstalled in the postgis Docker image; creating them explicitly
-- keeps a plain postgres+postgis server and the image in agreement, so migrations do not report
-- drift depending on where they run.
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS postgis_topology;
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;
CREATE EXTENSION IF NOT EXISTS postgis_tiger_geocoder;
