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
    ap.add_argument("mode", choices=["sizes", "full", "window", "verify"])
    ap.add_argument("--ids", help="comma-separated portal ids")
    ap.add_argument("--at", type=int, default=36000, help="window: seek offset in seconds")
    ap.add_argument("--duration", type=int, default=7200, help="window: length in seconds")
    ap.add_argument("--tag", default="daylight", help="window: filename tag")
    ap.add_argument("--prune", action="store_true", help="verify: delete clips that will not decode")
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
