# DrishtiNet — CLAUDE.md
(Working name. If the repo already carries another name, keep that one.)

## What this is
Student-category submission for the Gujarat Police Innovation Challenge 2026 ("Sentinel"; SCRB Gujarat Police, i-Hub Gujarat).
Hybrid of Reference Model 1 (MANDATORY: centralised CCTV registry + GIS, metadata-only) and a deep slice of Model 4 (vehicle analytics, cross-camera route reconstruction, watchlist alerts) on the organisers' live feeds. docs/ covers statewide scale (~80,000 cameras, 26 departments).
Deadlines (IST): last date 7 Sep 2026 · shortlisting 7 Sep evening · event 10–11 Sep · results 11 Sep. Build window is 26 Aug – 7 Sep. The extra time buys reliability, not features.

## Sources of truth (highest first)
1. data/probe/REPORT.md, docs/changelog/2026-08-21-portal-migration.md and config/cameras.yaml — measured facts about the real portal.
2. This file.
3. docs/research/brief.md — pre-Phase-0 research. Background for the docs phase only. Where it conflicts with 1 or 2 (camera count, protocol, ANPR-as-hero, placeholder URLs, "seed 50 cameras"), 1 and 2 win. Never implement from it.

## Ground truth (measured 20 Aug, migrated 21 Aug — see docs/changelog/2026-08-21-portal-migration.md)
- Portal moved: `live.sentinelgujarat.in` now 301-redirects to `live.corp8.cloud`. Discovery contract is `GET /api/ingest`. URL patterns are NOT the contract and must never be hardcoded.
- **Delivery is live RTSP/RTP.** No seeking, no byte ranges, cannot run ahead of real time. Per camera: `rtsp://<host>:8554/stream/<id>` (inference), `http://<host>:8889/stream/<id>/whep` (browser), `http://<host>/live/stream/<id>/index.m3u8` (restricted networks). `/stream/<id>` progressive MP4 is a **browser fallback only** — never a runtime source.
- **Consume only.** Never publish to the organisers' gateway; never call its control API. Each client gets its own copy, so open only cameras actively being processed and close what you are done with.
- **Do not plan around obtaining copies of the footage.** Evaluation exercises live consumption.
- Camera ids are POSITIONAL AND UNSTABLE. On 21 Aug "17 Rajkot CCTV" was removed and every id above it shifted down by one, silently repointing 14 ids at different physical cameras. Key the registry on the **label** (which carries the original deployment number); treat `portal_id` as a volatile index and reconcile every sync by label.
- Roster is now 30 cameras. `/api/ingest` `location` is a display label, NOT coordinates — the 11 unverified rows get nothing from the portal and still need the drag-to-place tool.
- Mixed codecs: 7 H.264, 4 H.265, 19 not yet reported. Mixed resolutions (1280x720 … 2560x1440) and frame rates (12.5 … 25 fps). Only 11 of 30 report stream properties at all.
- Slot model still holds and is still ours: 12-hour slots start 09:00 and 21:00 IST; each feed loops with a hard scene cut. Verified against the migrated backend (`offset 2786.176775` at `21:46:26` → slot start exactly 21:00:00). Slot logic: services/stream-gateway/src/slot.ts (`make verify-slot`).
- Cross-camera sync measured at ~±14 s. Cameras 5 and 16 are one junction from two angles — the re-ID validation pair.
- Plates at night ≈ 50×14 px (~6 px glyphs): detectable, not readable. Daylight helps colour and vehicle type far more than plates — the limit is camera geometry, not light. ANPR is opportunistic and confidence-gated. The headline is the vehicle signature: class + colour (flagged uncertain in low light) + appearance embedding + partial plate.
- Departments: the API has no department field → all unassigned. Assignment happens only through the audited workflow (UI + CSV import).
- Demo clusters: Junagadh primary (8, 10, 11) and Ahmedabad north (5, 16, 3, 12) — re-resolve ids by label before use.

## Non-negotiables
- Performance is the hard constraint: INP < 100 ms, LCP < 2.5 s, CLS < 0.05; alert detection→UI < 500 ms; focused tile glass-to-glass < 1 s; forensic search < 200 ms (served from the live index, never from video).
- Runs 100% offline: `docker compose up` on one laptop. No Vercel, no cloud, no internet on-site. Self-host map tiles, Gujarati glyph PBFs, fonts, model weights.
- Open-source only (organiser requirement).
- Never invent government API access. VAHAN/SARTHI/eGujCop/AFIS/NAFIS are local mocks with OpenAPI specs and a shared alert schema, labelled MOCK in the UI.
- No metric in the UI, HLD or deck without a label set behind it (data/labels/). State ANPR limits plainly.
- **Live-stream discipline.** Force RTSP over TCP. Reconnect with exponential backoff 2 s → 30 s cap. Decoder warnings at join (H.265 RPS/POC) are normal until the first IDR — log them, never treat as fatal. Registry/state polling ≥ 60 s. `LIVE_PULL_MAX=5` concurrent upstream cameras; lazy start, 60 s idle close.
- **Timing comes from PTS, never arrival time.** Every tracker, velocity and dwell computation uses PTS deltas (`CAP_PROP_POS_MSEC`). Never trust `CAP_PROP_FPS`; frame intervals are not uniform. The gateway replays a buffered GOP on connect, so the first 1–2 s arrive faster than real time — anchor absolute time only after that burst.
- **Every feed loops with a hard scene cut.** Long-lived state must recover: close open tracks, reset the background model and re-ID gallery for that camera, re-anchor, emit `camera.loop`. The same handler covers a real camera reboot.
- **The conformance suite (tests/conformance/) must be green before any connection to the real grid.** All eight checks, against our own MediaMTX self-test loop.
- Footage is government property. Mirror clips captured before the migration are **offline development fixtures only** (data/fixtures/, tagged `source=government-portal-progressive-2026-08`): unit tests, re-ID labelling, CI. Never presented as live in any demo; deleted after the event. The **evidence ring buffer** is the only government footage written to disk from now on — we record what we receive, we never fetch files. `make clean-data` removes both.
- Secrets only in .env. Never commit secrets.
- If an endpoint returns 401/403 or anything resembling a limit, STOP and report. Never bypass auth. Following a documented URL is not probing; working around a rejection is.

## Workspace rules — everything lives in this repository
- Never create, edit, or delete files outside the repo root. No global installs. No edits to ~/.* or system config.
- Python: .venv/ in the repo. Node: node_modules/ in the repo. Caches: .cache/ in the repo (gitignored).
- Model weights and OCR models: ./models/ (gitignored). Set in .env and docker-compose and pass explicit model-dir arguments so nothing lands in $HOME:
  YOLO_CONFIG_DIR=./.cache/ultralytics  TORCH_HOME=./.cache/torch  HF_HOME=./.cache/huggingface
  EASYOCR_MODULE_PATH=./.cache/easyocr  PIP_CACHE_DIR=./.cache/pip  npm_config_cache=./.cache/npm
  Ultralytics: load weights from ./models/<name>.pt explicitly. PaddleOCR (if used): point every *_model_dir at ./models/paddle/.
- Docker state as bind mounts under ./data/{postgres,redis,minio}.
- Fixtures, ring buffer, indexes: ./data/. Probe evidence and slot ground truth: ./data/probe/.

## Architecture
- apps/web — Next.js 15 App Router + TypeScript + Tailwind, standalone output.
- services/stream-gateway — one upstream pull per active camera into OUR MediaMTX (`sourceOnDemand`, 60 s idle), source chain RTSP-over-TCP → documented HLS → WHEP. Browser gets WHEP from ours; analytics reads RTSP from ours over TCP. Adapters behind one contract: browser_url / analytics_url / snapshot / health. `MP4_PROGRESSIVE` remains a stub, **disabled by default**. Retired range-based tooling lives in tools/legacy-progressive/.
- services/analytics — FastAPI + Ultralytics YOLO + ByteTrack/BoT-SORT + attributes + one embedding per track + opportunistic plate OCR with Indian-plate regex and state-code validation. Sampling on a **PTS grid** at 4–5 fps (nearest frame to each tick), per-camera decoder config from the catalogue, hardware decode where available. Continuous live indexing — detections/tracks/signatures written as they happen.
- services/event-bus — Redis Streams (Kafka/NATS documented only).
- services/alerts — watchlist rules → priority → WebSocket/SSE fan-out; latency instrumented detection→render.
- services/integrations — mock VAHAN/SARTHI/eGujCop/AFIS/NAFIS + shared alert schema.
- infra/docker-compose.yml — postgres+postgis, redis, minio, mediamtx, web, analytics, alerts, integrations.
- docs/ — HLD, infra sizing, cost-benefit (INR), DR, rollout, department-wise requirements, analytics_quality.md, changelog/, deck outline.

## Time model
- **Intra-stream:** PTS deltas only. Tracking, velocity, dwell — all from `CAP_PROP_POS_MSEC`.
- **Absolute:** per connection, after the join burst, `anchor = min over ~5 s of (arrival − PTS)`; `absolute_t = anchor + PTS`; `p = absolute_t − slot_start`, with `slot_start` from the catalogue/state polled ≥ 60 s.
- `recorded_at = epoch + p + (a + b·p)` — the forensic time operators see, used for all cross-camera correlation (tolerance ±15 s for pairs without a measured offset). `slot_time` (uncorrected) stored alongside.
- **Continuous reconciliation:** OCR the burned-in clock every ~60 s per active camera into `time_sync`; if a reading diverges from `recorded_at` by > 5 s, re-anchor and log a `clock_drift` event. This replaces manual anchor entry.
- observed_at = wall-clock receive time — latency instrumentation only. Never use raw PTS as an absolute event time.
- VIRTUAL_NOW_IST (env; default = real now) is the single demo time-shift. Every component reads it. When active, the app shell shows "TIME-SHIFT (demo)" and audit_log records it.

## Data model (PostgreSQL + PostGIS; Prisma where possible, raw SQL for geography)
departments · cameras(portal_id, label, label_number, name, district, dept_id nullable, geom geography(Point), location_status verified|approximate|unverified, location_uncertainty_m, location_basis, location_set_by, status online|degraded|offline, last_error, retention_days, storage_type) · camera_health · streams(source_type, rtsp_url, webrtc_url, hls_url, codec, width, height, fps, bitrate_kbps) · api_snapshots · time_sync · detections · tracks · vehicle_signatures(track_id, class, colour, colour_confidence, embedding, partial_plate) · plates · watchlists · watchlist_entries · alerts · alert_acknowledgements · events · evidence_clips(path, sha256, chain_of_custody jsonb) · users · roles · permissions · audit_log · department_assignments (audited) · gap_analysis views.

## Design rules
Dark ops/SOC theme; asymmetric split-pane with a persistent MapLibre map (self-hosted PMTiles + district GeoJSON) and a timeline scrubber; default viewport = Junagadh cluster. WebGL (React Three Fiber) ONLY on landing/login/about: lazy-init, frameloop="demand", DPR ≤ 2, GPU memory ≤ 200 MB, dispose on unmount, pause when any video tile is visible, honour prefers-reduced-motion. Operational pages: no WebGL background; CSS 3D buttons only. Fonts self-hosted (OFL): Inter/Geist, JetBrains Mono, Noto Sans Gujarati/Anek Gujarati. Icons: Lucide. Gujarati/English toggle. WCAG 2.1 AA, GIGW-friendly.
Tokens: base #0B0E14 · surface #121722 · elevated #1B2230 · text #E6EAF2 · muted #8A93A6 · accent saffron #FF8A3D + teal #2DD4BF · alerts critical #EF4444 / high #F59E0B / medium #3B82F6 / low #64748B. Type scale 12/14/16/20/24/32/48; spacing 4/8/12/16/24/32/48; radius 8/12/16; motion 150–250 ms ease-out.

## Key numbers for docs (sourced in docs/research/brief.md)
1080p H.265 ≈ 2 Mbps (H.264 ≈ 4). GB/day ≈ Mbps × 10.8. 80k cameras ≈ 160 Gbps aggregate, ≈ 1.73 PB/day, 7/15/30-day ≈ 12/26/52 PB → raw video cannot be centralised; edge/regional/central hybrid anchored to VISWAS/NETRAM/TRINETRA, GSWAN, GSDC (~30 Gbps). ~25–35 1080p streams per T4/L4 with a light detector. INR: RTX 4090 workstation ≈ ₹2.8 L, A100 server ≈ ₹18 L, cloud A100 ≈ ₹170–219/hr, L40S ≈ ₹61/hr.

## Compliance to cite
DPDP Act 2023 (+ Rules notified 13 Nov 2025), CERT-In 2022 directions (6-hour incident reporting, log retention, time sync), chain-of-custody for evidence clips (SHA-256 + immutable audit), RBAC/ABAC, ISO 27001, OWASP ASVS, GIGW 3.0 + WCAG 2.1 AA, data residency in India. Facial recognition: documented integration-readiness only.

## Workflow
Plan mode first; stop after presenting each phase plan. Small verified commits. Tests after each phase (Vitest/Playwright/pytest). Write-then-verify on every YAML edit. Ask before large refactors. Do not re-scaffold, re-seed placeholder cameras, or rebuild Phase 0 work.
