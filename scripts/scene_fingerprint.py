#!/usr/bin/env python3
"""
Scene fingerprints: a second identity signal, independent of anything the portal controls.

── Why a label is not enough ────────────────────────────────────────────────────────────────────

Portal ids proved to be a positional index that shifts. Labels survived that change and are unique,
so they are the identity key today — but they are still *portal-controlled metadata*. A relabelling
("17 Rajkot CCTV" → "Rajkot Bus Stand 2") would leave us unable to tell a rename from a new camera,
and reattaching one camera's coordinates, anchors and audit history to another is exactly the
failure the label key was introduced to prevent.

A fingerprint of what the camera actually *sees* is not metadata. It cannot be renumbered or
relabelled, and it is the only signal that answers "is this the same physical camera?" from
evidence rather than from a claim.

── Why a hash at a slot offset is near-exact here ───────────────────────────────────────────────

In this sandbox the feeds are looped recordings on a 12-hour slot, so the same slot offset shows
the same content on every cycle. Comparing hashes taken at the same offset is therefore comparing
near-identical frames, and a small Hamming distance is strong evidence. Offsets are bucketed at
30 minutes so a reading need not land on the exact second.

For real cameras the same table buckets by hour of day instead: a junction at 08:00 looks broadly
like the same junction at 08:00 tomorrow. The threshold is looser there, and the comparison is
advisory rather than decisive — which is why a mismatch raises a conflict for a human rather than
rewriting anything.

── Method ───────────────────────────────────────────────────────────────────────────────────────

DCT perceptual hash (pHash), 64-bit, over a median frame:
  * sample ~10 s of frames and take the per-pixel MEDIAN, which removes moving vehicles and leaves
    the static scene — the part that identifies the camera
  * 32x32 grayscale, 2-D DCT, keep the top-left 8x8 low-frequency block (excluding the DC term),
    threshold each coefficient against the median
pHash is robust to the things that legitimately vary — exposure, mild compression, small gain
changes — while remaining sensitive to a genuinely different scene.

Usage:
    .venv/bin/python scripts/scene_fingerprint.py fixtures
    .venv/bin/python scripts/scene_fingerprint.py compare <hexA> <hexB>
"""
from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "data" / "fixtures"
OUT = ROOT / "data" / "fingerprints.json"

HASH_SIDE = 32          # DCT input is 32x32
KEEP = 8                # keep the top-left 8x8 low-frequency block
SAMPLE_SECONDS = 10
SAMPLE_FPS = 2          # 20 frames is plenty for a stable median
SLOT_BUCKET_SECONDS = 1800

# Empirically: identical scenes differ by 0-6 bits (codec noise, exposure); genuinely different
# scenes sit far above. Between the two we ask a human rather than guessing.
MATCH_MAX_DISTANCE = 10
CONFLICT_MIN_DISTANCE = 18


def slot_bucket(offset_s: float) -> int:
    """Bucket a slot offset so a fingerprint need not land on an exact second."""
    return int(offset_s // SLOT_BUCKET_SECONDS)


def _dct_1d(vector: list[float]) -> list[float]:
    """Naive DCT-II. n is 32, so an O(n^2) transform is microseconds and needs no dependency."""
    n = len(vector)
    out = []
    for k in range(n):
        total = 0.0
        for i, v in enumerate(vector):
            total += v * math.cos(math.pi * (2 * i + 1) * k / (2 * n))
        out.append(total)
    return out


def dct_2d(matrix: list[list[float]]) -> list[list[float]]:
    rows = [_dct_1d(row) for row in matrix]
    cols = [_dct_1d([rows[r][c] for r in range(len(rows))]) for c in range(len(rows[0]))]
    # cols[c][r] — transpose back so [row][col] indexing holds.
    return [[cols[c][r] for c in range(len(cols))] for r in range(len(cols[0]))]


def median_frame_gray(source: str, at_seconds: float, work: Path) -> list[list[float]] | None:
    """
    Median of ~10 s of frames, downscaled to 32x32 grayscale.

    The median is what makes this a *scene* fingerprint rather than a frame fingerprint: traffic
    moves and pedestrians pass, but the median pixel over ten seconds is the road, the buildings
    and the pole — the parts that identify the camera.
    """
    work.mkdir(parents=True, exist_ok=True)
    raw = work / "frames.gray"
    raw.unlink(missing_ok=True)

    net = source.startswith(("http://", "https://", "rtsp://"))
    cmd = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y"]
    if source.startswith("rtsp://"):
        cmd += ["-rtsp_transport", "tcp"]
    if at_seconds > 0 and not source.startswith("rtsp://"):
        cmd += ["-ss", str(at_seconds)]
    cmd += ["-i", source, "-t", str(SAMPLE_SECONDS),
            "-vf", f"fps={SAMPLE_FPS},scale={HASH_SIDE}:{HASH_SIDE},format=gray",
            "-f", "rawvideo", "-pix_fmt", "gray", str(raw)]

    out = subprocess.run(cmd, capture_output=True, text=True, timeout=600 if net else 300)
    if out.returncode != 0 or not raw.exists() or raw.stat().st_size == 0:
        return None

    data = raw.read_bytes()
    frame_size = HASH_SIDE * HASH_SIDE
    frames = [data[i:i + frame_size] for i in range(0, len(data) - frame_size + 1, frame_size)]
    raw.unlink(missing_ok=True)
    if not frames:
        return None

    median: list[list[float]] = []
    for row in range(HASH_SIDE):
        line = []
        for col in range(HASH_SIDE):
            idx = row * HASH_SIDE + col
            samples = sorted(f[idx] for f in frames)
            line.append(float(samples[len(samples) // 2]))
        median.append(line)
    return median


def phash(matrix: list[list[float]]) -> str:
    """64-bit pHash as 16 hex characters."""
    coeffs = dct_2d(matrix)
    block = [coeffs[r][c] for r in range(KEEP) for c in range(KEEP)]
    # Drop the DC term before taking the median: it encodes overall brightness, so keeping it makes
    # the hash sensitive to exposure changes that do not indicate a different camera.
    ac = block[1:]
    med = sorted(ac)[len(ac) // 2]
    bits = ["1" if v > med else "0" for v in block]
    return f"{int(''.join(bits), 2):016x}"


def hamming(a: str, b: str) -> int:
    return bin(int(a, 16) ^ int(b, 16)).count("1")


def classify(distance: int) -> str:
    if distance <= MATCH_MAX_DISTANCE:
        return "match"
    if distance >= CONFLICT_MIN_DISTANCE:
        return "conflict"
    return "uncertain"


# Fixture clips were captured at a known slot offset; the label is the identity they belong to.
FIXTURE_SOURCES = [
    ("05 Visat teen Rasta", "cam_5_daylight.mp4", 36000),
    ("10 char-chowk-road-2-junagadh", "cam_10_daylight.mp4", 36000),
    ("11 dolatpara-junagadh", "cam_11_daylight.mp4", 36000),
    ("16 Visat P2", "cam_16_daylight.mp4", 36000),
    ("05 Visat teen Rasta", "cam_5_night.mp4", 3600),
    ("11 dolatpara-junagadh", "cam_11_night.mp4", 3600),
    ("16 Visat P2", "cam_16_night.mp4", 3600),
]


def cmd_fixtures() -> int:
    work = ROOT / ".cache" / "fingerprint"
    results = []
    print(f"{'label':<34} {'clip':<26} {'bucket':>7}  hash")
    print("-" * 92)

    for label, filename, offset in FIXTURE_SOURCES:
        clip = FIXTURES / filename
        if not clip.exists():
            print(f"{label[:34]:<34} {filename:<26} {'—':>7}  (missing)")
            continue
        # Fixture clips start AT their capture offset, so sample a little way in.
        matrix = median_frame_gray(str(clip), 20.0, work)
        if matrix is None:
            print(f"{label[:34]:<34} {filename:<26} {'—':>7}  (unreadable)")
            continue
        h = phash(matrix)
        bucket = slot_bucket(offset + 20)
        print(f"{label[:34]:<34} {filename:<26} {bucket:>7}  {h}")
        results.append({
            "label": label, "clip": filename, "slot_offset_s": offset + 20,
            "slot_bucket": bucket, "phash": h, "source": "fixture",
        })

    OUT.write_text(json.dumps(results, indent=2))
    print(f"\nwrote {OUT.relative_to(ROOT)} ({len(results)} fingerprints)")

    # ── validation ───────────────────────────────────────────────────────────
    #
    # The only meaningful comparison is WITHIN a slot bucket. Day and night are genuinely
    # different-looking scenes, so a daylight hash and a night hash of the same camera are far
    # apart — which is the whole reason fingerprints are bucketed by slot offset rather than
    # compared globally.
    print("\n── same camera, same bucket (the comparison identity actually uses) ──")
    within = []
    for label, filename, offset in FIXTURE_SOURCES:
        clip = FIXTURES / filename
        if not clip.exists():
            continue
        first = next((r for r in results if r["clip"] == filename), None)
        if first is None:
            continue
        # A second sample from the same clip, far enough apart to contain different traffic but
        # inside the same 30-minute bucket.
        matrix = median_frame_gray(str(clip), 200.0, work)
        if matrix is None:
            continue
        second = phash(matrix)
        d = hamming(first["phash"], second)
        within.append(d)
        print(f"  {d:>3} bits  {label[:30]:<32} t=20s vs t=200s  -> {classify(d)}")

    print("\n── different cameras, same bucket ──")
    cross = []
    for i, a in enumerate(results):
        for b in results[i + 1:]:
            if a["label"] == b["label"] or a["slot_bucket"] != b["slot_bucket"]:
                continue
            d = hamming(a["phash"], b["phash"])
            cross.append(d)
            print(f"  {d:>3} bits  {a['label'][:20]:<22} vs {b['label'][:20]:<22} -> {classify(d)}")

    print("\n── same camera, DIFFERENT bucket (why buckets exist) ──")
    for i, a in enumerate(results):
        for b in results[i + 1:]:
            if a["label"] != b["label"] or a["slot_bucket"] == b["slot_bucket"]:
                continue
            d = hamming(a["phash"], b["phash"])
            print(f"  {d:>3} bits  {a['label'][:30]:<32} bucket {a['slot_bucket']} vs {b['slot_bucket']}"
                  f"  -> would be '{classify(d)}' if compared across buckets")

    if within and cross:
        worst_same, best_diff = max(within), min(cross)
        print(f"\n  worst same-camera (same bucket) : {worst_same} bits")
        print(f"  closest different-camera        : {best_diff} bits")
        print(f"  separation                      : {best_diff - worst_same} bits")
        verdict = "USABLE" if best_diff - worst_same >= 8 else "TOO NARROW — do not rely on this alone"
        print(f"  verdict                         : {verdict}")
        print(f"  thresholds: match <= {MATCH_MAX_DISTANCE}, conflict >= {CONFLICT_MIN_DISTANCE}")
    return 0


def cmd_compare(a: str, b: str) -> int:
    d = hamming(a, b)
    print(f"distance {d} -> {classify(d)}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("fixtures")
    c = sub.add_parser("compare")
    c.add_argument("a")
    c.add_argument("b")
    args = ap.parse_args()

    if args.cmd == "fixtures":
        return cmd_fixtures()
    return cmd_compare(args.a, args.b)


if __name__ == "__main__":
    raise SystemExit(main())
