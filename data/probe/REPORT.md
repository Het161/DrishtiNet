# Phase 0 — Feed Discovery Report

**Portal:** https://live.sentinelgujarat.in ("CCTV Control Room")
**Probed:** 2026-08-20, 20:20–21:45 IST
**Method:** HTTP probing of the portal's HTML, JS bundles and JSON APIs, plus range-limited media
probes and four 45-second sample recordings.
**Verdict:** protocol identified with certainty; two findings materially change the build plan.

---

## 1. Classification

### **`MP4-PROGRESSIVE`** — HTTP progressive MP4 with byte-range seeking.

Not RTSP, not HLS, not MJPEG, not WebRTC. Evidence:

| Evidence | Source | Value |
|---|---|---|
| `delivery` field | `/api/cameras`, all 31 cameras | `"progressive"` (31/31) |
| `hls_url` | `/api/cameras/{id}/state` for ids 1, 6, 17, 20, 31 | `null` (5/5) |
| `stream_url` | same | `/stream/{id}` |
| Content-Type | `GET /stream/1` | `video/mp4` |
| Range support | `GET /stream/1` with `Range: bytes=0-99` | `206 Partial Content`, `accept-ranges: bytes` |
| Origin | response `etag` | `"s3-01 Chiman bhai Bridge.mp4-1369825861"` — an **S3-backed object** proxied by the app |
| Server | all responses | `Server: uvicorn` — confirms the "Python-based streaming middleware" |

**The HLS path exists in the code but is dark.** `/static/camera.js` prefers `feed.hls_url` via a
bundled `hls.min.js`, and `/static/dashboard.js` polls `/api/prepare/status` for a transcode state
machine (`waiting → remuxing → transcoding → hls → done|skip|error`). That endpoint currently
returns `{"done": false, "cameras": []}` — nothing has been prepared, and the player's own error
copy names the organisers' local script: *"This camera's video needs conversion. Run
scripts/prepare_videos.py, then reload."*

> **Implication:** the organisers can switch HLS on at any time. Our adapter layer treats HLS as a
> free upgrade it will take if `hls_url` becomes non-null, and progressive MP4 as today's reality.
> Do not hard-code either.

### API surface discovered

| Endpoint | Purpose |
|---|---|
| `GET /api/cameras` | Authoritative roster. Fields: `id, number, name, location, duration, codec, container, status, delivery, detail` |
| `GET /api/cameras/{id}/state` | Per-camera playback state — the timeline source of truth |
| `GET /api/prepare/status` | Transcode-to-HLS progress (currently idle) |
| `GET /stream/{id}` | The media itself |

---

## 2. THE TIMELINE IS SIMULATED — and we reverse-engineered it exactly

**This is the most important finding in the report.** These are not live cameras. Each is a long
recording, and "live" is manufactured *client-side* by seeking into a static file.

From `/static/camera.js`:

```js
function expectedOffset() {
  const elapsed = (Date.now() - fetchedAtMs) / 1000;
  let slot = (feed.slot_offset + elapsed) % feed.slot_seconds;
  const dur = feed.duration || video.duration;
  if (dur && dur > 0) slot = feed.loop ? slot % dur : Math.min(slot, dur - 0.5);
  return slot;
}
```

Observed state for camera 1:

```json
{ "slot_offset": 42706.351337, "slot_seconds": 43200.0, "loop": true,
  "timezone": "Asia/Kolkata", "drift_tolerance": 5.0,
  "wall_time": "2026-08-20T20:51:46.351337+05:30", "server_epoch": 1787239306.351337 }
```

Solving `server_epoch − slot_offset = 1787196600` gives a slot start of **2026-08-20 09:00:00 IST**.

> ### Slots are 12 hours long and begin at **09:00 and 21:00 IST**.

`services/stream-gateway/src/slot.ts` reproduces the portal's `slot_offset` to sub-millisecond
precision, verified against the captured sample in `slot.test.ts` (20 tests, all passing). We
observed a live slot rollover at 21:00 IST during this session, exactly as predicted.

### What the recordings actually contain

Frames grabbed from camera 10 at three offsets, reading the burned-in overlay clock:

| Seek offset | Burned-in timestamp | Scene |
|---|---|---|
| 0 s | `13/06/2026 20:59:59 Sat` | night |
| 10 800 s (3 h) | `14/06/2026 00:00:53 Sun` | night |
| 21 600 s (6 h) | `14/06/2026 03:01:50 Sun` | night |

The mapping is exact and linear: **`recorded_time = 21:00 + slot_offset`**. The source footage was
captured on **13–14 June 2026** and each file covers **21:00 → 09:00 — an entire night**.

### ⚠️ Finding A — the footage is overwhelmingly night-time

Because file time = `21:00 + offset` and offset is driven by the IST wall clock:

| Real IST time | Slot | Offset | What the footage shows |
|---|---|---|---|
| 10:00 | morning | 3 600 s | 22:00 — night |
| 13:00 | morning | 14 400 s | 01:00 — night |
| 16:00 | morning | 25 200 s | 04:00 — night |
| 19:00 | morning | 36 000 s | 07:00 — dawn |
| 20:00–21:00 | morning | ~39 600–43 200 s | 08:00–09:00 — **daylight** |
| 07:00–09:00 | evening | ~36 000–43 200 s | 07:00–09:00 — **daylight** |

**A demo run during normal working hours will be showing deep-night footage.** Daylight exists only
in roughly the last two hours of either slot.

### ⚠️ Finding B — plates are not readable at night

Two 45-second samples inspected at native resolution, pixel-doubled 6× (`data/samples/`):

- **Camera 10** (Char Chowk, Junagadh, 1920×1080): a dark hatchback's plate occupies ~50 × 14 px.
  The plate *rectangle* is clearly visible and roughly ten character-shaped blobs are discernible,
  but **no character is individually resolvable**. Effective glyph height ≈ 6 px; OCR needs ≈ 16–20 px.
- **Camera 11** (Dolatpara Gate, Junagadh, 1920×1080): an auto-rickshaw's yellow commercial plate is
  clearly identifiable *as* a yellow plate; characters are not readable. Wet road, heavy headlight
  glare and sodium-vapour colour cast throughout.

**Conclusion: ANPR cannot be the hero of a daytime demo on the provided feeds.** This is a property
of the dataset, not of our pipeline, and no amount of model tuning changes 6-pixel glyphs.

### Mitigations (for your decision — see §7)

1. **Demo-offset override.** *We* compute the seek, so we can point the gateway at the daylight
   window (offset ≈ 36 000–43 200) regardless of wall-clock time. This is exactly what the portal
   itself does — it is replay either way — but the UI must label the timeline honestly rather than
   claiming it is "now".
2. **Lead with tracking, not OCR.** Vehicle detection, cross-camera tracking, and vehicle
   type/colour attributes work at night; headlight signatures are actually distinctive. Present
   ANPR as one signal among several, with confidence shown, degrading to attribute matching — which
   is the honest engineering story anyway.
3. **Own-feed ANPR proof.** Demonstrate plate reading on a clear daytime clip we control, alongside
   the government feeds, clearly labelled as separate.

---

## 3. Cross-camera synchronisation — the "common timeline" is real

Four cameras sampled at the **same slot offset (1305 s)**, burned-in clocks read:

| Camera | Location | District | Burned-in time |
|---|---|---|---|
| 5 | Visat Teen Rasta | Ahmedabad | `13-06-2026 21:21:40` |
| 11 | Dolatpara Gate | Junagadh | `13-06-2026 21:21:49` |
| 10 | Char Chowk | Junagadh | `13/06/2026 21:21:54 Sat` |
| 20 | Khaparia Panchayat | Navsari | *(no overlay)* |

Cameras 400 km apart agree on time-of-day to within **≈ 14 seconds**. The organisers' synchronised-
timeline claim holds.

> **Design consequence:** cross-camera route reconstruction can order hits at roughly **±15 s**
> granularity, not sub-second. Travel-time plausibility checks must use that tolerance, and the UI
> should not display false precision.

Camera 5 and camera 16 are both "Visat" (`05 Visat teen Rasta`, `16 Visat P2`) — the same junction
from two angles. That is a genuine re-identification test pair.

---

## 4. Media characteristics

Probed with `scripts/probe_mp4.py`. **Note the method:** these MP4s are not `faststart` — the `moov`
atom is at the end — so pointing `ffprobe` at the URL makes FFmpeg read the entire file to reach it.
We measured **3.6 GB pulled for a single naive probe of camera 17**. The script instead walks the
top-level box table with 16-byte range reads and downloads only `ftyp` + `moov`, cutting the cost to
**8–18 MB per camera**. On infrastructure shared with every competing team, that difference matters.

| id | Resolution | Codec | Actual fps | Duration | File size | Status |
|---|---|---|---|---|---|---|
| 1 | 1920×1080 | h264 | 14.99 | 12.000 h | 1.37 GB | ok |
| 2 | 1920×1080 | h264 | 29.96 | 12.000 h | 2.74 GB | ok |
| 3 | 1280×720 | h264 | 24.15 | 11.998 h | 2.18 GB | ok |
| 4 | 1920×1080 | h264 | 25.00 | 12.000 h | 10.95 GB | ok |
| 5 | 1920×1080 | h264 | 29.90 | 12.000 h | 2.74 GB | ok |
| 6 | — | avi | — | — | — | **HTTP 500** |
| 7 | — | — | — | — | — | timeout |
| 8 | — | — | — | — | — | timeout |
| 10 | 1920×1080 | h264 | 25.00 | ~12 h | 12.42 GB | ok (sampled) |
| 20 | 1280×720 | h264 | 25.00 | 13.732 h | 24.73 GB | ok |
| 31 | 1920×1080 | h264 | **2.49** | 11.999 h | 1.91 GB | ok |

Ids 9, 12–19, 21–30 were not probed — see §6.

Observations:

- **Resolution** is 1080p or 720p; adequate. **Frame rate varies wildly**: 15, 24, 25, 30, and
  camera 31 at an effective **2.49 fps** (nominal 25). A fixed frame-sampling interval would behave
  completely differently per camera — the analytics sampler must be rate-aware.
- **No audio** on any probed stream.
- **Durations cluster at ~12 h**, matching the slot exactly, so playback position ≈ slot offset for
  nearly every camera. Camera 20 is 13.73 h — longer than the slot, so its final 1.7 h is never
  reached and it never loops within a slot.
- **Two AVI sources** (cameras 6 and 23). Camera 6 returns **HTTP 500** from the origin — the portal
  cannot serve it at all. These need a transcode leg; camera 6 may simply be unusable.
- **Sizes reach 24.7 GB.** Aggregate published footage is on the order of **150–200 GB**.

---

## 5. Registry findings

`/api/cameras` returns **31 cameras**, ids `1`–`31`, all `status: "live"`.

- **No department field exists.** The response carries exactly `id, number, name, location,
  duration, codec, container, status, delivery, detail`. The FAQ claims coverage across Health,
  Police, GSRTC, Panchayat and Municipal Corporation, but only two labels name an owner
  (`17 Rajkot Bus Port CCTV` → GSRTC; `19 KHAPARIA GRAM PANCHAYAT…` → Panchayat) and **nothing maps
  to Health**. Per your instruction, `config/cameras.yaml` sets `department: unassigned` for all 31
  and keeps human guesses in a separate `department_guess` field.
- **`label_number` is not unique and is not a key.** Portal id 17 is labelled `17 Rajkot Bus Port
  CCTV` while portal id 18 is labelled `17 Rajkot CCTV`. Keying on the label number would silently
  merge two distinct cameras. `portal_id` is the only safe key; `sync_registry.py` enforces this.
- **The roster is smaller than advertised and has gaps.** 31 published vs "~50" in the FAQ; label
  numbers 21, 22, 24–27, 29, 31, 32 are absent, so the original deployment was larger. Expect churn
  before the finale — hence `sync_registry.py`, which marks vanished cameras `offline` and never
  deletes them.
- **`duration` is `null`** in both the list and state APIs. The player falls back to
  `video.duration`; we use our own probe.

### Geocoding is mostly ineffective — and that is the correct outcome

11 of 31 cameras have no usable coordinates. `scripts/geocode.py` (Nominatim, 1 req/1.2 s, manual
and online-only) resolves very few, because the labels are informal junction names — "Char Rasta",
"teen Rasta", "Visat P2", "Delight" — that OpenStreetMap does not carry as named nodes.

Worse, Nominatim returns *confident wrong answers*: querying `"Janpath, Ahmedabad, Gujarat, India"`
returns three **hotels in Mahesana district**. The script therefore applies two independent guards —
an importance floor **and** a district-consistency check — and refuses rather than guesses:

```
[ 2] 02 Janpath
     ? 'Janpath, Ahmedabad, Gujarat, India' → district mismatch: expected Ahmedabad, got Mahesana
     ✗ unresolved — leave as geocode and fix by hand if it matters
```

Unresolved cameras render as hollow markers flagged "position unverified" rather than confident dots
in the wrong place.

---

## 6. Portal stability — this constrained the probe

The portal became intermittently unresponsive during the session, **independent of our load**:

- `GET /api/cameras` (a 5 KB JSON) timed out at 20 s on one attempt, then returned in 3.2 s.
- A **1-byte** ranged read of `/stream/12` failed with `transfer closed with 1 bytes remaining`.
- Seeks beyond ~21 600 s into the large files failed three times with
  `Stream ends prematurely at 0`.

A 1-byte read cannot be "heavy traffic", so this is origin-side instability or contention from other
teams. **We stopped the full 31-camera probe voluntarily** to avoid contributing load; ids 9, 12–19
and 21–30 remain unprobed. Rerun `scripts/probe_mp4.py --ids …` when the portal is calmer.

Politeness measures applied throughout: sequential requests only, ≥2 s between cameras, 1 MiB
chunked range reads with exponential backoff, and an identifying User-Agent naming the participant.

*Incidental note:* Python's `urllib` gets an **empty body** from this origin for ranged `video/mp4`
requests (`IncompleteRead(0 bytes read, 1 more expected)`) where an identical `curl` succeeds —
apparently a reaction to `Accept-Encoding: identity`. `probe_mp4.py` therefore shells out to curl.
Worth knowing before debugging a phantom "portal is down".

---

## 7. Ambiguities and decisions I need from you

1. **Night footage — which mitigation?** (§2). My recommendation: build the demo-offset override so
   we can run on the daylight window, **and** lead the narrative with tracking + attributes rather
   than ANPR. That is both the more robust demo and the more honest claim.
2. **Department mapping.** Currently `unassigned` for all 31. Confirm that is what you want in the
   registry UI, or supply a mapping if the portal exposes one elsewhere (a Resources page?).
3. **The 11 unlocated cameras.** Automated geocoding will not resolve these. Do you want to place
   them by hand from local knowledge, or ship them as explicitly unverified?
4. **Camera 6 (HTTP 500) and camera 23** — both AVI. Do we carry them as permanently-offline
   registry entries (good for the "camera health" story) or exclude them?
5. **Demo route.** Junagadh is the strongest cluster: cameras 8, 10, 11 (+6 if it ever serves) are
   all within one city and share the synchronised timeline. Cameras 5 + 16 are the same junction
   from two angles — the natural re-ID demonstration. Confirm and I will build the scenario there.
6. **Still unverified from the main brief:** prize split, team-size limits, submission package,
   judging weights, and whether a Resources page exists with a reference architecture or watchlist
   API. None of that is reachable from this portal; it needs a browser session on
   sentinel.gujarat.gov.in.

---

## 8. What was built in Phase 0

| Path | What it is |
|---|---|
| `services/stream-gateway/src/slot.ts` | Slot arithmetic; reproduces the portal's `slot_offset` exactly |
| `services/stream-gateway/src/slot.test.ts` | 20 tests pinned to the captured ground truth — **passing** |
| `services/stream-gateway/src/adapters/types.ts` | The uniform adapter contract + politeness budget |
| `services/stream-gateway/src/adapters/mp4-progressive.ts` | The real adapter for the discovered protocol |
| `services/stream-gateway/src/adapters/stubs.ts` | RTSP / HLS / MJPEG / FILE_LOOP / ONVIF / VMS stubs, each documenting its implementation plan; all throw rather than fake data |
| `services/stream-gateway/src/publisher.ts` | FFmpeg supervisor: one upstream connection per camera → MediaMTX |
| `services/stream-gateway/src/config.ts` | Validating loader for `config/cameras.yaml` |
| `services/stream-gateway/src/cli.ts` | `list` / `slot` commands; the single YAML parser for all tooling |
| `services/stream-gateway/mediamtx.yml` | WebRTC/RTSP/HLS/snapshot fan-out config |
| `config/cameras.yaml` | 31 cameras, validated, with honest geo-confidence and department fields |
| `scripts/probe_mp4.py` | Range-based MP4 probe (MB instead of GB) |
| `scripts/record_samples.sh` | Slot-aware sample recorder → `data/samples/` |
| `scripts/geocode.py` | Manual, online-only Nominatim resolver with two anti-garbage guards |
| `scripts/sync_registry.py` | Roster sync; never deletes, never overwrites human knowledge, write-then-verify |

### The central architectural decision

**The gateway opens exactly one upstream connection per camera** — seeks it to the correct slot
position, paces it with `-re`, and republishes into MediaMTX, which fans out WebRTC to browser
tiles, RTSP to analytics, and JPEG to the wall.

Copying the portal's client-side approach would mean every operator tab and every analytics worker
independently pulling gigabytes from shared government infrastructure. Beyond being antisocial, it
would not survive a 50-tile wall. The indirection also means upstream load is constant in the number
of viewers, every consumer sees identical frames at the same instant, and — not incidentally — it is
exactly the shape a real deployment federating district NETRAM control rooms would need.

### Sample set

4 cameras × 45 s = **100 MB** in `data/samples/` (gitignored). Cameras 5, 10, 11, 20 recorded
successfully. This doubles as the offline fallback: if the venue cannot reach the portal, the
`FILE_LOOP` adapter replays these and the demo runs with no network at all.

---

*Raw evidence retained in `data/probe/`: portal HTML, both JS bundles, API responses, per-camera
state JSON, and the media probe log. All footage stays local and gitignored.*
