# DrishtiNet — Solution Presentation

Slide content for the PPT/PDF deliverable. One `##` per slide. Speaker notes in *italics*.
Every figure here is measured; nothing is aspirational.

---

## 1 · DrishtiNet

**Centralised CCTV registry and GIS, with vehicle analytics that respects what the cameras can
actually see.**

Gujarat Police Innovation Challenge 2026 · Student category
Reference Model 1 (mandatory) + a deep slice of Model 4

*A hybrid, which the problem statement explicitly permits.*

---

## 2 · The problem, in one number

**160 Gbps** aggregate at 80,000 cameras. **~30 Gbps** available on GSDC.

Raw video cannot be centralised. That is not a procurement problem — it is arithmetic.

| | |
|---|---|
| 1080p H.265 | ≈ 2 Mbps |
| 80,000 cameras | ≈ 1.73 PB/day |
| 30-day retention | ≈ 52 PB |

*So the design question is not "how do we move the video" but "what must move instead".*

---

## 3 · What moves instead: metadata

Video stays at the edge. **Metadata is centralised.**

The registry knows every camera — where it is, who owns it, whether it is alive — without holding
one frame of its footage. That is Model 1, and it is what makes Model 4 affordable.

---

## 4 · What we built

- **Camera registry + GIS** — 31 cameras, 9 districts, offline basemap, audited placement
- **Stream gateway** — one upstream pull per camera, ≤5 concurrent, lazy, 60 s idle close
- **Analytics** — PTS-grid sampling → YOLO → ByteTrack → vehicle signature
- **Alerts** — watchlist matching → priority → live feed, latency instrumented
- **Operations screen** — live alerts beside forensic search, both from the index
- **Route reconstruction** — cross-camera, geography-constrained
- **Mock integrations** — VAHAN, SARTHI, eGujCop, AFIS, NAFIS, every one labelled

*Runs entirely offline: `docker compose up` on one laptop, no internet.*

---

## 5 · Measured, not claimed

| Property | Budget | Measured |
|---|---|---|
| Detection → alert on screen | 500 ms | **3–46 ms** |
| Forensic search | 200 ms | **36–141 ms** |
| Route reconstruction | — | **139–373 ms** |
| Analytics, one camera | 5 fps | **25 sampled fps** |

165 unit tests · 13 end-to-end tests · 12,969 detections indexed, including a live run

---

## 6 · The decision that defines this submission

**ANPR does not work on this grid, and we can prove it.**

> Measured in **daylight**, at the organisers' own camera geometry: median vehicle box **164 px
> wide** → a ten-character plate is **~41 px**. OCR needs ~90 px.
> **Zero of 27 sampled vehicles cleared the bar.**

The limit is camera distance and sensor resolution — **not lighting**. No model choice fixes it.

*So we did not install an OCR engine. A recogniser on a 41 px plate does not fail cleanly — it
returns a confident wrong registration number. A wrong registration in a police alert is worse than
no alert at all.*

---

## 7 · What identifies a vehicle instead

**Class + colour + 512-dimension appearance embedding.**

| | Median cosine similarity |
|---|---|
| Same vehicle | **0.950** |
| Different vehicles | **0.544** |

OSNet x0.25 · MSMT17 · MIT licence · ONNX · 0.9 MB

*Plate is corroboration when legible, never the primary key. That ordering is forced by the
measurement on the previous slide.*

*This is **separation**, not accuracy: "same vehicle" means the tracker assigned the same id, and no
hand-labelled set exists. No precision or recall figure appears anywhere in this submission, because
computing one would need labels we do not have. See docs/analytics_quality.md.*

---

## 8 · Honesty is a feature

The system states its own uncertainty rather than rounding it away:

- **Colour uncertain** below a measured brightness threshold — 0/138 flagged in daylight, 13/146 at night
- **"Not legible"** where a plate could not be read, never a guess
- **Repaired readings** never render identically to clean ones
- **MOCK** on anything a mocked government system touched
- **Auto clock-anchoring built, measured at 35.4 % against a 95 % gate, and disabled**

*An operator who catches the system overstating once stops trusting it entirely.*

---

## 9 · Route reconstruction — and the trap in it

At cosine 0.82, the appearance model found:

- **949 matches** between cameras 5 and 16 — one junction, two angles ✓
- **20 matches** between cameras 5 and 10 — **~300 km apart** ✗

*Two white cars that look alike. An appearance model cannot tell the difference, because nobody
asked it about geography.*

**A route requires four things**: it looks the same, it is the same class, it comes next in time,
and **it is somewhere the vehicle could have reached** (< 140 km/h).

Legs touching an unplaced camera are shown as *not verifiable* — "not disproved" must never render
as "confirmed".

---

## 10 · Surviving reality

On 21 August the portal **migrated from progressive MP4 to live RTSP**, removed a camera, and
shifted every id above it down by one — silently repointing **13 ids at different physical cameras**.

- A registry keyed on `portal_id` would have reported the wrong junction for 13 cameras, indefinitely
- Ours keys on the **label**; `portal_id` is an attribute
- Nothing downstream of the adapter contract changed when the protocol did

*This is the strongest evidence that the architecture is sound: it was tested by an unannounced
change, not by us.*

---

## 11 · Scaling to 80,000

**Edge → regional → central**, anchored to VISWAS, NETRAM, TRINETRA, GSWAN, GSDC.

- Video stays local; metadata centralises
- ~25–35 1080p streams per T4/L4 with a light detector
- Retention tiered hot/warm/cold by department policy (7/15/30 days observed)
- RTX 4090 ≈ ₹2.8 L · A100 server ≈ ₹18 L · cloud L40S ≈ ₹61/hr

---

## 12 · Compliance

DPDP Act 2023 (+ Rules, 13 Nov 2025) · CERT-In 2022 directions · ISO 27001 · OWASP ASVS ·
GIGW 3.0 + WCAG 2.1 AA · data residency in India

- RBAC, five roles; placement restricted and audited
- Evidence: SHA-256 + immutable chain of custody, stream-copy only
- **We never fetch footage** — the ring buffer records only what we already receive
- Facial recognition: **documented integration-readiness only**

---

## 13 · Proven on the live grid

**26 August — the organisers' own feed, not a fixture.**

- Documented **HLS** endpoint reads after a cookie/session redirect
- `ffprobe`: **H.264 1920×1080 @ 25 fps**
- 45-second live run: **420 detections across 58 tracks**, written to the index as they happened
- PTS advancing at a 40 ms median gap — real time, no running ahead

RTSP `:8554` and WHEP `:8889` stay filtered from our network, so HLS is the path in use — which is
precisely what the integration reference nominates for restricted networks.

---

## 14 · What we do not claim

- **ANPR is not demonstrated on the government feed** — at this camera geometry a plate is ~41 px
- **VAHAN, SARTHI, eGujCop, AFIS, NAFIS are mocks.** No live government access is held
- **No facial recognition.** Documented integration-readiness only
- The conformance suite runs against **our own self-test grid**, not the organisers'

*We would rather state the gap than have an evaluator find it.*
