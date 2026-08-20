-- Things Prisma's schema language cannot express.
--
-- Applied after every `prisma migrate deploy` by src/post-migrate.ts. Every statement is
-- idempotent, so running it twice is a no-op rather than an error.

-- ─────────────────────────────────────────────────────────────────────────────
-- Spatial index
-- ─────────────────────────────────────────────────────────────────────────────
-- Cross-camera route reconstruction asks "which cameras are within N metres of this one, and could
-- a vehicle plausibly have travelled between them in this time?". Without a GiST index that is a
-- sequential scan per hop.
CREATE INDEX IF NOT EXISTS cameras_geom_gist ON cameras USING GIST (geom);

-- ─────────────────────────────────────────────────────────────────────────────
-- Append-only audit trail
-- ─────────────────────────────────────────────────────────────────────────────
-- An audit log that can be edited is not an audit log. CERT-In log-retention expectations and
-- basic evidentiary credibility both require that a recorded action cannot be quietly revised, so
-- the guarantee is enforced by the database rather than by convention.
CREATE OR REPLACE FUNCTION audit_log_is_append_only() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();

-- TRUNCATE bypasses row-level triggers entirely, so the row trigger alone would leave an obvious
-- way to erase the whole trail in one statement. Statement-level trigger closes that.
DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit_log;
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_is_append_only();

-- Evidence clips carry a chain of custody, so the same rule applies to the hash and the path.
-- The custody JSON itself may be appended to; the identity of the artefact may not change.
CREATE OR REPLACE FUNCTION evidence_identity_is_immutable() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.path IS DISTINCT FROM OLD.path THEN
    RAISE EXCEPTION 'evidence_clips.sha256 and .path are immutable (clip %)', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS evidence_clips_immutable_identity ON evidence_clips;
CREATE TRIGGER evidence_clips_immutable_identity
  BEFORE UPDATE ON evidence_clips
  FOR EACH ROW EXECUTE FUNCTION evidence_identity_is_immutable();

-- ─────────────────────────────────────────────────────────────────────────────
-- Gap analysis views
-- ─────────────────────────────────────────────────────────────────────────────
-- Reference Model 1 asks for coverage and gap analysis. These four views are the honest answer:
-- they report what the registry does NOT know as prominently as what it does.

-- Coverage by district, including how much of it is guesswork.
CREATE OR REPLACE VIEW gap_analysis_coverage AS
SELECT
  COALESCE(c.district, '(district unknown)')                             AS district,
  COUNT(*)                                                               AS cameras_total,
  COUNT(*) FILTER (WHERE c.status = 'online')                            AS cameras_online,
  COUNT(*) FILTER (WHERE c.status = 'degraded')                          AS cameras_degraded,
  COUNT(*) FILTER (WHERE c.status = 'offline')                           AS cameras_offline,
  COUNT(*) FILTER (WHERE c.status_source = 'measured')                   AS status_measured,
  COUNT(*) FILTER (WHERE c.status_source = 'portal_claim')               AS status_unverified,
  COUNT(*) FILTER (WHERE c.location_status = 'verified')                 AS location_verified,
  COUNT(*) FILTER (WHERE c.location_status = 'approximate')              AS location_approximate,
  COUNT(*) FILTER (WHERE c.location_status = 'unverified')               AS location_unverified,
  COUNT(*) FILTER (WHERE c.department_id IS NULL)                        AS department_unassigned,
  ROUND(AVG(c.location_uncertainty_m))                                   AS avg_uncertainty_m
FROM cameras c
GROUP BY 1
ORDER BY cameras_total DESC;

-- Cameras that are not currently usable, with the reason. Drives the health panel.
CREATE OR REPLACE VIEW gap_analysis_offline AS
SELECT
  c.portal_id,
  c.name,
  c.district,
  c.status,
  c.status_source,
  c.last_error,
  c.last_seen_at,
  (SELECT h.observed_at FROM camera_health h
    WHERE h.camera_id = c.id ORDER BY h.observed_at DESC LIMIT 1) AS last_health_check
FROM cameras c
WHERE c.status <> 'online'
ORDER BY c.status, c.portal_id;

-- Cameras we cannot place on a map with confidence. Rendered as hollow markers with a circle.
CREATE OR REPLACE VIEW gap_analysis_unverified_locations AS
SELECT
  c.portal_id,
  c.label,
  c.name,
  c.district,
  c.location_status,
  c.location_uncertainty_m,
  (c.geom IS NULL) AS has_no_coordinates
FROM cameras c
WHERE c.location_status <> 'verified'
ORDER BY c.location_status DESC, c.location_uncertainty_m DESC;

-- Cameras with no confirmed owning department. On the Sentinel dataset this is initially ALL of
-- them, because the portal exposes no department field. Surfacing that is the point.
CREATE OR REPLACE VIEW gap_analysis_unassigned_departments AS
SELECT
  c.portal_id,
  c.label,
  c.name,
  c.district,
  (SELECT COUNT(*) FROM department_assignments da
     WHERE da.camera_id = c.id AND da.confirmed) AS confirmed_assignments,
  (SELECT COUNT(*) FROM department_assignments da
     WHERE da.camera_id = c.id AND NOT da.confirmed) AS pending_suggestions
FROM cameras c
WHERE c.department_id IS NULL
ORDER BY c.portal_id;

-- One-row registry summary for the dashboard header.
CREATE OR REPLACE VIEW gap_analysis_summary AS
SELECT
  (SELECT COUNT(*) FROM cameras)                                              AS cameras_total,
  (SELECT COUNT(*) FROM cameras WHERE status = 'online')                      AS online,
  (SELECT COUNT(*) FROM cameras WHERE status = 'degraded')                    AS degraded,
  (SELECT COUNT(*) FROM cameras WHERE status = 'offline')                     AS offline,
  (SELECT COUNT(*) FROM cameras WHERE status_source = 'portal_claim')         AS status_unverified,
  (SELECT COUNT(*) FROM cameras WHERE location_status = 'unverified')         AS location_unverified,
  (SELECT COUNT(*) FROM cameras WHERE department_id IS NULL)                  AS department_unassigned,
  (SELECT COUNT(DISTINCT district) FROM cameras WHERE district IS NOT NULL)   AS districts_covered;
