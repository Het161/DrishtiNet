# DrishtiNet — CLAUDE.md

## What this is
Submission for the Gujarat Police Innovation Challenge 2026 (Sentinel). Hybrid of
**Reference Model 1** (mandatory Centralised CCTV Registry + GIS, metadata-only) and a deep slice of
**Reference Model 4** (central AI: ANPR, vehicle tracking, cross-camera route reconstruction,
watchlist alerts) demoed live on ~50 simulated feeds. Docs cover statewide 80,000-camera scale.

## Non-negotiables
- **Performance is the hard constraint.** Budgets: INP < 100 ms, LCP < 2.5 s, CLS < 0.05,
  alert detection→UI < 500 ms, WebRTC glass-to-glass < 1 s.
- **Runs 100% OFFLINE via `docker compose up`.** No Vercel, no cloud, no internet at demo time.
  Self-host map tiles, glyphs and fonts. Every asset ships in-repo or in a volume.
- **Open-source only** (organizer requirement).
- **NEVER invent government API access.** VAHAN / SARTHI / eGujCop / AFIS / NAFIS are LOCAL MOCKS
  with OpenAPI specs. Every response and every UI surface that shows their data is labelled `MOCK`.
- **Never fabricate accuracy numbers.** State realistic ANPR limits (degrades on low-res / night /
  oblique angle). Show per-read confidence in the UI.
- **Secrets only in `.env`.** Never commit secrets. `.env.example` is the committed template.

## Architecture
```
apps/web                 Next.js 15 App Router + TS + Tailwind v4, standalone output
packages/shared          Shared TS types: event/alert schemas, WS contract, plate regex
packages/db              Prisma schema + PostGIS SQL migrations + seed
services/stream-gateway  MediaMTX + adapter layer (RTSP/HLS/MJPEG/file-loop/ONVIF-stub/VMS-stub)
services/analytics       Python FastAPI + Ultralytics YOLO + ByteTrack + plate OCR
services/alerts          Watchlist rules engine + WebSocket/SSE fan-out
services/integrations    Mock VAHAN/SARTHI/eGujCop/AFIS/NAFIS + OpenAPI specs
infra/docker-compose.yml postgis, redis, minio, mediamtx, web, analytics, alerts, integrations
docs/                    HLD, infra sizing, INR cost-benefit, DR, rollout, compliance, pitch
```
Event bus is **Redis Streams** (Kafka/NATS documented, not built). Evidence clips in **MinIO**.

## Data
PostgreSQL 16 + PostGIS 3.4. `cameras.geom` is `geography(Point, 4326)` — Prisma cannot express
PostGIS types, so `geom` is declared `Unsupported("geography(Point, 4326)")` and all spatial reads
go through raw SQL in `packages/db/src/spatial.ts`. Never try to select `geom` through the
generated Prisma client.

## 3D / design rules
- WebGL (React Three Fiber) **ONLY** on `/`, `/login`, `/about`. Operational pages (map, video wall,
  alert triage) get **zero WebGL background** — CSS 3D buttons only.
- Cap DPR at 2, GPU memory ≤ 200 MB, `frameloop="demand"`, lazy-init via IntersectionObserver,
  dispose on unmount, honor `prefers-reduced-motion`, pause animation when any video tile is visible.
- Dark SOC theme, asymmetric bento/split-pane, **persistent MapLibre map** + timeline scrubber.
- Fonts self-hosted (all SIL OFL): Inter (UI), JetBrains Mono (mono), Noto Sans Gujarati (Gujarati).
- Icons: Lucide. Design tokens live in `apps/web/src/styles/tokens.css` — never hardcode a hex.

## Key numbers for docs (keep every doc consistent with these)
- Per camera 1080p: H.265 ≈ 2 Mbps, H.264 ≈ 4 Mbps. Storage GB/day ≈ Mbps × 10.8.
- 80,000 cameras: ~160 Gbps aggregate (H.265); ~1.73 PB/day; 7/15/30-day ≈ 12 / 26 / 52 PB.
- GPU: ~25–35 concurrent 1080p streams per T4/L4 with a light detector at 2–5 fps.
- INR: RTX 4090 workstation ~₹2.8 L; refurb A100 80GB server ~₹18 L; cloud A100 ~₹170–219/hr,
  L40S ~₹61/hr, H100 ~₹219/hr (MeitY-empanelled India cloud).
- Anchor to Gujarat's real stack: VISWAS / NETRAM / TRINETRA, GSWAN backbone, GSDC (~30 Gbps).

## Compliance to cite
DPDP Act 2023 (Rules notified 13 Nov 2025, phased), CERT-In 2022 directions (6-hour incident
reporting, 180-day log retention, NTP sync), chain-of-custody + SHA-256 for evidence, RBAC/ABAC,
ISO 27001, OWASP ASVS, GIGW 3.0 + WCAG 2.1 AA, Gujarati localization.

## Unverified facts — do NOT assert these as certain
The exact prize split, team-size limits, submission package contents, judging rubric weights, and
the organizer Resources page (dataset, streaming middleware, **feed protocol**) are portal-only and
unconfirmed. `docs/00-hackathon-facts.md` tracks verified vs unverified. Do not hardcode an
assumption about the provided feed protocol — the adapter layer exists precisely to absorb it.

## Workflow
Small verified commits. Run tests after each phase (Vitest/Playwright/pytest). Ask before large
refactors. `pnpm -w check` must pass before any commit.
