# Sentinel 2026 — pre-Phase-0 research brief (ARCHIVED)

> **Status: source of truth #3 — background for the docs phase only.**
>
> This is the research compiled *before* the portal was probed on 2026-08-20. Several of its
> operating assumptions were falsified by measurement. Where this document conflicts with
> `data/probe/REPORT.md` or `config/cameras.yaml`, **those win**. Never implement from this file.
>
> **Known-superseded claims:**
>
> | This brief says | Measured reality |
> |---|---|
> | ~50 camera feeds; seed 50 placeholder cameras | **31 cameras**, ids 1–31, roster changes |
> | Protocol unknown (RTSP / HLS / MJPEG?) | **MP4 progressive** over HTTP byte-range; HLS path exists but is dark |
> | ANPR is the hero of the demo | Plates ≈ 6 px glyphs at night → **ANPR is opportunistic**; the vehicle signature leads |
> | Placeholder stream URLs | Real: `/stream/{id}` behind `/api/cameras` |
> | WebRTC glass-to-glass is the key latency metric | The feeds are replayed VOD; **timeline alignment** matters more |
>
> Its *documentation* value is intact: the scale arithmetic, INR costings, compliance anchors and
> Gujarat infrastructure references below are what `docs/` is built on.

---

## Verified hackathon facts (from press, 17–19 Aug 2026)

- **Prize pool ₹37 lakh total.** ANI (17 Aug 2026): *"The six best-performing teams from the first
  stage will... demonstrate their solutions in a live production environment based on real-world
  policing scenarios. The winning teams will receive cash prizes totalling Rs 37 lakh."*
- **Two stages.** Stage 1 = Open Innovation Challenge, two categories: (1) students + small/medium
  startups; (2) large startups + established companies. Stage 2 = Finale with **six top teams**.
- **Scale/goal:** unify 80,000+ CCTV cameras across 26 departments / 34 districts; test ANPR,
  vehicle tracking, watchlist matching, cross-camera search, real-time alerts.
- **Live-feed novelty.** The Blunt Times (17 Aug 2026): *"for the first time in the country,
  participants will work on live CCTV camera feeds based on real-world situations."*
- Guided by DGP G.S. Malik; announced by Home Minister Harsh Sanghavi; tech partner i-Hub Gujarat;
  knowledge partners DA-IICT and NFSU.

## Still unverified (portal-only — confirm in a browser)

Exact prize split by category/rank; team-size limits; the exact submission package (file types,
PPT/HLD, demo-video length, repo links); judging-rubric weights; whether "top 6" is pooled or
per-category; the Resources page (reference architecture PDF, dataset manifest, streaming
middleware, watchlist/test-dataset API docs, webinar recordings); registration mechanics.

**Conflict to resolve:** a 19 Aug News Mill item cites **₹51 lakh** for a CCTV challenge announced
at the *separate* KANAD S.H.I.E.L.D. cybersecurity hackathon (Ahmedabad City Police). Do not
conflate its rules with Sentinel's.

The dates in the original brief (submission 29 Aug, shortlist 30 Aug, finale 1–2 Sep) are not
corroborated by public press; treat as portal-sourced.

---

## Solution shape

**Model 1 (Centralised CCTV Registry & GIS Foundation) is mandatory for all submissions** —
metadata-only, GIS map, camera health, gap analysis, RBAC, audit. It is the guaranteed-scored
baseline. Add a **thin, deep slice of Model 4** (central AI: ANPR, tracking, cross-camera route
reconstruction, alerts) to win the live challenge. **Skip Model 2/3 middleware-federation depth** —
document it, don't build it. Represent VAHAN/SARTHI/eGujCop/AFIS/NAFIS via **mock adapters with
documented OpenAPI contracts and a standardized alert schema** — never claim real access.

**Demoed live:** registry + GIS, the feed wall, track a designated vehicle across cameras, watchlist
alert with route polyline + evidence-clip export, audit log, Gujarati toggle.
**Documented only:** 80k-camera scale math, infra sizing + INR cost-benefit, DR/rollout,
department-wise requirements, VAHAN/AFIS integration contracts, security/compliance.

---

## Streaming / VMS integration (for the HLD)

Indian government CCTV is heterogeneous: Hikvision / Dahua / CP Plus / Bosch / Axis cameras; VMS
such as Milestone XProtect, Genetec, HikCentral, Dahua DSS; Indian analytics vendors (Videonetics,
Vehant, Staqu, AllGoVision). Anchor to standards: **RTSP** for streams; **ONVIF** Profile S
(streaming), G (recording/edge storage), T (H.265), M (metadata/analytics), with **WS-Discovery**
for onboarding. Analog cameras integrate via encoders/DVRs exposing RTSP.

Browsers cannot play RTSP natively. The defensible low-latency path is **RTSP→WebRTC via MediaMTX
or go2rtc**, which passes H.264 through without re-encoding — roughly **sub-300 ms to ~0.5 s**
glass-to-glass. LL-HLS is ~2–5 s (worse, but CDN-friendly). For a large tile wall, do **not** open
one WebRTC peer connection per tile: use **snapshot/JPEG polling** for the grid and upgrade only the
focused tile to WebRTC; virtualize, use hardware decode, pause off-screen decode.

For decoding many concurrent streams, GStreamer is most efficient; **FFmpeg/PyAV** are the pragmatic
choice. Never decode every stream at full rate — sample frames. (Frigate's go2rtc-based restream
pattern is a proven reference: a low-res "detect" role plus a high-res "record" role per camera.)

---

## AI analytics

- **Detection/tracking:** YOLOv8/YOLO11 (Ultralytics) + **ByteTrack** (fast, motion-only) or
  **BoT-SORT** (camera-motion compensation + optional appearance re-ID).
- **Indian plates:** standard white/yellow, HSRP, BH-series, two-line square plates, non-standard
  hand-painted fonts. Open stack: a YOLO plate detector + OCR (EasyOCR, PaddleOCR, fast-plate-ocr).
  A specialist option is **Awiros/anpr-ocr** on Hugging Face: 37M parameters on a PP-OCRv5/SVTR_HGNet
  backbone, whose card claims *"98.42% accuracy with sub-6ms on-device inference on an NVIDIA RTX
  3090"* trained on *"a curated 558,767-sample corpus spanning both standard single-row and
  non-standard dual-row Indian plate formats."*
- **Realistic accuracy:** Parvaiz (2025), *IJCA* v187 no.48, reports *"OCR's character-level
  detection accuracy was around 88.2%... The average time per image of inference was around 43
  milliseconds"* (YOLOv11 + EasyOCR). Curated YOLOv7/v8 + PaddleOCR studies reach 95–97%, **but real
  CCTV at 720p/1080p, at night and at oblique angles is much harder.**
- **Post-processing:** Indian plate regex (state code + RTO district + series + number), state-code
  validation, dedup windows, confidence thresholds; read the plate **once per track id**.
- **Cross-camera:** when the plate is unreadable, use vehicle re-ID (VeRi-776; FastReID; or BoT-SORT
  appearance embeddings) plus colour/type attributes; reconstruct the route by ordering camera hits
  on time + geography (PostGIS distance + plausible travel time).
- **Face/anomaly:** treat facial recognition as **documented integration-readiness only** given DPDP
  sensitivity. Anomaly detection (loitering/wrong-way/abandoned object) — mention, don't build.
- **Optimization:** ONNX Runtime / OpenVINO (CPU) or TensorRT (GPU). **CPU fallback:** YOLO11n
  exported to OpenVINO gives ~12 FPS single-stream on a desktop CPU vs ~2–3 FPS raw PyTorch.

> Superseded in practice: on the provided feeds, night-time plates are ~6 px glyphs. See
> `data/probe/REPORT.md` §2. The vehicle signature leads; ANPR is confidence-gated and opportunistic.

---

## Government database integration (mock only)

- **VAHAN/SARTHI** (NIC/MoRTH, Parivahan): national vehicle-registration and driving-licence
  repositories; data sharing is governed by the **National Transport Repository data-sharing
  policy** (annual approval, undertakings, logging). **API Setu** exposes RC/DL verification. Mock a
  `/vahan/vehicle/{plate}` returning RC owner/status.
- **eGujCop** = Gujarat's CCTNS implementation. Per The Protector: *"The eGujCop app is being used by
  over 90,000 officers and employees of 713 police stations... The State Crime Record Bureau (SCRB)
  is the nodal agency for implementation of CCTNS."* SCRB organises this hackathon — worth citing.
- **CCTNS/ICJS** interoperate police/courts/prisons/forensics/fingerprints; **NAFIS** (NCRB) is the
  national fingerprint repository issuing a National Fingerprint Number. A CCTV platform
  realistically consumes **match alerts** (webhook/event), not raw biometric search.
- Use a **standardized alert schema** across all sources so adding a real adapter later needs no
  redesign.

---

## 80,000-camera arithmetic (the numbers docs/ must stay consistent with)

Per-camera bitrate: **1080p H.264 ≈ 4 Mbps; 1080p H.265 ≈ 2 Mbps.** Storage: **GB/day ≈ Mbps × 10.8.**

- **Aggregate bandwidth:** 80,000 × 2 Mbps ≈ **160 Gbps** (H.265); ≈ 320 Gbps at H.264. This dwarfs
  even GSDC's ~30 Gbps internet capacity — **centralising all raw video is infeasible.**
- **Storage per day:** 80,000 × 2 × 10.8 ≈ **1.73 PB/day**.
  **7 days ≈ 12 PB; 15 ≈ 26 PB; 30 ≈ 52 PB** (before RAID/overhead; add ~15–20%). H.264 doubles it.
- **Defensible answer:** edge/regional/central hybrid — first-pass analytics and retention at
  district NETRAM / department VMS; the central platform holds metadata (PostGIS/Timescale), events
  and evidence clips (MinIO/S3) only, with hot/warm/cold tiering. Aligns with the existing
  **VISWAS / NETRAM / TRINETRA** deployment (7,000+ cameras at ~1,200 junctions across 34 district
  NETRAM control rooms, state TRINETRA i3C in Gandhinagar), the **GSWAN** backbone and **GSDC**
  (India's first State Data Centre, ~30 Gbps).
- **GPU sizing:** on an NVIDIA T4, NVIDIA's DeepStream reference achieves roughly **16–32 concurrent
  1080p streams** with a lightweight detector (up to ~30–35 with ResNet10 at reduced resolution;
  fewer with heavier YOLO). Budget **~25–35 streams/GPU** at 2–5 fps. 80,000 / ~30 ≈ **~2,600 GPUs**
  if every camera ran continuous AI — hence motion-gating, sub-sampling, and analysing only priority
  cameras. Jetson Orin boxes for edge inference.
- **INR benchmarks (2026):** RTX 4090 workstation from **~₹2.8 lakh**; refurbished A100 80GB server
  **~₹18 lakh**; MeitY-empanelled India cloud (E2E/Cyfuture) roughly **A100 ₹170–219/hr, L40S
  ₹61/hr, H100 ₹219/hr**.
- **Event bus:** Redis Streams for the build; Kafka/NATS documented for scale.
  **Observability:** Prometheus/Grafana/Loki/OpenTelemetry. **HA/DR:** active-passive across GSDC +
  a DR site; phased rollout pilot district → region → state.

---

## Security / compliance / legal

- **DPDP Act 2023** — CCTV capturing identifiable individuals is personal data; biometric/facial
  data is highly sensitive. The **DPDP Rules 2025 were notified 13 Nov 2025** (G.S.R. 843(E) &
  846(E)) with a phased timeline: Rules 1–2 and 17–21 immediately, consent-manager rules after
  ~12 months, substantive obligations after ~18 months. Section 17(2)(a) lets the government exempt
  an "instrumentality of the State" for law enforcement — but a defensible design still applies
  purpose limitation, data minimisation, retention limits, RBAC, encryption at rest/in transit, and
  audit. Frame facial recognition cautiously.
- **CERT-In 2022 directions:** report certain cyber incidents **within 6 hours of detection**, plus
  log retention (180 days) and mandatory time sync — a dual clock alongside the DPDP Board's 72-hour
  breach notification.
- **Other anchors:** MeitY/STQC/NCIIPC guidance, ISO 27001, OWASP ASVS, zero-trust, RBAC/ABAC, data
  residency in India, and **chain-of-custody / forensic soundness** for evidence clips (NFSU is a
  knowledge partner — hash + immutable audit trail is a differentiator). **GIGW 3.0** + **WCAG 2.1
  AA**; Gujarati/Hindi localisation; state-emblem usage rules.

---

## Design and performance engineering

**Performance is the constraint; 3D serves it, never fights it.**

- **Quarantine WebGL** (Three.js / React Three Fiber) to landing, login and about only. Operational
  surfaces (map, wall, triage) get zero WebGL background — CSS 3D transforms for buttons.
- **GPU budget:** cap `devicePixelRatio` at 2; GPU memory ≤ 200 MB; lazy-init via
  IntersectionObserver; `frameloop="demand"`; KTX2 textures; dispose on route change. Honour
  `prefers-reduced-motion`. **Pause all animation when a video tile is visible.**
- **Budgets:** INP < 100 ms, LCP < 2.5 s, CLS < 0.05, alert propagation < 300–500 ms, WebRTC
  glass-to-glass < 1 s. Verify with Lighthouse, `web-vitals`, WebRTC `getStats()`, a k6 load test,
  and custom alert-latency instrumentation.
- **Maps:** MapLibre GL + OSM/OpenFreeMap tiles; clustering, department layers, health colours,
  coverage-gap heatmap, route-polyline playback. Self-host Gujarati glyph PBFs.
- **Typography (SIL OFL):** Inter / Geist / Space Grotesk; JetBrains Mono; Noto Sans Gujarati /
  Anek Gujarati / Hind Vadodara / Mukta Vaani. Self-host everything for offline use.
- **Offline on-site:** no Vercel — everything via `docker compose up`; Next.js standalone.

---

## Competitive / judging intel

Comparable events: Smart India Hackathon, Kavach (BPR&D/AICTE), Devbhoomi Cyber Hackathon
(Uttarakhand Police), Goa/Telangana police hackathons, i-Hub/Smart Gujarat Hackathon. Winners
consistently ship a **reliable, operator-friendly, end-to-end** demo — not the most models.

What SCRB/police evaluators reward: reliability, ease of use for constables and control-room
operators, Gujarati UI, fast searchability, audit trails, evidence export, uptime, and a believable
scale/cost story.

**Live-demo failure modes → mitigations:** stream drops → pre-recorded backup video + local file-loop
feeds + auto-reconnect; OCR misreads → read once per track + regex normalisation + show confidence;
timezone drift → force IST, single clock; laptop thermal throttle → cap concurrent analytics
streams, cooling pad, mains power; projector → test 1920×1080 early, large fonts; no venue internet
→ 100% offline `docker compose up`, self-hosted tiles and fonts, all government APIs mocked locally.

---

## Source list

- **Hackathon (press):** ANI News, Prokerala, Open Magazine, Devdiscourse, The Blunt Times, LatestLY,
  Gujarat Samachar (English), The News Mill; Harsh Sanghavi on X. Official portal
  sentinel.gujarat.gov.in (blocks automated fetch).
- **Streaming/VMS:** MediaMTX & go2rtc docs (go2rtc advertises ~0.5 s WebRTC); Frigate docs; TheRelay.
- **GPU/throughput:** NVIDIA DeepStream performance docs; Ultralytics YOLO/track docs; OpenVINO
  YOLO11 benchmarks; LearnOpenCV CPU FPS measurements.
- **ANPR:** Awiros/anpr-ocr model card; Parvaiz (2025) IJCA v187 no.48; ResearchGate/IARJSET
  YOLOv7/v8 + PaddleOCR; IEEE DataPort Indian LPR dataset.
- **Re-ID:** Ultralytics vehicle re-ID blog; VeRi-776; FastReID.
- **Government:** Parivahan National Transport Repository data-sharing policy; API Setu;
  MHA/digitalpolice CCTNS/ICJS/NAFIS; The Protector (eGujCop).
- **Gujarat infra:** DeshGujarat/ANI/PIB (VISWAS/NETRAM/TRINETRA); GIL VISWAS RFP; DST-Gujarat
  (GSDC, GSWAN).
- **Storage/bandwidth:** CCTV storage calculators (GB/day ≈ Mbps × 10.8; 1080p H.265 ≈ 2 Mbps).
- **Compliance:** HyperVerge/Law.asia/Bar & Bench (DPDP + FRT); DPDP Rules 2025 notification;
  UJA / King Stubb & Kasiva (CERT-In 6-hour); NFSU journal.
- **Design/performance:** R3F scaling-performance docs; Codrops; Core Web Vitals + WebGL budget
  write-ups; MapLibre docs; SIL OFL fonts.
- **GPU pricing (India):** E2E Networks, Cyfuture, Cantech, Serverwale, AceCloud.
