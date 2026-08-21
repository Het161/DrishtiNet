# Retired: the progressive byte-range pipeline

**Do not use this code. It is kept because it is part of the migration story, not because it works
against the current portal.**

Retired 2026-08-21. See `docs/changelog/2026-08-21-portal-migration.md`.

## What this was

Between 20 and 21 August 2026 the Sentinel portal served every camera as a multi-gigabyte
progressive MP4 over HTTP byte range, and manufactured the illusion of "live" entirely in the
browser by seeking to a slot offset. These tools were built for that world:

| File | What it did |
|---|---|
| `probe_mp4.py` | Read MP4 metadata by walking the top-level box table with 16-byte range reads, downloading only `ftyp` + `moov`. Cut a single probe from 3.6 GB to ~9 MB. |
| `mirror.py` | Chunked, resumable, rate-limited capture with `-copyts` so each chunk carried true source PTS, plus a manifest recording keyframe snap and seam overlap. |
| `record_samples.sh` | Short sample clips for the first plate-legibility assessment. |
| `capture_demo_windows.sh` | Aligned daylight/night windows across the demo cluster. |

## Why it is retired

The portal migrated to live RTSP/RTP. The organisers' integration reference is explicit: there is
**no seeking, no byte ranges, and no running ahead of real time**, and it says plainly *"don't plan
around obtaining copies of the footage"* — `/stream/<id>` is a browser fallback only, and evaluation
exercises live consumption.

Every assumption these tools are built on is now false. There is nothing to seek into.

## What survived, and where it went

The work was not wasted — the *findings* outlived the transport:

- **The slot model** (`services/stream-gateway/src/slot.ts`) still stands. It was verified again
  against the migrated backend: `offset 2786.176775` at `21:46:26` puts slot start at exactly
  21:00:00 IST. It is now anchored from PTS rather than from a byte offset.
- **The drift model** (`fitDriftModel`) is unchanged. Anchors now arrive from continuous clock OCR
  on the live stream instead of manual readings from downloaded clips.
- **The clock OCR matcher** (`scripts/anchor_clock.py`) is reused directly for that continuous
  reconciliation.
- **The captured clips** moved to `data/fixtures/` as offline development fixtures — unit tests,
  re-ID labelling, CI. Never shown as live.
- **`-copyts` and the chunk manifest** taught us that `-ss` with `-c copy` snaps to the previous
  keyframe: 3.12 s of cumulative overlap across 8 seams on camera 3, 1.99 s on a single camera 12
  chunk. That is why timing is now driven from PTS everywhere, which is exactly what the live
  contract requires anyway.

## If you are tempted to run this

Don't. Beyond being useless against a live stream, pulling file copies from the organisers'
infrastructure now contradicts their stated rules. The current source chain is
RTSP-over-TCP → documented HLS → WHEP, discovered via `GET /api/ingest`.
