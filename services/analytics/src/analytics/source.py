"""
Reading frames from a camera, with the live-stream rules actually applied.

``timing.py`` holds the rules as pure units so they can be proven without a network. This module is
where they meet a real decoder: it opens a source, samples on a PTS grid, anchors absolute time
after the join burst, and reports the loop cut rather than letting long-lived state run across it.

Two sources, one code path
--------------------------
A live RTSP URL and a local fixture file are read identically: open, pull frames, take PTS from the
container, never seek. That is deliberate. The grid is live RTSP with no seeking, so a development
path that seeks or that trusts a file's uniform cadence would grow habits that fail on the night.
The only difference is the transport options, which are meaningless for a file.

Fixtures are offline development material only — pre-migration captures under ``data/fixtures/``.
Nothing here presents them as live.
"""

from __future__ import annotations

import logging
import os
import time
from collections.abc import Iterator
from dataclasses import dataclass

import cv2

from .timing import (
    AbsoluteTimeAnchor,
    Frame,
    PtsDiscontinuityDetector,
    PtsGridSampler,
    backoff_delay_ms,
    is_benign_decoder_warning,
    is_fatal_stream_error,
    opencv_capture_options,
)

log = logging.getLogger(__name__)


@dataclass
class SampledFrame:
    """A frame chosen by the PTS grid, with both clocks and the absolute estimate."""

    image: "cv2.typing.MatLike"
    pts_ms: float
    arrival_ms: float
    #: ``anchor + pts``, or None while the anchor is still settling. Never a substitute for
    #: recorded_at, which additionally carries the camera's measured clock drift.
    absolute_ms: float | None
    #: True when this frame begins a new continuous segment — a loop cut, or a reconnect.
    starts_new_segment: bool
    frame_w: int
    frame_h: int


class FrameSource:
    """
    A supervised reader for one camera.

    Reconnects with the documented backoff on failure, and surfaces a loop cut as a flag on the
    frame rather than swallowing it, because only the caller knows what state has to be torn down.
    """

    def __init__(
        self,
        url: str,
        *,
        sample_fps: float = 5.0,
        max_reconnects: int | None = None,
        is_live: bool | None = None,
    ) -> None:
        self.url = url
        self.sample_fps = sample_fps
        self.max_reconnects = max_reconnects
        # A file has no transport options to set and no reason to reconnect on clean EOF.
        self.is_live = is_live if is_live is not None else url.startswith(("rtsp://", "http://", "https://"))

        self._sampler = PtsGridSampler(1000.0 / sample_fps)
        self._anchor = AbsoluteTimeAnchor()
        self._discontinuity = PtsDiscontinuityDetector()
        self._cap: cv2.VideoCapture | None = None

    # ── connection ──────────────────────────────────────────────────────────

    def _open(self) -> cv2.VideoCapture:
        if self.is_live:
            # The only way to force TCP through cv2.VideoCapture is the FFmpeg environment. Set it
            # immediately before opening: OpenCV reads it at capture construction.
            os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = opencv_capture_options()
        cap = cv2.VideoCapture(self.url, cv2.CAP_FFMPEG)
        if not cap.isOpened():
            raise ConnectionError(f"could not open {self.url}")
        return cap

    def _reset_stream_state(self) -> None:
        """PTS is not comparable across a discontinuity, so nothing derived from it survives one."""
        self._sampler.reset()
        self._anchor.reset()
        self._discontinuity.reset()

    # ── reading ─────────────────────────────────────────────────────────────

    def frames(self) -> Iterator[SampledFrame]:
        """
        Yield frames chosen by the PTS grid, reconnecting as required.

        Never raises on an ordinary stream failure — that is what backoff is for. A genuinely fatal
        error (auth, no route) is raised, because retrying it would be hammering a door that is
        closed on purpose.
        """
        attempt = 0
        pending_new_segment = False

        while True:
            try:
                self._cap = self._open()
            except ConnectionError as err:
                if is_fatal_stream_error(str(err)) or not self.is_live:
                    raise
                if self.max_reconnects is not None and attempt >= self.max_reconnects:
                    return
                delay = backoff_delay_ms(attempt, jitter=time.monotonic() % 1.0)
                log.warning("open failed (%s); reconnecting in %d ms", err, delay)
                time.sleep(delay / 1000.0)
                attempt += 1
                continue

            attempt = 0
            self._reset_stream_state()
            pending_new_segment = True

            try:
                yield from self._read_until_eof(pending_new_segment)
            finally:
                if self._cap is not None:
                    self._cap.release()
                    self._cap = None

            if not self.is_live:
                return  # A file that reached its end is done, not broken.

            # A live feed that ended is a supervised restart, which is expected. Treat the next
            # frames as a new segment: the scene may have cut.
            delay = backoff_delay_ms(attempt, jitter=time.monotonic() % 1.0)
            log.info("stream ended; reconnecting in %d ms", delay)
            time.sleep(delay / 1000.0)
            attempt += 1
            if self.max_reconnects is not None and attempt > self.max_reconnects:
                return

    def _read_until_eof(self, first_segment: bool) -> Iterator[SampledFrame]:
        assert self._cap is not None
        cap = self._cap
        pending_new_segment = first_segment
        consecutive_failures = 0

        while True:
            ok, image = cap.read()
            if not ok:
                # A handful of failed reads mid-stream is join noise or a brief gap, not the end.
                consecutive_failures += 1
                if consecutive_failures > 30:
                    return
                continue
            consecutive_failures = 0

            arrival_ms = time.time() * 1000.0
            # CAP_PROP_POS_MSEC is the container's PTS. CAP_PROP_FPS is never consulted: the
            # declared rate does not match delivery, and using it would corrupt every velocity.
            pts_ms = cap.get(cv2.CAP_PROP_POS_MSEC)

            if self._discontinuity.observe(pts_ms):
                # A loop cut. Everything derived from the old timeline is now meaningless.
                self._reset_stream_state()
                self._discontinuity.observe(pts_ms)
                pending_new_segment = True

            frame = Frame(pts_ms=pts_ms, arrival_ms=arrival_ms)
            self._anchor.observe(frame)

            chosen = self._sampler.offer(frame)
            if chosen is None:
                continue

            starts_new = pending_new_segment
            pending_new_segment = False

            h, w = image.shape[:2]
            yield SampledFrame(
                image=image,
                pts_ms=chosen.pts_ms,
                arrival_ms=chosen.arrival_ms,
                absolute_ms=self._anchor.absolute_ms(chosen),
                starts_new_segment=starts_new,
                frame_w=w,
                frame_h=h,
            )

    @property
    def anchor_settled(self) -> bool:
        return self._anchor.is_settled


def log_decoder_message(message: str) -> None:
    """
    Route a decoder message by severity.

    Join noise on an H.265 stream is logged and forgotten; four of the grid's cameras are H.265 and
    treating their first second as a failure would make them all look broken on every connect.
    """
    if is_benign_decoder_warning(message):
        log.debug("decoder (benign, expected until first IDR): %s", message)
    elif is_fatal_stream_error(message):
        log.error("decoder (fatal): %s", message)
    else:
        log.warning("decoder: %s", message)
