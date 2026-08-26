"""
The organisers' §4 checklist, asserted against the Python pipeline.

``services/stream-gateway/tests/conformance/`` proves these rules for the TypeScript gateway. This
file proves the same rules for the Python consumer that timestamps the same frames. Where an
assertion has a counterpart there, the numbers are identical on purpose — if someone changes a
constant on one side and not the other, one of these two suites fails.
"""

from __future__ import annotations

import pytest

from analytics.timing import (
    BACKOFF_MAX_MS,
    BACKOFF_MIN_MS,
    AbsoluteTimeAnchor,
    DiscontinuitySignal,
    Frame,
    PtsDiscontinuityDetector,
    PtsGridSampler,
    backoff_delay_ms,
    is_benign_decoder_warning,
    is_discontinuity,
    is_fatal_stream_error,
    opencv_capture_options,
)


class TestRtspForcedOverTcp:
    """§4.1 — UDP through NAT yields corrupt frames that look like model bugs."""

    def test_transport_is_tcp(self) -> None:
        assert "rtsp_transport;tcp" in opencv_capture_options()

    def test_never_paces_a_live_source(self) -> None:
        # `-re` paces a file at real time; on a live source it fights the stream's own clock.
        assert "-re" not in opencv_capture_options()

    def test_timeout_is_configurable_and_present(self) -> None:
        assert "stimeout;10000000" in opencv_capture_options()
        assert "stimeout;3000000" in opencv_capture_options(3_000_000)


class TestReconnectBackoff:
    """§4.5 — exponential backoff, 2 s → 30 s cap."""

    def test_starts_at_the_documented_minimum(self) -> None:
        assert backoff_delay_ms(0, jitter=1.0) == BACKOFF_MIN_MS

    def test_doubles(self) -> None:
        assert backoff_delay_ms(1, jitter=1.0) == 4_000
        assert backoff_delay_ms(2, jitter=1.0) == 8_000

    def test_caps_at_thirty_seconds(self) -> None:
        for attempt in range(4, 40):
            assert backoff_delay_ms(attempt, jitter=1.0) <= BACKOFF_MAX_MS

    def test_never_retries_in_a_tight_loop(self) -> None:
        # The failure this guards against is hammering shared infrastructure we are a guest on.
        for attempt in range(0, 20):
            assert backoff_delay_ms(attempt, jitter=0.0) >= BACKOFF_MIN_MS / 2

    def test_jitter_spreads_a_reconnecting_fleet(self) -> None:
        delays = {backoff_delay_ms(5, jitter=i / 30) for i in range(30)}
        assert len(delays) > 1, "thirty cameras would retry on the same millisecond"

    def test_jitter_out_of_range_is_clamped_not_crashed(self) -> None:
        assert backoff_delay_ms(3, jitter=-5) == backoff_delay_ms(3, jitter=0)
        assert backoff_delay_ms(3, jitter=99) <= BACKOFF_MAX_MS


class TestDecoderWarnings:
    """§4.6 — join noise is normal until the first IDR and must never be fatal."""

    @pytest.mark.parametrize(
        "message",
        [
            "Could not find ref with POC 12",
            "[hevc @ 0x1] Error constructing the frame RPS",
            "missing picture in access unit with size 4",
            "non-existing PPS 0 referenced",
            "decode_slice_header error",
            "corrupted macroblock 4 12",
        ],
    )
    def test_benign_join_noise_is_not_fatal(self, message: str) -> None:
        assert is_benign_decoder_warning(message)
        assert not is_fatal_stream_error(message)

    @pytest.mark.parametrize(
        "message",
        [
            "Connection refused",
            "401 Unauthorized",
            "403 Forbidden",
            "No route to host",
            "Invalid data found when processing input",
        ],
    )
    def test_real_failures_are_fatal(self, message: str) -> None:
        assert is_fatal_stream_error(message)

    def test_benign_wins_over_fatal_when_both_could_match(self) -> None:
        # A benign classification must never be overridden, or H.265 cameras look broken on join.
        assert not is_fatal_stream_error("RPS: Server returned 500")


class TestPtsGridSampling:
    """§4.2 / §4.3 / §4.4 — declared fps and arrival time never drive timing."""

    def test_samples_near_the_grid_despite_jittery_intervals(self) -> None:
        sampler = PtsGridSampler(200)  # 5 fps
        # Deliberately non-uniform: 33, 50, 17 ms gaps, as the reference warns to expect.
        pts, t = [], 0.0
        for gap in [33, 50, 17, 41, 33, 25, 60, 33, 33, 45] * 6:
            t += gap
            pts.append(t)

        emitted = [f.pts_ms for p in pts if (f := sampler.offer(Frame(p, p))) is not None]

        assert len(emitted) >= 5
        gaps = [b - a for a, b in zip(emitted, emitted[1:])]
        # Every emitted gap should sit near the 200 ms grid, never at the raw frame cadence.
        assert all(150 <= g <= 260 for g in gaps), gaps

    def test_join_burst_is_not_oversampled(self) -> None:
        """
        The buffered GOP arrives far faster than real time. Sampling on arrival would take dozens of
        frames from the first second; sampling on PTS takes the same number as any other second.
        """
        sampler = PtsGridSampler(200)
        # 2 s of PTS delivered in 100 ms of wall-clock: the burst.
        burst = [Frame(pts_ms=i * 40, arrival_ms=i * 2) for i in range(50)]
        emitted = [f for f in (sampler.offer(fr) for fr in burst) if f is not None]
        # 2000 ms of stream at a 200 ms grid is ~10 samples, regardless of how fast it arrived.
        assert 9 <= len(emitted) <= 11, len(emitted)

    def test_a_long_gap_does_not_queue_catch_up_ticks(self) -> None:
        sampler = PtsGridSampler(200)
        sampler.offer(Frame(0, 0))
        # A 3 s stall, then resume. Naive tick advancing would emit 15 catch-up samples of one frame.
        emitted = [f for f in (sampler.offer(Frame(p, p)) for p in (3_000, 3_040)) if f is not None]
        assert len(emitted) == 1

    def test_reset_clears_the_grid_across_a_discontinuity(self) -> None:
        sampler = PtsGridSampler(200)
        sampler.offer(Frame(10_000, 10_000))
        sampler.reset()
        # After a loop, PTS restarts near zero; without the reset nothing would ever be emitted.
        assert sampler.offer(Frame(0, 0)) is not None

    def test_rejects_a_nonsensical_interval(self) -> None:
        with pytest.raises(ValueError):
            PtsGridSampler(0)


class TestAbsoluteTimeAnchor:
    """The anchor must survive the join burst, or every timestamp from that camera is offset."""

    def test_burst_frames_never_set_the_anchor(self) -> None:
        anchor = AbsoluteTimeAnchor(settle_ms=1_000, burst_guard_ms=1_500)
        # Burst: arrival races ahead of PTS, so (arrival − PTS) is wildly wrong and very small.
        for i in range(40):
            anchor.observe(Frame(pts_ms=i * 40, arrival_ms=1_000_000 + i * 2))
        assert anchor.anchor_ms is None, "the replayed GOP was allowed to set the anchor"

    def test_settles_on_the_least_delayed_frame(self) -> None:
        anchor = AbsoluteTimeAnchor(settle_ms=1_000, burst_guard_ms=100)
        base = 500_000.0
        # Steady state: arrival = PTS + 5000, plus per-frame network delay that only ever adds.
        for i in range(200):
            pts = i * 40.0
            delay = 3.0 if i != 120 else 0.0  # one frame arrives with no queueing at all
            anchor.observe(Frame(pts_ms=pts, arrival_ms=base + pts + delay))
        assert anchor.is_settled
        # min(arrival − pts) picks the least-delayed frame, not the average.
        assert anchor.anchor_ms == pytest.approx(base, abs=0.001)

    def test_absolute_time_is_anchor_plus_pts(self) -> None:
        anchor = AbsoluteTimeAnchor(settle_ms=100, burst_guard_ms=0)
        anchor.observe(Frame(pts_ms=0, arrival_ms=1_000))
        anchor.observe(Frame(pts_ms=200, arrival_ms=1_200))
        assert anchor.absolute_ms(Frame(pts_ms=5_000, arrival_ms=0)) == 6_000

    def test_reset_forgets_the_previous_connection(self) -> None:
        anchor = AbsoluteTimeAnchor(settle_ms=10, burst_guard_ms=0)
        anchor.observe(Frame(0, 1_000))
        anchor.reset()
        assert anchor.anchor_ms is None and not anchor.is_settled


class TestLoopRecovery:
    """§4.8 — every feed loops with a hard scene cut."""

    def test_backwards_pts_is_a_discontinuity(self) -> None:
        d = PtsDiscontinuityDetector()
        d.observe(10_000)
        assert d.observe(0) is True

    def test_a_large_forward_jump_is_a_discontinuity(self) -> None:
        d = PtsDiscontinuityDetector(max_forward_gap_ms=5_000)
        d.observe(1_000)
        assert d.observe(9_000) is True

    def test_ordinary_jitter_is_not_a_discontinuity(self) -> None:
        d = PtsDiscontinuityDetector()
        d.observe(1_000)
        for pts in (1_040, 1_073, 1_090, 1_140):
            assert d.observe(pts) is False

    def test_first_frame_is_never_a_discontinuity(self) -> None:
        assert PtsDiscontinuityDetector().observe(12_345) is False

    def test_any_single_signal_triggers_recovery(self) -> None:
        assert is_discontinuity(DiscontinuitySignal(pts_jump=True))
        assert is_discontinuity(DiscontinuitySignal(scene_cut=True))
        assert is_discontinuity(DiscontinuitySignal(clock_went_backwards=True))
        assert not is_discontinuity(DiscontinuitySignal())
