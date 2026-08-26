"""
Forensic time: turning a frame's PTS into the timestamp an operator will testify to.

A port of the parts of ``services/stream-gateway/src/slot.ts`` this service needs. Same constants,
same arithmetic — ``make xcheck-timing`` exists because two copies of this logic that disagree would
place one vehicle at two different times on two cameras, and that error is invisible until someone
builds a route out of it.

The chain, in the order it is applied:

    absolute_t = anchor + PTS                (anchor established after the join burst)
    p          = absolute_t − slot_start     (position within the 12-hour slot)
    recorded_at = epoch + p + (a + b·p)      (a, b) = this camera's measured drift

``slot_time`` — the portal's own clock, uncorrected — is stored alongside so a reviewer can see what
we were given as well as what we concluded.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

IST = timezone(timedelta(hours=5, minutes=30))

#: Seconds. Feeds loop every 12 hours, with slots starting 09:00 and 21:00 IST.
SLOT_SECONDS = 43_200
SLOT_ANCHOR_SECONDS = 9 * 3600
IST_OFFSET_SECONDS = int(5.5 * 3600)

#: Established by reading the burned-in overlay clock at three known offsets on camera 10.
RECORDING_EPOCH_MS = datetime(2026, 6, 13, 21, 0, 0, tzinfo=IST).timestamp() * 1000.0

#: Fallback drift, measured on camera 10 (+0.5139 %, worst residual 1.0 s). Better than assuming
#: zero for a camera not yet anchored, but a borrowed constant rather than a measurement of *that*
#: camera — which is why it is named as one everywhere it is used.
GLOBAL_DRIFT_RATE = 0.005139

#: Two cameras with no measured offset between them agree to about this much.
CORRELATION_TOLERANCE_MS = 15_000


@dataclass(frozen=True)
class DriftModel:
    """``offset(p) = a + b·p``, in seconds."""

    offset_seconds: float = 0.0
    drift_rate: float = 0.0
    #: Where this model came from, so a timestamp can always be traced to its evidence.
    source: str = "none"

    @classmethod
    def global_default(cls) -> "DriftModel":
        return cls(0.0, GLOBAL_DRIFT_RATE, "global_default")

    def correction_seconds(self, position_seconds: float) -> float:
        return self.offset_seconds + self.drift_rate * position_seconds


def slot_start_ms(now_ms: float) -> float:
    """Epoch ms of the current 12-hour slot's start."""
    ist_seconds = now_ms / 1000.0 + IST_OFFSET_SECONDS
    since_anchor = (ist_seconds - SLOT_ANCHOR_SECONDS) % SLOT_SECONDS
    return (ist_seconds - since_anchor - IST_OFFSET_SECONDS) * 1000.0


def slot_position_seconds(absolute_ms: float) -> float:
    """``p`` — position within the slot, in seconds."""
    return (absolute_ms - slot_start_ms(absolute_ms)) / 1000.0


def slot_time_ms(position_seconds: float) -> float:
    """The portal's clock, uncorrected. Stored alongside recorded_at, never used for correlation."""
    return RECORDING_EPOCH_MS + position_seconds * 1000.0


def recorded_at_ms(position_seconds: float, drift: DriftModel | float = 0.0) -> float:
    """
    The forensic timestamp. A bare number is a constant offset, which is what a camera with a single
    anchor gets.

    Never derive this from raw PTS: PTS restarts every time the feed loops, so a route built on it
    would silently run backwards.
    """
    if isinstance(drift, DriftModel):
        offset = drift.correction_seconds(position_seconds)
    else:
        offset = float(drift)
    return RECORDING_EPOCH_MS + (position_seconds + offset) * 1000.0


def within_correlation_tolerance(
    a_ms: float, b_ms: float, tolerance_ms: float = CORRELATION_TOLERANCE_MS
) -> bool:
    """Are two recorded timestamps close enough to be the same moment?"""
    return abs(a_ms - b_ms) <= tolerance_ms


def to_datetime(epoch_ms: float) -> datetime:
    return datetime.fromtimestamp(epoch_ms / 1000.0, tz=timezone.utc)


# ── development sources ─────────────────────────────────────────────────────────


def fixture_recorded_at_ms(pts_ms: float, drift: DriftModel | float = 0.0) -> float:
    """
    Forensic time for a fixture file.

    A fixture is a recording of a slot, so its PTS *is* the slot position — there is no anchor to
    establish because there is no live delivery to be delayed. Kept separate from the live path so
    that neither can be used where the other belongs.
    """
    return recorded_at_ms(pts_ms / 1000.0, drift)
