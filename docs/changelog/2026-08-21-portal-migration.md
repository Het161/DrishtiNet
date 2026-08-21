# 2026-08-21 — the portal migrated from progressive files to live streams

Measured 21 Aug 2026, 21:30–22:05 IST. This supersedes the delivery findings in
`data/probe/REPORT.md`; the slot and timing findings there still stand.

## What happened

`live.sentinelgujarat.in` now returns `301 → live.corp8.cloud`, and the backend behind it is a
different system. `delivery` changed from `progressive` to `rtsp`, and the organisers published an
integration reference stating that every camera is a live RTSP/RTP stream: no seeking, no byte
ranges, and no running ahead of real time.

| | Before (20 Aug) | After (21 Aug) |
|---|---|---|
| Host | `live.sentinelgujarat.in` | `live.corp8.cloud` (301) |
| Discovery | `/api/cameras` | **`/api/ingest`** (the stated contract) |
| Delivery | `progressive` MP4 + byte range | **`rtsp`** |
| Endpoints | `/stream/{id}` | `rtsp://…:8554/stream/{id}`, `http://…:8889/stream/{id}/whep`, `/live/stream/{id}/index.m3u8` |
| Roster | 31 cameras | **30** |
| Codecs | h264 ×29, avi ×2 | **h264 ×7, hevc ×4, unreported ×19** |
| Stream properties | absent | width/height/fps/bitrate on 11 of 30 |
| New field | — | `remote_transcode` (true on 8) |

The two AVI cameras that could not be served at all (6 and 23) are now HEVC and report properties,
so the organisers appear to have re-encoded the problem sources.

## The finding that matters most: camera ids are not stable

Camera **"17 Rajkot CCTV"** was removed, and **every id above it shifted down by one**. Nothing else
was lost — "Gandhidham Rambaugh p2" is still present, it simply moved from id 31 to id 30.

```
 id  OLD label                                   NEW label
 18  17 Rajkot CCTV                              18 Rajkot CCTV
 19  18 Rajkot CCTV                              19 KHAPARIA GRAM PANCHAYAT…
 20  19 KHAPARIA GRAM PANCHAYAT…                 20 Mohanpura
 21  20 Mohanpura                                23 Patan Dethali Char Rasta
 22  23 Patan Dethali Char Rasta                 28 BK Mervada tran Rasta
 …                                               …
 30  38 bilimora                                 Gandhidham Rambaugh p2
 31  Gandhidham Rambaugh p2                      — (gone)
```

**14 portal ids now point at a different physical camera.** Our registry keys on `portal_id`, and
`scripts/sync_registry.py` was written to "update portal-owned fields, preserve our research" — so
running it unchanged would have quietly reattached 14 cameras' researched coordinates, department
suggestions, `time_sync` anchors and audit history to the wrong physical camera. Nothing would have
errored. The map would simply have been wrong.

`data/probe/REPORT.md` recorded that "portal_id is the only safe key" because the *label* number was
known to be non-unique (portal 17 and 18 both carried label "17"). That reasoning was right about
labels being non-unique and wrong about ids being stable.

**Correction going forward:** the stable identity is the **full label string**, which embeds the
original deployment number (`"23 Patan Dethali Char Rasta"`). `portal_id` is a positional index into
whatever the portal is serving today. Every sync must reconcile by label and treat an id change as a
rename, not a new camera.

## `location` is a label, not coordinates

`/api/ingest` returns `"location": "01 Chiman bhai Bridge"` — a display string. Zero of the 30
cameras carry anything coordinate-shaped. The 11 cameras with unverified positions therefore gain
nothing from the migration and still require the drag-to-place tool.

## Reachability from our network

```
rtsp://live.corp8.cloud:8554   closed/filtered
http://live.corp8.cloud:8889   closed/filtered
https://live.corp8.cloud:443   open
```

Only 443 is reachable here. That may be our network rather than theirs, and may differ on the venue
network — it needs confirming from another connection before we conclude anything about the grid.

## The HLS 401

Following the documented path exactly:

1. `GET /live/stream/10/index.m3u8` → **200**, a valid master playlist
   (`1920x1080 @ 25 fps, avc1.640028, BANDWIDTH 3564480`).
2. The master's own relative reference `main_stream.m3u8` → **401**
   `{"status":"error","error":"authentication error"}`.

`ffprobe` against the documented `index.m3u8` fails identically with
`Server returned 401 Unauthorized`. An earlier fetch returned a variant carrying
`?session=<uuid>`; that token has since disappeared from the master and did not authorise the media
playlist either.

We stopped there. No workaround was attempted. A §5 support report is prepared at
`docs/support/2026-08-21-hls-401.md` for the organisers.

## Consequences for the build

Retired:
- the chunked progressive mirror pipeline (moves to `tools/legacy-progressive/`)
- the remaining capture sets (12, 17, and the aligned 8/10/11)
- HEAD/ETag file versioning
- the seek-based forensic pre-index, replaced by continuous live indexing

Kept:
- the slot model and drift fit — still correct, verified against the migrated backend
  (`offset 2786.176775` at `21:46:26` → slot start exactly 21:00:00 IST), now anchored from PTS
  rather than from a byte offset
- MediaMTX re-publish, the uniform adapter contract, lazy start, registry/GIS, audit trail
- the ~1 GB of already-captured clips, demoted to **offline development fixtures only**

The adapter layer was built with RTSP as a documented stub precisely so the source could change
without redesign. That is now the primary path.
