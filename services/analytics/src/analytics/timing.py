"""
Live-stream timing rules, in Python.

These are a deliberate port of ``services/stream-gateway/src/live/stream-reader.ts``, which the
conformance suite already proves against the organisers' §4 checklist. The gateway is TypeScript and
this service is Python, so the code cannot be shared — but the *behaviour* must not diverge, because
both processes timestamp the same frames and a disagreement between them would corrupt cross-camera
correlation in a way that is very hard to see and impossible to defend in an investigation.

Every constant here is therefore copied, not chosen, and ``tests/test_timing.py`` mirrors the
gateway's conformance assertions so a change on one side that is not made on the other fails loudly.

The rules, and why each exists:

  §4.1  RTSP is forced over TCP. UDP through NAT drops packets and yields corrupt frames that
        look exactly like model bugs.
  §4.2  CAP_PROP_FPS is never used for timing — the declared rate does not match delivery.
  §4.3  Timing comes from PTS, never arrival time.
  §4.4  Frame intervals are not uniform; nothing may assume a fixed cadence.
  §4.5  Reconnect with exponential backoff, 2 s → 30 s.
  §4.6  Decoder warnings while joining mid-GOP are normal until the first IDR.
  §4.8  Every feed loops with a hard scene cut, and long-lived state must recover from it.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass

# ── §4.5 reconnect ──────────────────────────────────────────────────────────────

BACKOFF_MIN_MS = 2_000
BACKOFF_MAX_MS = 30_000


def backoff_delay_ms(attempt: int, jitter: float = 0.0) -> int:
    """
    Delay before reconnect attempt ``attempt`` (0-based), doubling from 2 s, capped at 30 s.

    ``jitter`` in [0, 1) spreads a fleet of reconnecting cameras so they do not retry in lockstep
    after a shared outage. Thirty cameras hitting the grid on the same millisecond is a thundering
    herd against infrastructure we are a guest on.
    """
    exponential = BACKOFF_MIN_MS * 2 ** max(0, attempt)
    capped = min(exponential, BACKOFF_MAX_MS)
    clamped = min(0.999999, max(0.0, jitter))
    # floor(x + 0.5), not round(): Python rounds halves to even, JavaScript rounds them up, and
    # this function has a counterpart in the gateway that must agree exactly.
    return math.floor(capped / 2 + (capped / 2) * clamped + 0.5)


# ── §4.1 transport ──────────────────────────────────────────────────────────────

#: OpenCV passes these to FFmpeg via the environment. Semicolon-separated ``key;value`` pairs,
#: joined by ``|``. This is the only way to force TCP through cv2.VideoCapture.
OPENCV_CAPTURE_OPTIONS = "rtsp_transport;tcp|stimeout;10000000|fflags;+genpts"


def opencv_capture_options(timeout_us: int = 10_000_000) -> str:
    """
    Value for ``OPENCV_FFMPEG_CAPTURE_OPTIONS``.

    Note the absence of ``-re``: it paces a *file* at real time and is meaningless — actively
    harmful — for a source that is already live, where it would fight the stream's own clock.
    """
    return f"rtsp_transport;tcp|stimeout;{timeout_us}|fflags;+genpts"


# ── §4.6 decoder warnings ───────────────────────────────────────────────────────

_BENIGN_DECODER_WARNINGS = [
    re.compile(p, re.I)
    for p in (
        r"Could not find ref with POC",
        r"missing picture in access unit",
        r"no frame\b",
        r"non-existing PPS",
        r"decode_slice_header error",
        r"Invalid NAL unit size",
        r"short term ref pic set",
        r"RPS",
        r"corrupted macroblock",
        r"Frame num gap",
    )
]

_FATAL_PATTERNS = [
    re.compile(p, re.I)
    for p in (
        r"Connection refused",
        r"No route to host",
        r"401 Unauthorized",
        r"403 Forbidden",
        r"404 Not Found",
        r"Server returned \d+",
        r"Immediate exit requested",
        r"Invalid data found when processing input",
    )
]


def is_benign_decoder_warning(message: str) -> bool:
    """
    True when a decoder message is expected join noise rather than a real failure.

    Treating these as fatal would make every H.265 camera look broken for the first second of every
    connection, and four of the grid's cameras are H.265.
    """
    return any(p.search(message) for p in _BENIGN_DECODER_WARNINGS)


def is_fatal_stream_error(message: str) -> bool:
    """Messages that genuinely mean the connection is not usable."""
    if is_benign_decoder_warning(message):
        return False
    return any(p.search(message) for p in _FATAL_PATTERNS)


# ── §4.3 / §4.4 PTS-driven sampling ─────────────────────────────────────────────


@dataclass(frozen=True)
class Frame:
    """A frame's two clocks, kept deliberately separate."""

    #: Presentation timestamp in milliseconds, from the stream. The only timing we trust.
    pts_ms: float
    #: Wall-clock arrival. Latency instrumentation and anchoring only — never for deltas.
    arrival_ms: float


class PtsGridSampler:
    """
    Selects the frame nearest each tick of a fixed PTS grid.

    Sampling "every Nth frame" is wrong on this grid twice over: frame intervals are not uniform, so
    every Nth frame gives a varying dt that the tracker's motion model reads as erratic velocity;
    and the join burst delivers a buffered GOP faster than real time, so the first second would be
    oversampled. Snapping to a PTS grid gives near-constant dt regardless of delivery.
    """

    def __init__(self, interval_ms: float) -> None:
        if not interval_ms > 0:
            raise ValueError("PTS grid interval must be positive")
        self._interval_ms = interval_ms
        self._next_tick: float | None = None
        self._pending: Frame | None = None

    def offer(self, frame: Frame) -> Frame | None:
        """
        Offer a frame. Returns the frame to process, or ``None``.

        A frame is emitted once the stream has moved past a tick, choosing whichever of the two
        straddling frames is closer to it, so the sample sits as near the grid as the source allows.
        """
        if self._next_tick is None:
            self._next_tick = frame.pts_ms

        if frame.pts_ms < self._next_tick:
            # Before the tick: remember it as a candidate, keeping the latest.
            self._pending = frame
            return None

        previous = self._pending
        self._pending = None
        chosen = (
            previous
            if previous is not None
            and abs(previous.pts_ms - self._next_tick) < abs(frame.pts_ms - self._next_tick)
            else frame
        )

        # Advance past the frame just emitted, so a long gap does not queue a burst of catch-up
        # ticks that would all resolve to the same frame.
        while True:
            self._next_tick += self._interval_ms
            if self._next_tick > chosen.pts_ms:
                break

        return chosen

    def reset(self) -> None:
        """Reset on a loop or reconnect — PTS is not comparable across a discontinuity."""
        self._next_tick = None
        self._pending = None


# ── absolute time anchoring ─────────────────────────────────────────────────────


class AbsoluteTimeAnchor:
    """
    Establishes ``absolute_t = anchor + PTS`` for one connection.

    The anchor is ``min(arrival − PTS)`` over a settling window. The minimum is the right estimator
    because network delay only ever *adds* to arrival: the least-delayed frame is closest to the
    truth, and averaging would bake in the queueing delay of the join burst.

    The burst is why the window exists at all. The gateway replays a buffered group-of-pictures on
    connect, so the first 1–2 s of frames arrive far faster than real time and their (arrival − PTS)
    is badly skewed. Anchoring on those would offset every timestamp from that camera for the life
    of the connection.
    """

    def __init__(self, settle_ms: float = 5_000, burst_guard_ms: float = 1_500) -> None:
        self._settle_ms = settle_ms
        self._burst_guard_ms = burst_guard_ms
        self._best: float | None = None
        self._started_at: float | None = None
        self._settled = False

    def observe(self, frame: Frame) -> None:
        if self._started_at is None:
            self._started_at = frame.arrival_ms
        since_start = frame.arrival_ms - self._started_at

        # Discard the replayed GOP outright rather than letting it compete for the minimum.
        if since_start < self._burst_guard_ms:
            return

        candidate = frame.arrival_ms - frame.pts_ms
        if self._best is None or candidate < self._best:
            self._best = candidate
        if since_start >= self._burst_guard_ms + self._settle_ms:
            self._settled = True

    @property
    def is_settled(self) -> bool:
        """True once the settling window has passed and the anchor may be trusted."""
        return self._settled and self._best is not None

    @property
    def anchor_ms(self) -> float | None:
        """Provisional anchor, usable before settling but subject to change."""
        return self._best

    def absolute_ms(self, frame: Frame) -> float | None:
        """Absolute wall-clock time for a frame, or ``None`` while still settling."""
        if self._best is None:
            return None
        return self._best + frame.pts_ms

    def reset(self) -> None:
        self._best = None
        self._started_at = None
        self._settled = False


# ── §4.8 loop / discontinuity detection ─────────────────────────────────────────


@dataclass(frozen=True)
class DiscontinuitySignal:
    #: PTS jumped backwards, or forwards by more than a plausible gap.
    pts_jump: bool = False
    #: Frame-difference spike consistent with a hard scene cut.
    scene_cut: bool = False
    #: Burned-in clock read earlier than the previous reading.
    clock_went_backwards: bool = False


def is_discontinuity(signal: DiscontinuitySignal) -> bool:
    """
    Any one signal is enough.

    A false positive costs a track reset. A false negative silently merges two different moments in
    time into one track, which in an investigation is far worse.
    """
    return signal.pts_jump or signal.scene_cut or signal.clock_went_backwards


class PtsDiscontinuityDetector:
    """
    Detects a stream discontinuity from PTS alone.

    Backwards PTS is unambiguous. A large forward jump counts too, because a loop can restart at a
    higher timestamp, and because either way the tracker's state no longer describes what is on
    screen.
    """

    def __init__(self, max_forward_gap_ms: float = 5_000) -> None:
        self._max_forward_gap_ms = max_forward_gap_ms
        self._last_pts: float | None = None

    def observe(self, pts_ms: float) -> bool:
        """Returns True when this frame begins a new continuous segment."""
        previous = self._last_pts
        self._last_pts = pts_ms
        if previous is None:
            return False
        if pts_ms < previous:
            return True
        return pts_ms - previous > self._max_forward_gap_ms

    def reset(self) -> None:
        self._last_pts = None
