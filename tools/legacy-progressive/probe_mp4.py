#!/usr/bin/env python3
"""
Cheap remote MP4 metadata probe.

Why this exists: the Sentinel portal serves multi-gigabyte progressive MP4s whose `moov` atom sits
at the END of the file (they are not `faststart`). Pointing ffprobe at the URL makes FFmpeg read
the whole file to reach it — we measured 3.6 GB pulled for a single probe of camera 17. On shared
government infrastructure used by every competing team, that is unacceptable.

Instead we walk the top-level MP4 box table using tiny HTTP Range reads (8-16 bytes per box
header), skipping `mdat` by its declared size, then download only `ftyp` + `moov`. Those two boxes
are stitched into a local stub file that ffprobe can parse normally. Cost per camera drops from
gigabytes to a few megabytes.

Usage:
    python3 scripts/probe_mp4.py https://live.sentinelgujarat.in/stream/1
    python3 scripts/probe_mp4.py --all config/cameras.yaml
"""
from __future__ import annotations

import argparse
import json
import shutil
import struct
import subprocess
import sys
import tempfile
import time


from dataclasses import dataclass, field
from pathlib import Path

USER_AGENT = (
    "DrishtiNet-Sentinel2026-Probe/0.1 "
    "(Gujarat Police Innovation Challenge participant; hetpatelsk@gmail.com)"
)

# Never pull more than this for a single box. A moov for a 12-hour, 25 fps recording carries large
# stts/stco tables, but it stays in the low tens of MB; anything past this is a malformed file.
MAX_MOOV_BYTES = 96 * 1024 * 1024

REQUEST_TIMEOUT = 30
POLITE_DELAY_S = 2.0


class ProbeError(RuntimeError):
    pass


@dataclass
class Probe:
    url: str
    size: int | None = None
    accepts_ranges: bool = False
    etag: str | None = None
    content_type: str | None = None
    boxes: list[tuple[str, int, int]] = field(default_factory=list)  # (type, offset, size)
    bytes_fetched: int = 0
    ffprobe: dict = field(default_factory=dict)
    error: str | None = None


def _get(url: str, start: int | None = None, end: int | None = None) -> tuple[bytes, dict]:
    """
    Ranged GET via curl.

    Deliberately not urllib: the portal's origin returns an empty body to urllib's default
    `Accept-Encoding: identity` request for ranged video/mp4 (reproducible as
    `IncompleteRead(0 bytes read, 1 more expected)`), while the identical curl request succeeds.
    Rather than reverse-engineer the origin's content negotiation, we use the client that works.
    """
    cmd = [
        "curl", "-sS", "--fail-with-body", "--max-time", str(REQUEST_TIMEOUT),
        "-A", USER_AGENT, "-D", "-",
    ]
    if start is not None:
        cmd += ["-r", f"{start}-" + ("" if end is None else str(end))]
    cmd.append(url)

    out = subprocess.run(cmd, capture_output=True, timeout=REQUEST_TIMEOUT + 15)
    if out.returncode != 0:
        raise ProbeError(f"curl exit {out.returncode}: {out.stderr.decode(errors='replace')[:200]}")

    raw = out.stdout
    # Strip any 1xx/redirect header blocks, keeping the headers of the final response.
    headers: dict[str, str] = {}
    while True:
        sep = b"\r\n\r\n" if b"\r\n\r\n" in raw[:8192] else b"\n\n"
        idx = raw.find(sep)
        if idx == -1:
            break
        block = raw[:idx].decode("iso-8859-1")
        raw = raw[idx + len(sep):]
        headers = {}
        for line in block.splitlines()[1:]:
            if ":" in line:
                k, v = line.split(":", 1)
                headers[k.strip().lower()] = v.strip()
        if not raw.startswith(b"HTTP/"):
            break
    return raw, headers


def head(url: str) -> tuple[int | None, bool, str | None, str | None]:
    """Use a 1-byte ranged GET rather than HEAD — uvicorn range handlers are more reliable."""
    _, h = _get(url, 0, 0)
    size = None
    cr = h.get("content-range")
    if cr and "/" in cr:
        tail = cr.rsplit("/", 1)[1].strip()
        if tail.isdigit():
            size = int(tail)
    accepts = (h.get("accept-ranges", "").lower() == "bytes") or cr is not None
    return size, accepts, h.get("etag"), h.get("content-type")


def walk_boxes(url: str, size: int, probe: Probe) -> list[tuple[str, int, int]]:
    """Walk top-level MP4 boxes with 16-byte range reads, skipping payloads entirely."""
    boxes: list[tuple[str, int, int]] = []
    offset = 0
    while offset < size and len(boxes) < 64:
        hdr, _ = _get(url, offset, offset + 15)
        probe.bytes_fetched += len(hdr)
        if len(hdr) < 8:
            break
        box_size = struct.unpack(">I", hdr[0:4])[0]
        box_type = hdr[4:8].decode("ascii", errors="replace")
        header_len = 8
        if box_size == 1:  # 64-bit extended size
            if len(hdr) < 16:
                break
            box_size = struct.unpack(">Q", hdr[8:16])[0]
            header_len = 16
        elif box_size == 0:  # extends to EOF
            box_size = size - offset
        if box_size < header_len:
            break
        boxes.append((box_type, offset, box_size))
        if box_type == "moov":
            break  # everything we need is here; stop walking
        offset += box_size
    return boxes


def _get_range_chunked(url: str, start: int, length: int, probe: Probe) -> bytes:
    """
    Read a byte range in modest chunks with retries.

    The portal's uvicorn origin resets the connection on large ranged reads near the end of a
    multi-gigabyte object (observed as IncompleteRead / "Stream ends prematurely"). Small chunks
    with backoff get through reliably and are gentler on shared infrastructure than one big pull.
    """
    chunk = 1 << 20  # 1 MiB
    out = bytearray()
    pos = start
    remaining = length
    while remaining > 0:
        want = min(chunk, remaining)
        last_err: Exception | None = None
        for attempt in range(4):
            try:
                data, _ = _get(url, pos, pos + want - 1)
                if not data:
                    raise ProbeError("empty range response")
                out += data
                probe.bytes_fetched += len(data)
                pos += len(data)
                remaining -= len(data)
                last_err = None
                break
            except Exception as exc:  # noqa: BLE001 — retry any transport failure
                last_err = exc
                time.sleep(0.5 * (2**attempt))  # exponential backoff
        if last_err is not None:
            raise ProbeError(f"range read failed at byte {pos}: {last_err}")
    return bytes(out)


def build_stub(url: str, boxes: list[tuple[str, int, int]], probe: Probe, dest: Path) -> None:
    """Download ftyp + moov into a local stub ffprobe can parse."""
    wanted = [b for b in boxes if b[0] in ("ftyp", "moov")]
    if not any(b[0] == "moov" for b in wanted):
        raise ProbeError("no moov box found in the top-level box table")
    with dest.open("wb") as fh:
        for box_type, offset, box_size in wanted:
            if box_size > MAX_MOOV_BYTES:
                raise ProbeError(f"{box_type} box is {box_size} bytes — refusing to download")
            fh.write(_get_range_chunked(url, offset, box_size, probe))


def run_ffprobe(path: Path) -> dict:
    cmd = [
        "ffprobe", "-v", "error", "-print_format", "json",
        "-show_entries",
        "format=duration,format_name:"
        "stream=codec_name,codec_type,width,height,r_frame_rate,avg_frame_rate,bit_rate,nb_frames",
        str(path),
    ]
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if out.returncode != 0 and not out.stdout.strip():
        raise ProbeError(f"ffprobe failed: {out.stderr.strip()[:300]}")
    return json.loads(out.stdout or "{}")


def probe_url(url: str) -> Probe:
    p = Probe(url=url)
    try:
        p.size, p.accepts_ranges, p.etag, p.content_type = head(url)
        if not p.size:
            raise ProbeError("server did not report a content length")
        if not p.accepts_ranges:
            raise ProbeError("server does not accept range requests — cannot probe cheaply")
        p.boxes = walk_boxes(url, p.size, p)
        with tempfile.TemporaryDirectory() as td:
            stub = Path(td) / "stub.mp4"
            build_stub(url, p.boxes, p, stub)
            p.ffprobe = run_ffprobe(stub)
    except (ProbeError, OSError,
            struct.error, subprocess.SubprocessError, json.JSONDecodeError) as exc:
        p.error = f"{type(exc).__name__}: {exc}"
    return p


def summarize(p: Probe) -> dict:
    v = next((s for s in p.ffprobe.get("streams", []) if s.get("codec_type") == "video"), {})
    a = next((s for s in p.ffprobe.get("streams", []) if s.get("codec_type") == "audio"), None)
    fmt = p.ffprobe.get("format", {})

    def ratio(expr: str | None) -> float | None:
        if not expr or "/" not in expr:
            return None
        num, den = expr.split("/", 1)
        try:
            return round(int(num) / int(den), 3) if int(den) else None
        except ValueError:
            return None

    duration = float(fmt["duration"]) if fmt.get("duration") else None
    return {
        "url": p.url,
        "error": p.error,
        "size_bytes": p.size,
        "size_gb": round(p.size / 1e9, 2) if p.size else None,
        "content_type": p.content_type,
        "etag": p.etag,
        "accepts_ranges": p.accepts_ranges,
        "box_order": [b[0] for b in p.boxes],
        "moov_at_front": bool(p.boxes) and "moov" in [b[0] for b in p.boxes[:2]],
        "probe_bytes_fetched": p.bytes_fetched,
        "probe_mb_fetched": round(p.bytes_fetched / 1e6, 2),
        "duration_s": round(duration, 2) if duration else None,
        "duration_h": round(duration / 3600, 3) if duration else None,
        "codec": v.get("codec_name"),
        "width": v.get("width"),
        "height": v.get("height"),
        "nominal_fps": ratio(v.get("r_frame_rate")),
        "actual_fps": ratio(v.get("avg_frame_rate")),
        "nb_frames": int(v["nb_frames"]) if v.get("nb_frames") else None,
        "video_bitrate_kbps": round(int(v["bit_rate"]) / 1000) if v.get("bit_rate") else None,
        "has_audio": a is not None,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("urls", nargs="*", help="stream URLs to probe")
    ap.add_argument("--ids", help="comma-separated portal ids against --base")
    ap.add_argument("--base", default="https://live.sentinelgujarat.in", help="portal base URL")
    ap.add_argument("--out", type=Path, help="write JSON results here")
    args = ap.parse_args()

    if shutil.which("ffprobe") is None:
        print("ffprobe not found on PATH", file=sys.stderr)
        return 2

    urls = list(args.urls)
    if args.ids:
        urls += [f"{args.base}/stream/{i.strip()}" for i in args.ids.split(",") if i.strip()]
    if not urls:
        ap.error("give at least one URL or --ids")

    results = []
    for i, url in enumerate(urls):
        if i:
            time.sleep(POLITE_DELAY_S)  # one connection at a time, be kind to shared infra
        print(f"[{i + 1}/{len(urls)}] {url}", file=sys.stderr)
        s = summarize(probe_url(url))
        results.append(s)
        if s["error"]:
            print(f"    ERROR {s['error']}", file=sys.stderr)
        else:
            print(
                f"    {s['width']}x{s['height']} {s['codec']} "
                f"{s['actual_fps']}fps dur={s['duration_h']}h size={s['size_gb']}GB "
                f"(fetched {s['probe_mb_fetched']}MB)",
                file=sys.stderr,
            )

    payload = json.dumps(results, indent=2)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(payload)
        print(f"wrote {args.out}", file=sys.stderr)
    else:
        print(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
