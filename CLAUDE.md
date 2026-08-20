# DrishtiNet — CLAUDE.md
(Working name. If the repo already carries another name, keep that one.)

## What this is
Student-category submission for the Gujarat Police Innovation Challenge 2026 ("Sentinel"; SCRB Gujarat Police, i-Hub Gujarat).
Hybrid of Reference Model 1 (MANDATORY: centralised CCTV registry + GIS, metadata-only) and a deep slice of Model 4 (vehicle analytics, cross-camera route reconstruction, watchlist alerts) on the organisers' simulated feeds. docs/ covers statewide scale (~80,000 cameras, 26 departments).
Deadlines (IST): submission 29 Aug 2026 · shortlist 30 Aug · on-site 1–2 Sep (Gandhinagar). Build window is 26–29 Aug. Scope ruthlessly; a working narrow slice beats a broken wide one.

## Sources of truth (highest first)
1. data/probe/REPORT.md and config/cameras.yaml — measured facts about the real portal.
2. This file.
3. docs/research/brief.md — pre-Phase-0 research. Background for the docs phase only. Where it conflicts with 1 or 2 (camera count, protocol, ANPR-as-hero, placeholder URLs, "seed 50 cameras"), 1 and 2 win. Never implement from it.

## Ground truth from Phase 0 (measured 20 Aug 2026)
- Portal: https://live.sentinelgujarat.in — 31 cameras (ids 1–31; the FAQ says ~50, expect the list to change). Registry API: /api/cameras and /api/cameras/{id}/state. Label numbers differ from portal ids after 17; store both (portal_id, label_number).
- Delivery: MP4 progressive at /stream/{id} (video/mp4, byte-range, S3 behind uvicorn). An HLS path exists (hls.min.js, /api/prepare/status) but is dark; the adapter treats it as a free upgrade if it lights up. Not RTSP. Not MJPEG.
- "Live" is simulated client-side by seeking into a static file. 12-hour slots start 09:00 and 21:00 IST. recorded_time = 21:00 + slot_offset; each file covers 21:00→09:00 of 13-06-2026. Daylight footage appears only ~18:00–21:00 and 06:00–09:00 IST; a 10:00–17:00 demo on this portal is 22:00–05:00 footage. Slot logic: services/stream-gateway/src/slot.ts (20 tests against captured ground truth; `make verify-slot`).
- Cross-camera sync is real: ~±14 s across cameras 400 km apart. Cameras 5 and 16 are one junction from two angles — the re-ID validation pair.
- Camera 6: HTTP 500 → status offline, kept in the registry. Camera 23: AVI container → online if ffmpeg range-seeks cleanly, else degraded with the reason. Cameras 9, 12–19, 21–30 unprobed: probe off-peak, sequential, moov-only; prioritise 12 (Adalaj toll) and 17 (Rajkot bus port) in a daylight window for plate legibility.
- Plates at night ≈ 50×14 px (~6 px glyphs): detectable, not readable. ANPR is opportunistic and confidence-gated. The headline is the vehicle signature: class + colour (flagged uncertain in low light) + appearance embedding + partial plate.
- 11 cameras have no verified location → location_status=unverified, district centroid + uncertainty circle. Never silently geocode; scripts/geocode.py is manual-only and writes candidates, not truth.
- Departments: the API has no department field → all 31 unassigned. Assignment happens only through the audited workflow (UI + CSV import). data/seeds/department_suggestions.csv holds the two label-derived suggestions (17 → GSRTC, 20 → Panchayat), flagged unconfirmed.
- Demo clusters: Junagadh primary (8, 10, 11; add 9 when probed). Ahmedabad north secondary (5, 16, 3, 12).

## Non-negotiables
- Performance is the hard constraint: INP < 100 ms, LCP < 2.5 s, CLS < 0.05; alert detection→UI < 500 ms; focused tile glass-to-glass < 1 s; forensic search < 200 ms (served from the pre-built index, never from video).
- Runs 100% offline: `docker compose up` on one laptop. No Vercel, no cloud, no internet on-site. Self-host map tiles, Gujarati glyph PBFs, fonts, model weights.
- Open-source only (organiser requirement).
- Never invent government API access. VAHAN/SARTHI/eGujCop/AFIS/NAFIS are local mocks with OpenAPI specs and a shared alert schema, labelled MOCK in the UI.
- No metric in the UI, HLD or deck without a label set behind it (data/labels/). State ANPR limits plainly.
- The portal is shared government infrastructure used by hundreds of teams. Lazy upstream (start on subscribe, idle-timeout 60 s); one connection per camera; registry/state polling ≥ 60 s; snapshot polling ≥ 2 s; exponential backoff with jitter; descriptive User-Agent; moov-only probes. Full-file downloads only for demo cameras 8, 10, 11, 5, 16 (≈18 GB); 2-hour daylight + 1-hour night windows for the rest; throttled ≤ 2 MB/s; off-peak IST; resumable; every transfer logged to data/transfer.log.
- Footage is government property: stays under data/ (gitignored), never committed, uploaded, or shared. `make clean-data` removes it.
- Secrets only in .env. Never commit secrets.

## Workspace rules — everything lives in this repository
- Never create, edit, or delete files outside the repo root. No global installs. No edits to ~/.* or system config.
- Python: .venv/ in the repo. Node: node_modules/ in the repo. Caches: .cache/ in the repo (gitignored).
- Model weights and OCR models: ./models/ (gitignored). Set in .env and docker-compose and pass explicit model-dir arguments so nothing lands in $HOME:
  YOLO_CONFIG_DIR=./.cache/ultralytics  TORCH_HOME=./.cache/torch  HF_HOME=./.cache/huggingface
  EASYOCR_MODULE_PATH=./.cache/easyocr  PIP_CACHE_DIR=./.cache/pip  npm_config_cache=./.cache/npm
  Ultralytics: load weights from ./models/<name>.pt explicitly. PaddleOCR (if used): point every *_model_dir at ./models/paddle/.
- Docker state as bind mounts under ./data/{postgres,redis,minio}. The one allowed exception: if Postgres is slow on macOS bind mounts, use a named volume for Postgres only and say so in README.md.
- Samples, mirrors, indexes: ./data/. Probe evidence and slot ground truth: ./data/probe/.

## Architecture
- apps/web — Next.js 15 App Router + TypeScript + Tailwind, standalone output.
- services/stream-gateway — one upstream ffmpeg per camera: range-seek to the slot offset, `-re` pace, publish to MediaMTX → WebRTC for the focused tile, cached snapshots for the wall, low-res substream for analytics. Drift check every 30 s (re-seek if > 2 s); automatic 09:00/21:00 rollover; FILE_LOOP mirror for demo cameras (UI shows a "source: local mirror" badge, nothing else changes). Other adapters (RTSP, HLS, MJPEG, ONVIF, VMS-SDK) are stubs behind one contract: browser_url / analytics_url / snapshot / health.
- services/analytics — FastAPI + Ultralytics YOLO + ByteTrack/BoT-SORT + attributes + one embedding per track + opportunistic plate OCR with Indian-plate regex and state-code validation. ONE code path, two modes: `--mode batch` (forensic pre-index of local files or byte-range windows; 2 fps on GPU, 1 fps on CPU) and `--mode live` (MediaMTX stream). CPU path: ONNX/OpenVINO + yolo*n. GPU path: optional TensorRT.
- services/event-bus — Redis Streams (Kafka/NATS documented only).
- services/alerts — watchlist rules → priority → WebSocket/SSE fan-out; latency instrumented detection→render.
- services/integrations — mock VAHAN/SARTHI/eGujCop/AFIS/NAFIS + shared alert schema.
- infra/docker-compose.yml — postgres+postgis, redis, minio, mediamtx, web, analytics, alerts, integrations.
- docs/ — HLD, infra sizing, cost-benefit (INR), DR, rollout, department-wise requirements, analytics_quality.md, deck outline.

## Time model
- recorded_at = slot_start_recorded + PTS offset + time_sync.clock_offset_s — the forensic time operators see; used for all cross-camera correlation (tolerance ±15 s for pairs without a measured offset).
- observed_at = wall-clock receive time — latency instrumentation only. Never use raw PTS as an event time.
- time_sync(camera_id, clock_offset_s, measured_from, measured_at, evidence_path), populated from burned-in clock readings.
- VIRTUAL_NOW_IST (env; default = real now) is the single demo time-shift. Every component reads it. When active, the app shell shows "TIME-SHIFT (demo)" and audit_log records it. It exists for daylight demos, never to misrepresent live performance.

## Data model (PostgreSQL + PostGIS; Prisma where possible, raw SQL for geography)
departments · cameras(portal_id, label, label_number, name, district, dept_id nullable, geom geography(Point), location_status verified|approximate|unverified, location_uncertainty_m, status online|degraded|offline, last_error, retention_days, storage_type) · camera_health · streams(source_type, source_url, substream_url, snapshot_url) · time_sync · detections · tracks · vehicle_signatures(track_id, class, colour, colour_confidence, embedding, partial_plate) · plates · watchlists · watchlist_entries · alerts · alert_acknowledgements · events · evidence_clips(path, sha256, chain_of_custody jsonb) · users · roles · permissions · audit_log · department_assignments (audited) · gap_analysis views (coverage, offline cameras, unverified locations, unassigned departments).

## Design rules
Dark ops/SOC theme; asymmetric split-pane with a persistent MapLibre map (OSM/OpenFreeMap tiles + Gujarati glyph PBFs, self-hosted) and a timeline scrubber; default viewport = Junagadh cluster. WebGL (React Three Fiber) ONLY on landing/login/about: lazy-init, frameloop="demand", DPR ≤ 2, GPU memory ≤ 200 MB, dispose on unmount, pause when any video tile is visible, honour prefers-reduced-motion. Operational pages: no WebGL background; CSS 3D buttons only. Fonts self-hosted (OFL): Inter/Geist, JetBrains Mono, Noto Sans Gujarati/Anek Gujarati. Icons: Lucide. Gujarati/English toggle. WCAG 2.1 AA, GIGW-friendly.
Tokens: base #0B0E14 · surface #121722 · elevated #1B2230 · text #E6EAF2 · muted #8A93A6 · accent saffron #FF8A3D + teal #2DD4BF · alerts critical #EF4444 / high #F59E0B / medium #3B82F6 / low #64748B. Type scale 12/14/16/20/24/32/48; spacing 4/8/12/16/24/32/48; radius 8/12/16; motion 150–250 ms ease-out.

## Key numbers for docs (sourced in docs/research/brief.md)
1080p H.265 ≈ 2 Mbps (H.264 ≈ 4). GB/day ≈ Mbps × 10.8. 80k cameras ≈ 160 Gbps aggregate, ≈ 1.73 PB/day, 7/15/30-day ≈ 12/26/52 PB → raw video cannot be centralised; edge/regional/central hybrid anchored to VISWAS/NETRAM/TRINETRA, GSWAN, GSDC (~30 Gbps). ~25–35 1080p streams per T4/L4 with a light detector. INR: RTX 4090 workstation ≈ ₹2.8 L, A100 server ≈ ₹18 L, cloud A100 ≈ ₹170–219/hr, L40S ≈ ₹61/hr.

## Compliance to cite
DPDP Act 2023 (+ Rules notified 13 Nov 2025), CERT-In 2022 directions (6-hour incident reporting, log retention, time sync), chain-of-custody for evidence clips (SHA-256 + immutable audit), RBAC/ABAC, ISO 27001, OWASP ASVS, GIGW 3.0 + WCAG 2.1 AA, data residency in India. Facial recognition: documented integration-readiness only.

## Workflow
Plan mode first; stop after presenting each phase plan. Small verified commits. Tests after each phase (Vitest/Playwright/pytest). Write-then-verify on every YAML edit. Ask before large refactors. Do not re-scaffold, re-seed placeholder cameras, or rebuild Phase 0 work.
