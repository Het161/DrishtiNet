#!/usr/bin/env python3
"""
Propose time_sync anchors by reading each camera's burned-in overlay clock.

── Why anchors must straddle the slot ───────────────────────────────────────────────────────────

`recorded_at` corrects file position by a per-camera drift model `offset(p) = a + b·p`, where the
footage's own clock runs roughly 0.5 % fast against elapsed file time. Fitting `b` needs anchors
far apart: with span S and a reading error of e seconds, the slope is uncertain by ~2e/S, which by
the end of a 43,200 s slot becomes 43200·2e/S. Two readings inside one 45-minute clip (S = 2,700)
turn a ±1 s misreading into ±32 s — worse than assuming no drift. So each camera gets one anchor
near p ≈ 3,600 and one near p ≈ 36,000, a span of ~32,000 s.

── Why OCR, and why a human still confirms ──────────────────────────────────────────────────────

The overlay clock is large, high-contrast and in a fixed format, so it is far easier than a number
plate — but not trivial: on a real frame whose clock reads `14-06-2026 07:39:54`, raw OCR returned
`14-06-2026-97:39254` (0→9, colon→2). We therefore run several preprocessing variants, vote across
them, and constrain the result with what we already know (the recording date, and the expected time
from the position). The result is a *proposal*. A human accepts or corrects it against the actual
frame, because a wrong anchor silently poisons every timestamp that camera ever produces.

Usage:
    .venv/bin/python scripts/anchor_clock.py propose --ids 3,5,8,10,11,12,16
    .venv/bin/python scripts/anchor_clock.py propose --ids 10 --late-from-mirror
"""
from __future__ import annotations

import argparse
import datetime
import json
import re
import subprocess
import sys
from dataclasses import dataclass, asdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ANCHOR_DIR = ROOT / "data" / "anchors"
MIRROR_DIR = ROOT / "data" / "mirror"
PROPOSALS = ANCHOR_DIR / "proposals.json"

IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
# The recording begins at 21:00 IST on 13 June 2026 — established in data/probe/REPORT.md.
RECORDING_EPOCH = datetime.datetime(2026, 6, 13, 21, 0, 0, tzinfo=IST)

USER_AGENT = (
    "DrishtiNet-Sentinel2026/0.1 "
    "(Gujarat Police Innovation Challenge participant; hetpatelsk@gmail.com)"
)

# Anchor positions: far enough apart to constrain the drift slope.
EARLY_POSITION = 3600
LATE_POSITION = 36000

# Frames to try inside a mirrored clip before giving up on the late anchor. A single frame can be
# blurred, glared, or have a vehicle parked across the overlay.
MIRROR_SEEK_CANDIDATES = [30.0, 300.0, 900.0, 1500.0, 2400.0]

TIMESTAMP_RE = re.compile(r"\d[\d\s:/.\-]{8,}\d")


@dataclass
class Anchor:
    camera_id: str
    position_s: float
    frame_path: str
    ocr_raw: str
    proposed_iso: str | None
    expected_iso: str
    observed_offset_s: float | None
    confidence: float
    source: str
    confirmed: bool = False


def expected_clock(position_s: float) -> datetime.datetime:
    """What the overlay should read at this position, before any drift correction."""
    return RECORDING_EPOCH + datetime.timedelta(seconds=position_s)


def run(cmd: list[str], timeout: int = 300) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def grab_frame(source: str, position: float, dest: Path) -> bool:
    """One frame at a position. Works for a local mirror file or an HTTP source."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    net = source.startswith(("http://", "https://"))
    cmd = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y"]
    if net:
        cmd += ["-user_agent", USER_AGENT, "-rw_timeout", "60000000"]
    cmd += ["-ss", str(position), "-i", source, "-frames:v", "1", "-q:v", "2", str(dest)]
    return run(cmd, timeout=600).returncode == 0 and dest.exists()


def variants(frame: Path, out_dir: Path) -> list[Path]:
    """
    Preprocessing variants of the clock strip.

    No single filter wins: on our test frame plain upscaling read the seconds correctly while a
    hard threshold was the only one to get the hour right. Voting across variants recovers more
    than any one of them.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    # The clock sits in the top strip; crop full width so a left- or right-aligned overlay is caught.
    strip = "crop=iw:ih*0.08:0:0"
    specs = {
        "plain": f"{strip},scale=iw*2:ih*2:flags=lanczos",
        "thresh": f"{strip},format=gray,scale=iw*3:ih*3:flags=lanczos,lut=y='if(gte(val,180),255,0)'",
        "thresh_inv": f"{strip},format=gray,scale=iw*3:ih*3:flags=lanczos,lut=y='if(gte(val,180),0,255)'",
        "contrast": f"{strip},format=gray,scale=iw*3:ih*3:flags=lanczos,eq=contrast=1.8:brightness=0.05",
    }
    made = []
    for name, vf in specs.items():
        dest = out_dir / f"{frame.stem}__{name}.png"
        if run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(frame),
                "-vf", vf, str(dest)]).returncode == 0 and dest.exists():
            made.append(dest)
    return made


def digits_of(text: str) -> str:
    return re.sub(r"\D", "", text)


def _edit_distance(a: str, b: str) -> int:
    """
    Levenshtein distance.

    Position-aware, unlike a longest-common-subsequence score: LCS happily matches digits that
    appear in the wrong order, which let `07:39:54` score as well against `07:32:54` as against the
    truth. Substitutions and insertions each cost 1, which is exactly how this OCR fails (a `0`
    read as `9`, a colon read as `2`).
    """
    if a == b:
        return 0
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        curr = [i]
        for j, cb in enumerate(b, 1):
            curr.append(min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = curr
    return prev[len(b)]


def parse_with_prior(
    text: str,
    expected: datetime.datetime,
    window_s: int = 1800,
) -> tuple[datetime.datetime | None, float]:
    """
    Turn a noisy OCR string into a timestamp by scoring it against candidate times.

    Blind parsing of digit windows does not survive real output. On a daylight frame whose clock
    read `14-06-2026 07:39:54`, OCR returned `14-06-2026-97:39254`: the `0` became a `9` and the
    colon became a `2`. Every 14-digit alignment of that string is either an invalid hour or an
    invalid day, so a parser fails outright — while a human glancing at it reads it instantly,
    because they know roughly what time to expect.

    So we use the same prior: generate every second within `window_s` of the expected time, render
    each as the overlay's own digit string, and pick whichever best matches what OCR saw. One
    substituted digit costs a little similarity instead of invalidating the whole read.
    """
    seen = digits_of(text)
    if len(seen) < 10:
        return None, 0.0

    scored: list[tuple[float, datetime.datetime]] = []
    for delta in range(-window_s, window_s + 1):
        candidate = expected + datetime.timedelta(seconds=delta)
        want = candidate.strftime("%d%m%Y%H%M%S")
        dist = _edit_distance(want, seen)
        score = 1.0 - dist / max(len(want), len(seen))
        scored.append((score, candidate))

    scored.sort(key=lambda x: (-x[0], abs((x[1] - expected).total_seconds())))
    best_score, best_dt = scored[0]

    # A weak match is noise, not a reading.
    if best_score < 0.78:
        return None, round(best_score, 3)

    # Require the winner to stand clear of other candidates that are far away in time. If a reading
    # 20 minutes off scores the same as one 5 seconds off, OCR noise is choosing, not evidence —
    # and a wrong anchor silently poisons every timestamp this camera produces.
    rivals = [c for sc, c in scored[1:40]
              if sc >= best_score - 0.02 and abs((c - best_dt).total_seconds()) > 90]
    if rivals:
        return best_dt, round(best_score * 0.5, 3)

    return best_dt, round(best_score, 3)


def read_clock(frame: Path, expected: datetime.datetime, work: Path) -> tuple[str, datetime.datetime | None, float]:
    try:
        from rapidocr_onnxruntime import RapidOCR
    except ImportError:
        sys.exit("rapidocr-onnxruntime missing — run: .venv/bin/pip install rapidocr-onnxruntime")

    ocr = RapidOCR()
    readings: list[tuple[str, datetime.datetime | None, float]] = []

    for v in variants(frame, work):
        res, _ = ocr(str(v))
        for item in (res or []):
            text = str(item[1])
            if not TIMESTAMP_RE.search(text):
                continue
            parsed, score = parse_with_prior(text, expected)
            readings.append((text, parsed, score))

    if not readings:
        return "", None, 0.0

    readings.sort(key=lambda r: r[2], reverse=True)
    best_text, best_dt, best_score = readings[0]

    # Agreement across variants is worth more than any single confident read.
    if best_dt is not None:
        agreeing = sum(1 for _, dt, _ in readings if dt == best_dt)
        best_score = min(1.0, best_score * (1 + 0.15 * (agreeing - 1)))
    return best_text, best_dt, best_score


def local_clip_for(camera_id: str) -> Path | None:
    """A mirrored daylight clip, so the late anchor costs the portal nothing."""
    for name in (f"cam_{camera_id}_daylight.mp4", f"cam_{camera_id}.mp4"):
        p = MIRROR_DIR / name
        if p.exists():
            return p
    return None


def propose_for_camera(camera_id: str, base_url: str, use_mirror: bool) -> list[Anchor]:
    work = ANCHOR_DIR / "work"
    out: list[Anchor] = []

    targets: list[tuple[float, str, str]] = []

    # Late anchor: prefer the local mirror. Its chunk manifest records the true PTS, and reading it
    # locally means one less trip to shared infrastructure.
    clip = local_clip_for(camera_id) if use_mirror else None
    if clip:
        # The daylight clips were captured from LATE_POSITION, so a frame t seconds in is p+t.
        # Several candidates: a single frame can be motion-blurred, glared, or have a vehicle
        # parked across the overlay, and a failed read here costs another trip to the portal.
        targets.append((MIRROR_SEEK_CANDIDATES, str(clip), "mirror"))
    else:
        targets.append(([0.0], f"{base_url}/cam/{camera_id}", "portal-late"))

    # Early anchor: only obtainable from the portal. One frame, a few MB.
    targets.append(([float(EARLY_POSITION)], f"{base_url}/cam/{camera_id}", "portal-early"))

    for seeks, source, kind in targets:
        best: Anchor | None = None

        for seek in seeks:
            position = LATE_POSITION + seek if kind == "mirror" else seek
            frame = ANCHOR_DIR / f"cam_{camera_id}_p{int(position)}.jpg"

            if not frame.exists() and not grab_frame(source, seek, frame):
                print(f"    p={int(position):<6} {kind:<13} frame grab FAILED")
                continue

            expected = expected_clock(position)
            raw, parsed, score = read_clock(frame, expected, work)
            offset = (parsed - expected).total_seconds() if parsed else None

            if parsed:
                print(f"    p={int(position):<6} {kind:<13} expected {expected:%H:%M:%S} "
                      f"-> read {parsed:%H:%M:%S}  offset {offset:+.0f}s  conf {score:.2f}")
            else:
                print(f"    p={int(position):<6} {kind:<13} expected {expected:%H:%M:%S} "
                      f"-> UNREADABLE  ocr={raw[:30]!r}")

            candidate = Anchor(
                camera_id=camera_id, position_s=position,
                frame_path=str(frame.relative_to(ROOT)), ocr_raw=raw,
                proposed_iso=parsed.isoformat() if parsed else None,
                expected_iso=expected.isoformat(), observed_offset_s=offset,
                confidence=round(score, 3), source=kind,
            )
            if best is None or candidate.confidence > best.confidence:
                best = candidate
            # A confident read needs no further frames — and no further portal traffic.
            if candidate.confidence >= 0.9:
                break

        if best is not None:
            out.append(best)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("mode", choices=["propose"])
    ap.add_argument("--ids", required=True, help="comma-separated portal ids")
    ap.add_argument("--base", default="http://127.0.0.1:4010",
                    help="range proxy base (deep seeks fail against the portal directly)")
    ap.add_argument("--no-mirror", action="store_true",
                    help="always fetch the late anchor from the portal instead of a local clip")
    args = ap.parse_args()

    ANCHOR_DIR.mkdir(parents=True, exist_ok=True)
    existing = json.loads(PROPOSALS.read_text()) if PROPOSALS.exists() else []
    by_key = {(a["camera_id"], a["position_s"]): a for a in existing}

    for cid in [i.strip() for i in args.ids.split(",") if i.strip()]:
        print(f"camera {cid}")
        for anchor in propose_for_camera(cid, args.base, not args.no_mirror):
            by_key[(anchor.camera_id, anchor.position_s)] = asdict(anchor)

    merged = sorted(by_key.values(), key=lambda a: (int(a["camera_id"]), a["position_s"]))
    PROPOSALS.write_text(json.dumps(merged, indent=2))

    readable = sum(1 for a in merged if a["proposed_iso"])
    print(f"\n{readable}/{len(merged)} anchors readable — wrote {PROPOSALS.relative_to(ROOT)}")
    print("Review and confirm at /anchors before these are used for recorded_at.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
