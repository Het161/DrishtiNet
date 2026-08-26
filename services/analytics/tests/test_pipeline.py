"""
Pipeline behaviour around the loop cut.

Every feed on this grid is a continuous recording that loops, and at the loop point the scene cuts
abruptly. The failure this file guards against is not a crash — it is a tracker that carries ids
across the cut and stitches two unrelated vehicles into one journey. In an investigation that is not
a glitch, it is a false conclusion, and nothing downstream can detect it.
"""

from __future__ import annotations

import numpy as np
import pytest

from analytics.pipeline import Detection, Detector, TrackAccumulator, run
from analytics.source import SampledFrame


def frame(pts_ms: float, *, new_segment: bool = False) -> SampledFrame:
    return SampledFrame(
        image=np.zeros((64, 64, 3), dtype=np.uint8),
        pts_ms=pts_ms,
        arrival_ms=pts_ms,
        absolute_ms=pts_ms,
        starts_new_segment=new_segment,
        frame_w=64,
        frame_h=64,
    )


def detection(tracker_id: int, recorded_at_ms: float, cls: str = "car") -> Detection:
    return Detection(
        cls=cls,
        confidence=0.9,
        bbox=(0.0, 0.0, 10.0, 10.0),
        tracker_id=tracker_id,
        frame_w=64,
        frame_h=64,
        pts_ms=recorded_at_ms,
        recorded_at_ms=recorded_at_ms,
        observed_at_ms=recorded_at_ms,
    )


class FakeDetector(Detector):
    """A detector with no model, so the loop semantics can be tested without inference."""

    def __init__(self, per_frame: dict[float, list[Detection]]) -> None:
        self.per_frame = per_frame
        self.resets = 0

    def reset_tracker(self) -> None:
        self.resets += 1

    def detect(self, frame, recorded_at_ms):  # noqa: ANN001 - matches the base signature
        return self.per_frame.get(frame.pts_ms, [])


class TestTrackAccumulator:
    def test_opens_a_track_on_first_sight(self) -> None:
        acc = TrackAccumulator()
        acc.update([detection(1, 1_000)], np.zeros((64, 64, 3), dtype=np.uint8))
        assert acc.open_count == 1

    def test_closes_a_track_that_has_not_been_seen(self) -> None:
        acc = TrackAccumulator()
        img = np.zeros((64, 64, 3), dtype=np.uint8)
        acc.update([detection(1, 1_000)], img)
        assert acc.close_idle(1_500) == []            # still recent
        closed = acc.close_idle(5_000)                 # past IDLE_CLOSE_MS
        assert [t.tracker_id for t in closed] == [1]
        assert acc.open_count == 0

    def test_keeps_a_bounded_number_of_crops(self) -> None:
        # A vehicle parked in view for ten minutes must not accumulate ten minutes of crops.
        acc = TrackAccumulator()
        img = np.full((64, 64, 3), 255, dtype=np.uint8)
        for i in range(200):
            acc.update([detection(1, 1_000 + i * 100)], img)
        track = acc.close_all()[0]
        assert len(track.crops) <= TrackAccumulator.MAX_CROPS

    def test_frame_count_and_span_follow_the_detections(self) -> None:
        acc = TrackAccumulator()
        img = np.zeros((64, 64, 3), dtype=np.uint8)
        for pts in (1_000, 1_333, 1_666):
            acc.update([detection(7, pts)], img)
        track = acc.close_all()[0]
        assert track.frame_count == 3
        assert track.started_recorded_at_ms == 1_000
        assert track.last_recorded_at_ms == 1_666


class TestLoopRecovery:
    def test_a_loop_closes_every_open_track_before_the_new_scene(self) -> None:
        closed_batches: list[list] = []
        det = FakeDetector({
            0.0: [detection(1, 0)],
            333.0: [detection(1, 333)],
            # After the cut the tracker restarts; id 1 here is a different vehicle entirely.
            0.5: [detection(1, 10_000)],
        })
        frames = [frame(0.0, new_segment=True), frame(333.0), frame(0.5, new_segment=True)]

        stats = run(
            iter(frames),
            det,
            recorded_at_for=lambda f: f.pts_ms if f.pts_ms > 1 else f.pts_ms,
            on_track_closed=closed_batches.append,
        )

        assert stats.discontinuities == 1, "the loop was not detected"
        assert det.resets >= 2, "tracker state survived the cut"
        # The pre-cut track must be closed in its own batch, never merged with the post-cut one.
        assert closed_batches, "nothing was closed at the cut"
        first_batch_ids = [t.tracker_id for t in closed_batches[0]]
        assert first_batch_ids == [1]

    def test_the_first_segment_is_a_start_not_a_discontinuity(self) -> None:
        """
        A stream beginning is not a stream breaking.

        Counting it would write a `camera.loop` into the audit trail for something that never
        happened, and that trail exists to explain why every track on a camera ends at one instant.
        Entries describing nothing make the real ones harder to trust.
        """
        events: list = []
        det = FakeDetector({0.0: [detection(1, 0)]})
        stats = run(
            iter([frame(0.0, new_segment=True)]),
            det,
            recorded_at_for=lambda f: f.pts_ms,
            on_discontinuity=events.append,
        )
        assert stats.discontinuities == 0
        assert events == []

    def test_tracks_still_open_at_shutdown_are_persisted(self) -> None:
        # Otherwise a vehicle present when the run ends vanishes from the index entirely.
        closed: list = []
        det = FakeDetector({0.0: [detection(4, 0)]})
        run(
            iter([frame(0.0, new_segment=True)]),
            det,
            recorded_at_for=lambda f: f.pts_ms,
            on_track_closed=closed.append,
        )
        assert [t.tracker_id for batch in closed for t in batch] == [4]


class TestClassFiltering:
    def test_counts_reflect_only_kept_classes(self) -> None:
        det = FakeDetector({0.0: [detection(1, 0, cls="car"), detection(2, 0, cls="person")]})
        stats = run(iter([frame(0.0, new_segment=True)]), det, recorded_at_for=lambda f: f.pts_ms)
        assert stats.detections == 2  # both are kept classes; filtering happens in Detector.detect

    def test_untracked_detections_do_not_open_tracks(self) -> None:
        # A detection the tracker could not associate has no identity to accumulate against.
        acc = TrackAccumulator()
        orphan = detection(1, 0)
        orphan.tracker_id = None
        acc.update([orphan], np.zeros((64, 64, 3), dtype=np.uint8))
        assert acc.open_count == 0
