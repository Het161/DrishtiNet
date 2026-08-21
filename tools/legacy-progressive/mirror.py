#!/usr/bin/env python3
"""
Mirror portal footage to ./data/mirror/ for offline development and the on-site fallback.

The portal is shared government infrastructure used by hundreds of teams, so every transfer here is
deliberately unhurried and interruptible:

  * sequential — exactly one connection at a time, never one per camera in parallel
  * throttled  — MIRROR_RATE_LIMIT (default 2M) enforced by curl
  * resumable  — `curl -C -` continues a partial file instead of restarting a 12 GB download
  * backed off — exponential retry with jitter, so a struggling origin is not hammered
  * logged     — every attempt appended to data/transfer.log with bytes moved and outcome

Two modes:

  full    Whole file. Only for the five demo cameras (CLAUDE.md). Because each file spans
          21:00 → 09:00, a full mirror already contains the 07:00–09:00 daylight footage — there
          is no need to wait for a live daylight window for these cameras.

  window  A time slice, cut with ffmpeg `-ss/-t -c copy`. For the other 26 cameras, where we want
          a daylight sample and a night sample rather than 12 GB of night.

Usage:
    python3 scripts/mirror.py sizes  --ids 5,8,10,11,16
    python3 scripts/mirror.py full   --ids 5,8,10,11,16
    python3 scripts/mirror.py window --ids 12,17 --at 36000 --duration 7200 --tag daylight
"""
from __future__ import annotations

import argparse
import datetime
import json
import math
import os
import random
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIRROR_DIR = ROOT / "data" / "mirror"
LOG_PATH = ROOT / "data" / "transfer.log"

BASE = os.environ.get("SENTINEL_BASE", "https://live.sentinelgujarat.in")
RATE_LIMIT = os.environ.get("MIRROR_RATE_LIMIT", "2M")
USER_AGENT = (
    "DrishtiNet-Sentinel2026/0.1 "
    "(Gujarat Police Innovation Challenge participant; hetpatelsk@gmail.com)"
)

# Slot arithmetic mirrors services/stream-gateway/src/slot.ts. Kept minimal here on purpose —
# that TypeScript module remains the tested source of truth.
SLOT_SECONDS = 43200
RECORDING_START_HOUR = 21  # every file begins at 21:00 of the recorded day

MAX_ATTEMPTS = 6
IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))


def now_ist() -> str:
    return datetime.datetime.now(IST).isoformat(timespec="seconds")


def log(event: str, **fields) -> None:
    """Append-only transfer log. One JSON object per line so it stays greppable and auditable."""
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    record = {"ts": now_ist(), "event": event, **fields}
    with LOG_PATH.open("a") as fh:
        fh.write(json.dumps(record) + "\n")


def recorded_time_for(offset_s: float) -> str:
    """Human label for what a given seek offset actually shows: recorded_time = 21:00 + offset."""
    total = (RECORDING_START_HOUR * 3600 + offset_s) % 86400
    return f"{int(total // 3600):02d}:{int(total % 3600 // 60):02d}"


@dataclass
class Camera:
    id: str
    url: str


def load_cameras(ids: list[str] | None, proxy: str | None = None) -> list[Camera]:
    """
    Read the roster through the validated TypeScript loader — never re-parse the YAML here.

    When `proxy` is set, camera URLs point at the local caching range proxy instead of the portal.
    That is strongly preferred for `window` mode: FFmpeg's `-ss` against the portal issues an
    un-ranged GET that the origin frequently answers with an empty body, so deep seeks (exactly the
    ones that reach the daylight footage) fail. Through the proxy every upstream read is ranged,
    retried and cached. See services/stream-gateway/src/range-proxy.ts.
    """
    out = subprocess.run(
        ["pnpm", "-s", "exec", "tsx", "src/cli.ts", "list", "--tsv", "id,url"],
        cwd=ROOT / "services" / "stream-gateway",
        capture_output=True,
        text=True,
        timeout=180,
    )
    if out.returncode != 0:
        sys.exit(f"could not read camera roster:\n{out.stderr[:500]}")

    cameras = []
    for line in out.stdout.strip().split("\n"):
        if not line.strip():
            continue
        cid, url = line.split("\t")[:2]
        if ids is None or cid in ids:
            full = f"{proxy.rstrip('/')}/cam/{cid}" if proxy else f"{BASE}{url}"
            cameras.append(Camera(id=cid, url=full))
    return cameras


def remote_size(url: str) -> int | None:
    """One-byte ranged GET; the Content-Range total is the file size. Costs 1 byte."""
    out = subprocess.run(
        ["curl", "-sS", "--max-time", "30", "-A", USER_AGENT, "-r", "0-0", "-D", "-", "-o", "/dev/null", url],
        capture_output=True, text=True, timeout=60,
    )
    for line in out.stdout.splitlines():
        if line.lower().startswith("content-range:") and "/" in line:
            tail = line.rsplit("/", 1)[1].strip()
            if tail.isdigit():
                return int(tail)
    return None


def human(n: float | None) -> str:
    if n is None:
        return "?"
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if abs(n) < 1024:
            return f"{n:.1f}{unit}"
        n /= 1024
    return f"{n:.1f}PB"


def backoff_sleep(attempt: int) -> None:
    """Exponential with jitter — never a synchronised retry storm against a struggling origin."""
    delay = min(60, 2**attempt) * (0.5 + random.random())
    time.sleep(delay)


def mirror_full(cam: Camera, expected: int | None) -> bool:
    """
    Download the entire file, resuming across attempts.

    `curl -C -` issues a Range request from the current local size, so an interrupted 12 GB
    transfer costs nothing to continue. We treat "local size == remote size" as done and skip.
    """
    dest = MIRROR_DIR / f"cam_{cam.id}.mp4"
    dest.parent.mkdir(parents=True, exist_ok=True)

    if expected and dest.exists() and dest.stat().st_size == expected:
        print(f"    already complete ({human(expected)}) — skipping")
        log("mirror_skip", camera=cam.id, reason="already complete", bytes=expected)
        return True

    for attempt in range(MAX_ATTEMPTS):
        start_size = dest.stat().st_size if dest.exists() else 0
        started = time.time()
        log("mirror_start", camera=cam.id, attempt=attempt + 1,
            resume_from=start_size, expected=expected, rate_limit=RATE_LIMIT)

        proc = subprocess.run(
            [
                "curl", "-sS", "--fail",
                "-C", "-",                       # resume from wherever the local file ended
                "--limit-rate", RATE_LIMIT,      # be a good neighbour
                "--retry", "0",                  # we own the retry policy, not curl
                "--max-time", "86400",
                "--speed-limit", "1024", "--speed-time", "120",  # abort a stalled transfer
                "-A", USER_AGENT,
                "-o", str(dest),
                cam.url,
            ],
            capture_output=True, text=True,
        )

        size = dest.stat().st_size if dest.exists() else 0
        moved = size - start_size
        elapsed = time.time() - started
        rate = moved / elapsed if elapsed > 0 else 0

        if proc.returncode == 0 and (expected is None or size >= expected):
            print(f"    done {human(size)} (+{human(moved)} in {elapsed/60:.1f}min, {human(rate)}/s)")
            log("mirror_complete", camera=cam.id, bytes=size, moved=moved,
                seconds=round(elapsed, 1))
            return True

        # curl exit 33 means the server refused a resume; 18 is a truncated transfer. Both are
        # recoverable by simply trying again from the new local offset.
        print(f"    attempt {attempt+1} incomplete: {human(size)}/{human(expected)} "
              f"(curl {proc.returncode}) — retrying")
        log("mirror_retry", camera=cam.id, attempt=attempt + 1, bytes=size,
            moved=moved, curl_exit=proc.returncode,
            stderr=proc.stderr.strip()[:200])
        backoff_sleep(attempt)

    log("mirror_failed", camera=cam.id, bytes=dest.stat().st_size if dest.exists() else 0)
    return False



def verify_clip(path: Path, requested_s: int) -> tuple[bool, str]:
    """
    Confirm a captured clip actually contains video.

    ffmpeg returns 0 for a seek past usable data and writes a header-only container, so file size
    alone is not evidence of capture. We require a decodable video stream covering at least half
    the requested window — a short clip is still useful, an empty one is a silent failure that
    would only surface during the demo.
    """
    if not path.exists() or path.stat().st_size < 100_000:
        return False, f"file too small ({path.stat().st_size if path.exists() else 0} bytes)"
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=codec_type,nb_read_packets",
         "-show_entries", "format=duration",
         "-count_packets", "-read_intervals", "%+#1",
         "-of", "default=nw=1", str(path)],
        capture_output=True, text=True, timeout=180,
    )
    if out.returncode != 0:
        return False, "unreadable (no moov / corrupt)"
    fields = dict(
        line.split("=", 1) for line in out.stdout.strip().split("\n") if "=" in line
    )
    if fields.get("codec_type") != "video":
        return False, "no video stream"
    try:
        duration = float(fields.get("duration", 0))
    except ValueError:
        duration = 0.0
    if duration < requested_s * 0.5:
        return False, f"only {duration:.0f}s of the {requested_s}s requested"
    return True, f"{duration:.0f}s decodable"


def mirror_window(cam: Camera, at: int, duration: int, tag: str) -> bool:
    """Cut a time slice with ffmpeg stream-copy. Much cheaper than a full file for sampling."""
    dest = MIRROR_DIR / f"cam_{cam.id}_{tag}.mp4"
    dest.parent.mkdir(parents=True, exist_ok=True)

    if dest.exists() and dest.stat().st_size > 0:
        print(f"    already have {dest.name} ({human(dest.stat().st_size)}) — skipping")
        return True

    for attempt in range(3):
        started = time.time()
        log("window_start", camera=cam.id, offset=at, duration=duration, tag=tag,
            shows=recorded_time_for(at), attempt=attempt + 1)

        proc = subprocess.run(
            [
                "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
                "-user_agent", USER_AGENT,
                "-rw_timeout", "60000000",
                "-ss", str(at), "-i", cam.url, "-t", str(duration),
                "-an", "-c:v", "copy", str(dest),
            ],
            capture_output=True, text=True,
        )
        size = dest.stat().st_size if dest.exists() else 0
        # ffmpeg exits 0 even when a deep seek yields no frames, leaving a valid-but-empty
        # container. Camera 8 produced exactly that: a 262-byte MP4 counted as a success.
        # A clip is only "captured" if it actually decodes and covers most of the request.
        ok, detail = verify_clip(dest, duration)
        if proc.returncode == 0 and ok:
            print(f"    {tag} ok {human(size)} in {(time.time()-started)/60:.1f}min "
                  f"(shows {recorded_time_for(at)}, {detail})")
            log("window_complete", camera=cam.id, tag=tag, bytes=size, detail=detail)
            return True

        reason = detail if not ok else proc.stderr.strip()[:120]
        print(f"    attempt {attempt+1} failed ({reason})")
        # A clip that decodes but fell short is still useful footage; only delete what cannot be
        # opened at all. Throwing away 100 MB of valid video because it was 40% short is worse
        # than keeping it and saying so.
        decodable, _ = verify_clip(dest, 0)
        if decodable:
            print(f"    keeping the partial clip ({human(dest.stat().st_size)}) — it decodes")
            log("window_partial", camera=cam.id, tag=tag, bytes=dest.stat().st_size)
            return True
        log("window_retry", camera=cam.id, tag=tag, attempt=attempt + 1,
            stderr=proc.stderr.strip()[:200])
        dest.unlink(missing_ok=True)
        backoff_sleep(attempt)

    log("window_failed", camera=cam.id, tag=tag)
    return False





def input_options(url: str) -> list[str]:
    """
    Protocol-appropriate input options.

    `-user_agent` and `-rw_timeout` are HTTP options; passing them for a local file makes ffmpeg
    fail with "Option user_agent not found". This matters beyond tests — the FILE_LOOP adapter
    replays mirrored files at the venue, and that path must work with no network at all.
    """
    if url.startswith(("http://", "https://")):
        return ["-user_agent", USER_AGENT, "-rw_timeout", "60000000"]
    return []


def probe_pts_range(path: Path) -> tuple[float | None, float | None]:
    """
    True source PTS range of a captured chunk.

    With `-copyts` the container's start_time IS the source position, so this is how a chunk knows
    where it really came from. Without it, `-ss` + `-c copy` resets timestamps to zero and the
    provenance is gone.
    """
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=start_time,duration",
         "-of", "default=nw=1", str(path)],
        capture_output=True, text=True, timeout=120,
    )
    fields = dict(
        line.split("=", 1) for line in out.stdout.strip().split("\n") if "=" in line
    )
    try:
        start = float(fields.get("start_time", ""))
        dur = float(fields.get("duration", ""))
    except ValueError:
        return None, None
    return start, start + dur


def capture_chunk(cam: Camera, at: int, duration: int, dest: Path) -> tuple[bool, str]:
    """
    One chunk, with its own retries. A failed chunk costs minutes, not the whole window.

    `-ss X -copyts -to X+D` is the only form that both seeks cheaply and preserves source
    timestamps. Measured on a local file: plain `-ss -t` yields start_time=0 (provenance lost),
    `-copyts -t` produces an unreadable file, and `-copyts -to` yields start_time=599.75 for a
    requested 600 — the keyframe snap made visible instead of hidden.
    """
    for attempt in range(4):
        proc = subprocess.run(
            ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
             *input_options(cam.url),
             "-ss", str(at), "-copyts", "-i", cam.url, "-to", str(at + duration),
             "-an", "-c:v", "copy", str(dest)],
            capture_output=True, text=True,
        )
        ok, detail = verify_clip(dest, duration)
        if proc.returncode == 0 and ok:
            return True, detail
        log("chunk_retry", camera=cam.id, at=at, attempt=attempt + 1,
            detail=detail, stderr=proc.stderr.strip()[:160])
        dest.unlink(missing_ok=True)
        backoff_sleep(attempt)
    return False, "all attempts failed"


def concat_chunks(chunks: list[Path], dest: Path) -> tuple[bool, str]:
    """
    Join chunks into one file FOR VIEWING ONLY.

    This artifact must never be used to derive a timestamp. `-ss` with `-c copy` snaps every seam
    back to the previous keyframe, so consecutive chunks overlap by up to one GOP; across nine
    seams the cumulative overlap would put recorded_at tens of seconds out and quietly break the
    +/-15 s cross-camera correlation. The per-chunk manifest is the unit of truth; this is a
    convenience for scrubbing through footage by eye.
    """
    listing = dest.with_suffix(".concat.txt")
    listing.write_text("".join(f"file '{c.resolve()}'\n" for c in chunks))
    proc = subprocess.run(
        ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
         "-f", "concat", "-safe", "0", "-i", str(listing),
         "-c", "copy", "-fflags", "+genpts", str(dest)],
        capture_output=True, text=True,
    )
    listing.unlink(missing_ok=True)
    if proc.returncode != 0:
        return False, f"concat failed: {proc.stderr.strip()[:160]}"
    ok, detail = verify_clip(dest, 0)
    return ok, detail


def mirror_chunked(cam: Camera, at: int, duration: int, chunk_s: int, tag: str) -> bool:
    """
    Capture an aligned window in verified chunks, then write a manifest.

    Aligned windows matter more than per-camera completeness: a route demo needs the SAME recorded
    minutes on three or more cameras, and best-effort clips of differing lengths do not give that.

    Chunks are kept, not deleted. They carry true source PTS and are what the batch indexer reads.
    """
    chunk_dir = MIRROR_DIR / "chunks"
    chunk_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = MIRROR_DIR / f"cam_{cam.id}_{tag}.manifest.json"

    n = math.ceil(duration / chunk_s)
    print(f"    {n} chunks of {chunk_s}s from offset {at} (recorded {recorded_time_for(at)})")

    entries: list[dict] = []
    chunks: list[Path] = []
    prev_last_pts: float | None = None

    for i in range(n):
        chunk_at = at + i * chunk_s
        chunk_len = min(chunk_s, at + duration - chunk_at)
        cpath = chunk_dir / f"cam_{cam.id}_{tag}_{i:03d}.mp4"

        cached = cpath.exists() and verify_clip(cpath, chunk_len)[0]
        if cached:
            ok, detail = True, "cached"
        else:
            ok, detail = capture_chunk(cam, chunk_at, chunk_len, cpath)

        first_pts, last_pts = probe_pts_range(cpath) if ok else (None, None)

        # How far the keyframe snap pulled us back before the requested time.
        snap = (chunk_at - first_pts) if first_pts is not None else None
        # How much of this chunk duplicates the previous one.
        overlap = (
            prev_last_pts - first_pts
            if (first_pts is not None and prev_last_pts is not None and prev_last_pts > first_pts)
            else 0.0
        )

        status = "ok  " if ok else "FAIL"
        extra = ""
        if first_pts is not None:
            extra = f" pts={first_pts:.2f} snap={snap:+.2f}s overlap={overlap:.2f}s"
        print(f"      [{i + 1:>2}/{n}] {status} {recorded_time_for(chunk_at)} {detail}{extra}")

        entries.append({
            "index": i,
            "path": str(cpath.relative_to(ROOT)),
            "requested_offset_s": chunk_at,
            "requested_duration_s": chunk_len,
            "actual_first_pts_s": first_pts,
            "actual_last_pts_s": last_pts,
            "keyframe_snap_s": snap,
            "overlap_with_previous_s": overlap,
            "ok": ok,
            "detail": detail,
        })
        log("chunk", camera=cam.id, tag=tag, index=i, at=chunk_at, ok=ok,
            first_pts=first_pts, snap=snap, overlap=overlap)

        if ok:
            chunks.append(cpath)
            if last_pts is not None:
                prev_last_pts = last_pts
        if not cached:
            time.sleep(1)

    if not chunks:
        print("    no chunks captured")
        return False

    manifest = {
        "camera": cam.id,
        "tag": tag,
        "requested_offset_s": at,
        "requested_duration_s": duration,
        "chunk_seconds": chunk_s,
        "captured_at_ist": now_ist(),
        "note": (
            "Chunks are the unit of truth: each carries source PTS via -copyts. Derive frame time "
            "from the chunk's own PTS, never from position inside the concatenated file. When "
            "indexing across a boundary, drop frames whose PTS <= the previous chunk's last PTS."
        ),
        "chunks": entries,
    }
    manifest_path.write_text(json.dumps(manifest, indent=2))
    print(f"    manifest -> {manifest_path.name}")

    dest = MIRROR_DIR / f"cam_{cam.id}_{tag}.mp4"
    ok, detail = concat_chunks(chunks, dest)
    total_overlap = sum(e["overlap_with_previous_s"] or 0 for e in entries)
    print(f"    concat (viewing only): {'ok' if ok else 'FAILED'} {detail} "
          f"({len(chunks)}/{n} chunks, cumulative seam overlap {total_overlap:.1f}s)")
    log("chunked_complete", camera=cam.id, tag=tag, chunks_ok=len(chunks),
        chunks_total=n, cumulative_overlap_s=total_overlap, detail=detail)
    return len(chunks) == n


def verify_mirror() -> int:
    """
    Audit every clip in data/mirror and report what is actually usable.

    Necessary because a capture can die between writing bytes and writing the MP4 `moov` atom,
    leaving a plausible-looking file that no decoder will open. Discovering that during the demo
    instead of now is the failure this exists to prevent.
    """
    clips = sorted(MIRROR_DIR.glob("*.mp4"))
    if not clips:
        print("no clips in data/mirror")
        return 0

    good, bad = [], []
    print(f"{'clip':<28} {'size':>9}  status")
    print("-" * 60)
    for clip in clips:
        ok, detail = verify_clip(clip, 0)  # 0 = accept any duration, only check decodability
        size = human(clip.stat().st_size)
        print(f"{clip.name:<28} {size:>9}  {'OK  ' if ok else 'BAD '} {detail}")
        (good if ok else bad).append(clip)

    print("-" * 60)
    print(f"usable: {len(good)}   unusable: {len(bad)}")
    if bad:
        print("\nUnusable clips (re-capture these):")
        for clip in bad:
            print(f"  {clip.name}")
        print("\nRemove them with:  python3 scripts/mirror.py verify --prune")
    log("verify", usable=[c.name for c in good], unusable=[c.name for c in bad])
    return 0 if not bad else 1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("mode", choices=["sizes", "full", "window", "chunked", "verify"])
    ap.add_argument("--ids", help="comma-separated portal ids")
    ap.add_argument("--at", type=int, default=36000, help="window: seek offset in seconds")
    ap.add_argument("--duration", type=int, default=7200, help="window: length in seconds")
    ap.add_argument("--tag", default="daylight", help="window: filename tag")
    ap.add_argument("--prune", action="store_true", help="verify: delete clips that will not decode")
    ap.add_argument("--chunk", type=int, default=300, help="chunked: seconds per chunk")
    ap.add_argument(
        "--proxy",
        default=os.environ.get("RANGE_PROXY_URL"),
        help="route reads through the local caching range proxy (e.g. http://127.0.0.1:4010). "
             "Required in practice for deep seeks; the portal fails un-ranged GETs.",
    )
    args = ap.parse_args()

    if args.mode == "verify":
        rc = verify_mirror()
        if args.prune:
            for clip in sorted(MIRROR_DIR.glob("*.mp4")):
                ok, _ = verify_clip(clip, 0)
                if not ok:
                    clip.unlink()
                    print(f"removed {clip.name}")
                    log("verify_pruned", clip=clip.name)
        return rc

    ids = [i.strip() for i in args.ids.split(",")] if args.ids else None
    cameras = load_cameras(ids, args.proxy)
    if not cameras:
        sys.exit("no cameras matched")

    origin = args.proxy or BASE
    print(f"mode={args.mode}  cameras={len(cameras)}  rate limit={RATE_LIMIT}  via={origin}")
    print(f"destination: {MIRROR_DIR}   log: {LOG_PATH}\n")

    if args.mode == "sizes":
        total = 0
        for cam in cameras:
            size = remote_size(cam.url)
            total += size or 0
            print(f"  cam {cam.id:>3}  {human(size)}")
            time.sleep(1)
        print(f"\n  total: {human(total)}")
        hours = total / (2 * 1024 * 1024) / 3600 if total else 0
        print(f"  at {RATE_LIMIT}/s ≈ {hours:.1f} h sequential")
        log("sizes", cameras=[c.id for c in cameras], total_bytes=total)
        return 0

    ok = failed = 0
    for i, cam in enumerate(cameras, 1):
        print(f"[{i}/{len(cameras)}] camera {cam.id}")
        if args.mode == "full":
            size = remote_size(cam.url)
            print(f"    remote size {human(size)}")
            good = mirror_full(cam, size)
        elif args.mode == "chunked":
            good = mirror_chunked(cam, args.at, args.duration, args.chunk, args.tag)
        else:
            good = mirror_window(cam, args.at, args.duration, args.tag)
        ok += good
        failed += not good
        time.sleep(2)

    print(f"\n──────────────────────────────\nok: {ok}   failed: {failed}")
    print(f"mirror: {MIRROR_DIR} (gitignored)   log: {LOG_PATH}")
    log("run_complete", mode=args.mode, ok=ok, failed=failed)
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
