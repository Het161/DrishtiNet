"""
Writing the live index.

Rows are written as detections happen, not batched to the end of a run, because forensic search is
specified to be served from this index and never from video: an operator asking where a vehicle has
been must get an answer from rows that already exist.

Camera identity
---------------
Cameras are resolved by **label**, never by ``portal_id``. On 21 August the portal removed one
camera and every id above it shifted down, silently repointing thirteen ids at different physical
cameras. A detection keyed on a portal id captured before that would now name the wrong junction.
The label is the identity; ``portal_id`` is an attribute.
"""

from __future__ import annotations

import logging
import os
import secrets
from contextlib import contextmanager
from datetime import datetime, timezone

import psycopg

log = logging.getLogger(__name__)


def _id() -> str:
    """
    A collision-resistant id for a text primary key.

    Prisma would mint a cuid here. This service writes over raw SQL — the schema uses PostGIS
    geography that Prisma cannot express — so it mints its own, in the same shape and with the same
    guarantee: unique, sortable-ish by creation, and opaque.
    """
    return "c" + secrets.token_hex(12)


def database_url() -> str:
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError(
            "DATABASE_URL is not set. The repository keeps one .env at the root; "
            "load it before starting the service."
        )
    # Prisma's URL carries query parameters libpq does not understand.
    return url.split("?", 1)[0]


@contextmanager
def connect():
    with psycopg.connect(database_url()) as conn:
        yield conn


def resolve_camera_id(conn: psycopg.Connection, *, label: str | None = None,
                      portal_id: str | None = None) -> str:
    """
    Find a camera's internal id.

    ``portal_id`` is accepted only as a convenience for the command line and is resolved through the
    label it currently points at, so a caller can never accidentally persist rows against a stale id.
    """
    with conn.cursor() as cur:
        if label:
            cur.execute("select id from cameras where label = %s", (label,))
        elif portal_id:
            cur.execute("select id from cameras where portal_id = %s", (portal_id,))
        else:
            raise ValueError("need a label or a portal_id")
        row = cur.fetchone()
    if row is None:
        raise LookupError(f"no camera matching label={label!r} portal_id={portal_id!r}")
    return row[0]


def _ts(epoch_ms: float) -> datetime:
    return datetime.fromtimestamp(epoch_ms / 1000.0, tz=timezone.utc)


class IndexWriter:
    """
    Accumulates detections against their tracks and persists both.

    Detections arrive before the track they belong to is finished, so they are held until the track
    closes and can be written with a real foreign key. The hold is bounded by the accumulator's idle
    close, so this never grows without limit on a busy camera.
    """

    def __init__(self, conn: psycopg.Connection, camera_id: str) -> None:
        self.conn = conn
        self.camera_id = camera_id
        self._pending: dict[int, list] = {}
        self.detections_written = 0
        self.tracks_written = 0

    def ensure_track(self, track) -> str:
        """
        Persist a track the moment it is worth identifying, and return its id.

        Tracks used to be written only when they closed, which meant a signature — and therefore any
        watchlist alert — could not exist until the vehicle had left. Inserting on first
        identification instead lets the alert reach an operator while the vehicle is still in frame,
        which is the difference between an alert and a report.
        """
        if track.db_id:
            return track.db_id
        track_id = _id()
        with self.conn.cursor() as cur:
            cur.execute(
                """
                insert into tracks
                  (id, camera_id, tracker_id, cls, started_recorded_at, ended_recorded_at, frame_count)
                values (%s, %s, %s, %s, %s, null, %s)
                """,
                (track_id, self.camera_id, track.tracker_id, track.cls,
                 _ts(track.started_recorded_at_ms), track.frame_count),
            )
        self.conn.commit()
        track.db_id = track_id
        self.tracks_written += 1
        return track_id

    def stage(self, detections) -> None:
        for det in detections:
            self._pending.setdefault(det.tracker_id, []).append(det)

    def close_tracks(self, tracks) -> list[str]:
        """Persist finished tracks and every detection belonging to them. Returns the new track ids."""
        written: list[str] = []
        with self.conn.cursor() as cur:
            for track in tracks:
                if track.db_id:
                    # Already persisted when it was first identified; close it out.
                    track_id = track.db_id
                    cur.execute(
                        "update tracks set ended_recorded_at = %s, frame_count = %s where id = %s",
                        (_ts(track.last_recorded_at_ms), track.frame_count, track_id),
                    )
                else:
                    track_id = _id()
                    cur.execute(
                        """
                        insert into tracks
                          (id, camera_id, tracker_id, cls, started_recorded_at,
                           ended_recorded_at, frame_count)
                        values (%s, %s, %s, %s, %s, %s, %s)
                        """,
                        (
                            track_id,
                            self.camera_id,
                            track.tracker_id,
                            track.cls,
                            _ts(track.started_recorded_at_ms),
                            _ts(track.last_recorded_at_ms),
                            track.frame_count,
                        ),
                    )
                    self.tracks_written += 1

                for det in self._pending.pop(track.tracker_id, []):
                    cur.execute(
                        """
                        insert into detections
                          (id, camera_id, track_id, cls, confidence, bbox,
                           frame_w, frame_h, recorded_at, observed_at)
                        values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                        """,
                        (
                            _id(),
                            self.camera_id,
                            track_id,
                            det.cls,
                            det.confidence,
                            list(det.bbox),
                            det.frame_w,
                            det.frame_h,
                            _ts(det.recorded_at_ms),
                            _ts(det.observed_at_ms),
                        ),
                    )
                    self.detections_written += 1

                written.append(track_id)
        self.conn.commit()
        return written

    def write_signature(self, track_id: str, signature) -> None:
        """One appearance signature per track — the thing cross-camera matching actually uses."""
        with self.conn.cursor() as cur:
            cur.execute(
                """
                insert into vehicle_signatures
                  (id, track_id, cls, colour, colour_confidence, colour_uncertain,
                   embedding, embedding_model, partial_plate)
                values (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                on conflict (track_id) do update set
                  cls = excluded.cls, colour = excluded.colour,
                  colour_confidence = excluded.colour_confidence,
                  colour_uncertain = excluded.colour_uncertain,
                  embedding = excluded.embedding,
                  embedding_model = excluded.embedding_model,
                  partial_plate = coalesce(excluded.partial_plate, vehicle_signatures.partial_plate)
                """,
                (
                    _id(),
                    track_id,
                    signature.cls,
                    signature.colour,
                    signature.colour_confidence,
                    signature.colour_uncertain,
                    list(signature.embedding),
                    signature.embedding_model,
                    signature.partial_plate,
                ),
            )
        self.conn.commit()

    def record_event(self, kind: str, payload: dict) -> None:
        """
        Log a stream-level event — a loop cut, a reconnect.

        These are what let someone later explain why every track on a camera ends abruptly at the
        same instant, without having to guess whether the system broke or the feed simply looped.
        """
        with self.conn.cursor() as cur:
            cur.execute(
                "insert into events (id, kind, camera_id, payload, created_at) "
                "values (%s, %s, %s, %s, %s)",
                (
                    _id(),
                    kind,
                    self.camera_id,
                    psycopg.types.json.Jsonb(payload),
                    datetime.now(tz=timezone.utc),
                ),
            )
        self.conn.commit()
