"""
Frames to tracks: detect, associate, and write the index as it happens.

The index is written continuously rather than in a batch at the end, because forensic search is
specified to be served from the live index and never from video — an operator asking "where has this
vehicle been" must get an answer in under 200 ms from rows that already exist.

Timing discipline
-----------------
Two timestamps travel with every row and they are not interchangeable:

  ``recorded_at``  the forensic time an operator sees, and the only thing used to correlate across
                   cameras. Derived from PTS plus the camera's measured clock drift.
  ``observed_at``  when we happened to receive the frame. Latency instrumentation only. Using it to
                   order events across cameras would be meaningless, because the cameras are
                   replaying recorded footage.

Classes we keep
---------------
The challenge is vehicle-led, so vehicle classes are the point. People are retained because the
watchlist schema covers missing and wanted persons, but no face recognition is performed anywhere:
CLAUDE.md commits to documented integration-readiness only, and that commitment is worth more than
the feature.
"""

from __future__ import annotations

import logging
from collections.abc import Iterator
from dataclasses import dataclass, field

from .source import SampledFrame

log = logging.getLogger(__name__)

#: COCO classes worth indexing. Everything else is discarded at the detector rather than stored and
#: filtered later — an unused row still costs an insert, an index entry and disk.
VEHICLE_CLASSES = {"car", "motorcycle", "bus", "truck", "bicycle"}
PERSON_CLASSES = {"person"}
KEPT_CLASSES = VEHICLE_CLASSES | PERSON_CLASSES


@dataclass
class Detection:
    cls: str
    confidence: float
    bbox: tuple[float, float, float, float]  # x1, y1, x2, y2 in pixels of the analysed frame
    tracker_id: int | None
    frame_w: int
    frame_h: int
    pts_ms: float
    recorded_at_ms: float
    observed_at_ms: float


@dataclass
class OpenTrack:
    """A track being accumulated, persisted from the moment it opens."""

    tracker_id: int
    cls: str
    started_recorded_at_ms: float
    last_recorded_at_ms: float
    frame_count: int = 0
    #: Database id, assigned when the track is first persisted.
    db_id: str | None = None
    #: Frame count at which a signature was last emitted, so it is not recomputed every frame.
    signature_at_frame: int = 0
    #: Crops kept for the appearance embedding and colour estimate. Bounded deliberately: a track
    #: that lingers for ten minutes must not accumulate ten minutes of crops in memory.
    crops: list = field(default_factory=list)
    best_crop_area: float = 0.0

    def observe(self, recorded_at_ms: float) -> None:
        self.last_recorded_at_ms = recorded_at_ms
        self.frame_count += 1


class TrackAccumulator:
    """
    Holds open tracks for one camera and closes them on disappearance or discontinuity.

    The loop cut is the case that matters. Every feed loops with a hard scene cut, and a tracker
    that carries ids across it will stitch two unrelated vehicles into one journey — which in an
    investigation is not a glitch but a false conclusion.
    """

    #: How many crops to retain per track for the appearance embedding.
    MAX_CROPS = 8
    #: A track unseen for this long in forensic time is finished.
    IDLE_CLOSE_MS = 2_000.0

    #: Frames after which a provisional signature is emitted, while the vehicle is still in view.
    #:
    #: Waiting for the track to close before identifying anything would mean every watchlist alert
    #: arrives after the vehicle has left the junction — accurate, and useless to the officer being
    #: asked to intercept it. Four frames at the 3-5 fps sample grid is roughly a second of footage,
    #: which is enough for a stable appearance embedding and still inside the time a vehicle is
    #: crossing frame.
    EARLY_SIGNATURE_FRAMES = 4
    #: Re-emit as more views accumulate: a later signature is built from more angles and supersedes
    #: the earlier one, so a vehicle that was ambiguous at four frames can still be matched at ten.
    RESIGNATURE_EVERY = 12

    def __init__(self) -> None:
        self._open: dict[int, OpenTrack] = {}

    def update(self, detections: list[Detection], image) -> None:
        for det in detections:
            if det.tracker_id is None:
                continue
            track = self._open.get(det.tracker_id)
            if track is None:
                track = OpenTrack(
                    tracker_id=det.tracker_id,
                    cls=det.cls,
                    started_recorded_at_ms=det.recorded_at_ms,
                    last_recorded_at_ms=det.recorded_at_ms,
                )
                self._open[det.tracker_id] = track
            track.observe(det.recorded_at_ms)

            # Keep the largest crops: a distant 20-pixel car contributes nothing usable to an
            # appearance embedding, and keeping it would dilute the ones that do.
            x1, y1, x2, y2 = (int(v) for v in det.bbox)
            x1, y1 = max(0, x1), max(0, y1)
            crop = image[y1:y2, x1:x2]
            if crop.size == 0:
                continue
            area = float((x2 - x1) * (y2 - y1))
            if len(track.crops) < self.MAX_CROPS:
                track.crops.append(crop)
                track.best_crop_area = max(track.best_crop_area, area)
            elif area > track.best_crop_area:
                track.crops[0] = crop
                track.best_crop_area = area

    def due_for_signature(self) -> list[OpenTrack]:
        """
        Tracks with enough views to identify, that have not been published at this length yet.

        This is what makes an alert arrive while the vehicle is still on screen rather than after it
        has gone.
        """
        due = []
        for track in self._open.values():
            if track.cls not in VEHICLE_CLASSES:
                continue
            if track.frame_count < self.EARLY_SIGNATURE_FRAMES:
                continue
            if track.signature_at_frame == 0 or (
                track.frame_count - track.signature_at_frame >= self.RESIGNATURE_EVERY
            ):
                track.signature_at_frame = track.frame_count
                due.append(track)
        return due

    def close_idle(self, now_recorded_at_ms: float) -> list[OpenTrack]:
        """Close tracks not seen recently. Returns the closed ones for persistence."""
        done = [
            t for t in self._open.values()
            if now_recorded_at_ms - t.last_recorded_at_ms > self.IDLE_CLOSE_MS
        ]
        for t in done:
            del self._open[t.tracker_id]
        return done

    def close_all(self) -> list[OpenTrack]:
        """Close everything — on a loop cut, a reconnect, or shutdown."""
        done = list(self._open.values())
        self._open.clear()
        return done

    @property
    def open_count(self) -> int:
        return len(self._open)


class Detector:
    """
    Ultralytics YOLO with ByteTrack association.

    Sampling already happened on a PTS grid, which is what makes ByteTrack usable here: its motion
    model assumes a roughly constant interval between updates, and raw frame delivery on this grid
    is explicitly non-uniform. Feeding it every Nth frame would give it a varying dt it reads as
    erratic velocity.
    """

    def __init__(
        self,
        weights: str,
        *,
        device: str = "cpu",
        imgsz: int = 640,
        confidence: float = 0.35,
    ) -> None:
        from ultralytics import YOLO  # imported lazily so the module is importable without torch

        self.model = YOLO(weights)
        self.device = device
        self.imgsz = imgsz
        self.confidence = confidence
        self._names: dict[int, str] | None = None

    def reset_tracker(self) -> None:
        """
        Drop all tracker state.

        Called on a loop cut and on reconnect. Without it ByteTrack keeps matching ids across the
        discontinuity, and the ids are what the route reconstruction is built from.
        """
        predictor = getattr(self.model, "predictor", None)
        trackers = getattr(predictor, "trackers", None) if predictor else None
        if trackers:
            for tracker in trackers:
                if hasattr(tracker, "reset"):
                    tracker.reset()

    def detect(self, frame: SampledFrame, recorded_at_ms: float) -> list[Detection]:
        results = self.model.track(
            frame.image,
            persist=True,
            tracker="bytetrack.yaml",
            imgsz=self.imgsz,
            conf=self.confidence,
            device=self.device,
            verbose=False,
        )
        if not results:
            return []
        result = results[0]
        if self._names is None:
            self._names = result.names

        boxes = result.boxes
        if boxes is None or boxes.id is None:
            return []

        out: list[Detection] = []
        ids = boxes.id.tolist()
        for xyxy, cls_idx, conf, tid in zip(
            boxes.xyxy.tolist(), boxes.cls.tolist(), boxes.conf.tolist(), ids
        ):
            name = self._names[int(cls_idx)]
            if name not in KEPT_CLASSES:
                continue
            out.append(
                Detection(
                    cls=name,
                    confidence=float(conf),
                    bbox=(xyxy[0], xyxy[1], xyxy[2], xyxy[3]),
                    tracker_id=int(tid),
                    frame_w=frame.frame_w,
                    frame_h=frame.frame_h,
                    pts_ms=frame.pts_ms,
                    recorded_at_ms=recorded_at_ms,
                    observed_at_ms=frame.arrival_ms,
                )
            )
        return out


@dataclass
class PipelineStats:
    frames: int = 0
    detections: int = 0
    tracks_closed: int = 0
    discontinuities: int = 0
    signatures_emitted: int = 0


def run(
    source_frames: Iterator[SampledFrame],
    detector: Detector,
    *,
    recorded_at_for,
    on_detections=None,
    on_track_closed=None,
    on_discontinuity=None,
    on_signature_ready=None,
) -> PipelineStats:
    """
    Drive one camera end to end.

    ``recorded_at_for(frame)`` converts a sampled frame to forensic epoch milliseconds. It is
    injected rather than computed here because the conversion needs the camera's slot start and
    measured drift, which belong to the catalogue rather than to the pipeline.
    """
    accumulator = TrackAccumulator()
    stats = PipelineStats()
    started = False

    for frame in source_frames:
        if frame.starts_new_segment:
            # Close every open track before the new segment contributes a single detection to one.
            closed = accumulator.close_all()
            detector.reset_tracker()
            stats.tracks_closed += len(closed)
            if closed and on_track_closed:
                on_track_closed(closed)

            # The first segment is the stream starting, not the stream breaking. Counting it as a
            # discontinuity would put a `camera.loop` in the audit trail for something that never
            # happened — and that trail is meant to explain why every track on a camera ends at the
            # same instant. An entry that describes nothing makes the real ones harder to trust.
            if started:
                stats.discontinuities += 1
                if on_discontinuity:
                    on_discontinuity(frame)
            started = True

        recorded_at_ms = recorded_at_for(frame)
        detections = detector.detect(frame, recorded_at_ms)
        stats.frames += 1
        stats.detections += len(detections)

        accumulator.update(detections, frame.image)
        if detections and on_detections:
            on_detections(detections)

        # Identify while the vehicle is still in frame, not once it has gone.
        if on_signature_ready:
            due = accumulator.due_for_signature()
            if due:
                on_signature_ready(due)

        closed = accumulator.close_idle(recorded_at_ms)
        if closed:
            stats.tracks_closed += len(closed)
            if on_track_closed:
                on_track_closed(closed)

    remaining = accumulator.close_all()
    if remaining:
        stats.tracks_closed += len(remaining)
        if on_track_closed:
            on_track_closed(remaining)
    return stats
