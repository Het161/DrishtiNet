# DrishtiNet — High-Level Design

**Gujarat Police Innovation Challenge 2026 · Sentinel · Student category**
Reference Model 1 (mandatory) + a deep slice of Model 4 — a hybrid, as the problem statement permits.

Every number in this document was measured on the organisers' own feeds or on this build. Where a
thing was not measured, it says so.

---

## 1. What the system does

A vehicle passes a camera. Within half a second an operator sees an alert naming the camera, what
the vehicle looks like, how confident the match is, and how that confidence was reached. An
investigator can then ask where else that vehicle has been and get an answer in under a fifth of a
second, from an index rather than from video.

Three claims, all measured on this build:

| Property | Budget | Measured |
|---|---|---|
| Detection → alert on screen | 500 ms | **3–46 ms** |
| Forensic search over the index | 200 ms | **36–141 ms** |
| Route reconstruction across cameras | — | **139–373 ms** |
| Analytics throughput, one camera | 5 fps | **25 sampled fps** on Apple MPS |

Current index: 12,969 detections, 1,896 tracks, 973 vehicle signatures across 3 cameras — including
a live run against the organisers' grid on 26 August over the documented HLS endpoint: **420
detections across 58 tracks in 45 seconds**, H.264 1920x1080 at 25 fps.

---

## 2. Architecture

```
     organisers' grid                    DrishtiNet
  ┌───────────────────┐        ┌──────────────────────────────────┐
  │ RTSP  :8554       │        │  stream-gateway                  │
  │ WHEP  :8889       │──pull─▶│  one upstream pull per camera,   │
  │ HLS   :443        │        │  lazy, ≤5 concurrent, 60 s idle  │
  │ /api/ingest       │        └───────────┬──────────────────────┘
  └───────────────────┘                    │ our MediaMTX
                                           │
                    ┌──────────────────────┼───────────────────────┐
                    ▼                      ▼                       ▼
              analytics              browser (WHEP)          evidence ring
         PTS-grid sample 4–5 fps                          (only footage on disk)
         YOLO → ByteTrack
         signature: class+colour+embedding
                    │
                    ▼ Redis Streams
               alerts engine ──▶ SSE ──▶ operator screen
                    │
                    └──▶ integrations (MOCK: VAHAN, SARTHI, eGujCop, AFIS, NAFIS)

              PostgreSQL + PostGIS — registry, index, alerts, audit
```

**Why a gateway sits in front of everything.** The organisers give each client its own copy of a
stream. Letting every browser tile and every analytics worker open its own upstream connection would
multiply load on shared infrastructure by the number of viewers. One pull per camera feeds our own
MediaMTX; everything downstream reads from us. The ceiling of five concurrent upstream cameras is a
politeness limit, not a performance one.

**Why the adapter contract matters.** Every source answers four questions — `browser_url`,
`analytics_url`, `snapshot`, `health`. On 21 August the portal migrated from progressive MP4 files
to live RTSP. Nothing downstream of the gateway changed.

---

## 3. Integrating heterogeneous cameras

The challenge is 26 departments, mixed vendors, mixed VMS. Our adapter layer is the answer, and it
was proven by surviving a real migration rather than by assertion.

**Identity is the label, never the vendor's id.** On 21 August the portal removed one camera and
every id above it shifted down by one — silently repointing thirteen ids at different physical
cameras. A registry keyed on `portal_id` would have carried on reporting the wrong junction for
thirteen cameras and never noticed. Ours reconciles by label; `portal_id` is an attribute.

A second, portal-independent signal backs this up: a **scene fingerprint** (perceptual hash of a
10 s median frame, bucketed by time of day). Measured separation on fixtures: same camera, same
bucket 0–14 bits; different cameras 22–38. Label match plus hash match reattaches automatically; any
mismatch raises an identity conflict that a human confirms, and every reattachment is an audit event.

**Reading a live stream correctly.** Eight rules from the organisers' integration reference, each
with a passing conformance test: RTSP forced over TCP; declared frame rate never used for timing;
arrival time never used for timing; non-uniform frame intervals tolerated; reconnect with 2 s → 30 s
backoff; decoder warnings at join treated as normal until the first IDR; mixed H.264/H.265 and mixed
resolutions handled; behaviour sane across the loop cut.

Those rules exist twice — TypeScript in the gateway, Python in analytics — because the two processes
timestamp the same frames and cannot share code. Two copies of a rule drift, and a drift here would
not crash anything: it would quietly place one vehicle at two different times on two cameras. So
`make xcheck-timing` runs both implementations over identical inputs and compares them exactly.

---

## 4. Time, and why it is the foundation

Cross-camera correlation is arithmetic on timestamps. Get the timestamps wrong and every route is
fiction.

- **Intra-stream timing is PTS only.** `CAP_PROP_FPS` is never consulted; the declared rate does not
  match delivery.
- **Absolute time is anchored after the join burst.** The gateway replays a buffered group-of-pictures
  on connect, so the first 1–2 s arrive faster than real time. The anchor is `min(arrival − PTS)` over
  a settling window, because network delay only ever *adds* to arrival — the least-delayed frame is
  closest to the truth, and averaging would bake in the burst's queueing delay.
- **`recorded_at` is the forensic time**, derived from slot position plus that camera's measured clock
  drift. `observed_at` — when we received the frame — is latency instrumentation only. Both are stored,
  and confusing them is the error the schema is shaped to prevent.
- **Clock drift is measured, not assumed.** The fallback rate (+0.5139 %) is labelled as borrowed from
  camera 10 rather than measured on the camera it is applied to.

**A gate we enforced against ourselves.** Automatic clock anchoring by OCR of the burned-in overlay
was built, measured at **35.4 % exact-read accuracy against a 95 % gate**, and disabled. Camera 16 has
no burned-in clock at all. The feature is off because the measurement said so.

---

## 5. Video analytics

**Sampling.** Frames are chosen on a PTS grid at 4–5 fps — the frame nearest each tick, not every
Nth frame. Frame intervals here are not uniform, so every-Nth gives the tracker a varying dt it reads
as erratic velocity, and the join burst would oversample the first second.

**Detection and tracking.** Ultralytics YOLO with ByteTrack association. Vehicle classes plus person;
no facial recognition is performed anywhere.

**The vehicle signature is the identifier — not the plate.** This is the most important design
decision in the submission, and it was forced by measurement:

> On the organisers' footage, **in daylight**, at their camera geometry: the median vehicle box is
> **164 px wide**, which puts a ten-character plate at roughly **41 px**. Reliable OCR needs nearer
> 90 px. **Zero of 27 sampled vehicles** cleared that bar. At night the same conclusion arrives from
> the other direction — plates around 50×14 px with ~6 px glyphs.

The limit is camera distance and sensor resolution, not lighting, and no model choice fixes it. So
no OCR engine is installed: a recogniser run on a 41 px plate does not fail cleanly, it returns a
confident wrong registration number, and a wrong registration in an alert is worse than no alert.
The plate path is gated on measured crop width and the hook stays injectable for footage where the
geometry permits it.

What identifies a vehicle instead is class + colour + a 512-dimension OSNet appearance embedding
(OSNet x0.25, MSMT17, MIT-licensed, ONNX, 0.9 MB). Measured on real vehicles:

| | Median cosine |
|---|---|
| Same vehicle, different frames | **0.950** |
| Different vehicles | **0.544** |

**Colour states its own doubt.** Below a measured brightness threshold the signature sets
`colour_uncertain`, and the interface shows it. Verified selective rather than decorative: 0 of 138
signatures flagged in daylight, 13 of 146 at night.

---

## 6. Watchlist correlation and alerting

Redis Streams carries finished signatures — not raw detections, which would be 11,000 per
camera-minute for no gain — to the alerts engine. Matching leads on appearance and treats a plate as
corroboration, which is the ordering the plate measurement forces.

Every alert records how it was reached: `matched_via` (plate, plate-alternate, appearance,
attributes), `repaired` when a plate reading needed confusion-pair repair, `confidence`, and
`pipeline_latency_ms` measured server-side. A repaired reading never renders identically to a clean
one.

**Cross-camera route reconstruction** is where the measurements pay off, and where a naive design
would have produced something dangerous. At cosine 0.82 the appearance model found 949 same-class
matches between cameras 5 and 16 — one junction seen from two angles, correct — and **20 matches
between cameras 5 and 10, which are ~300 km apart in different districts.** Those are two white cars
that look alike. An appearance model cannot tell the difference; nobody asked it about geography.

A route therefore requires four things: it looks the same, it is the same class, it comes next in
forensic time, and **it is somewhere the vehicle could actually have reached** — under 140 km/h from
the previous sighting. Legs involving a camera with no placed position are kept but shown as *not
verifiable*, because a mapping gap is not evidence of absence, and "not disproved" must never render
as "confirmed".

---

## 7. Security, privacy and compliance

- **RBAC**, five roles. Placement — the only action that can produce a `verified` position — is
  restricted to two, and writes `location_set_by` plus an append-only audit row.
- **Chain of custody**: evidence clips carry SHA-256 over the bytes, a sidecar recording the camera's
  internal id, the portal id *as it was at that moment*, the time range, actor and reason. Stream-copy
  only — re-encoding would make the hash a statement about our transcoder rather than about what the
  camera sent.
- **We never fetch footage.** The organisers' reference says not to plan around obtaining copies, and
  we do not. The evidence ring buffer records only what we are already lawfully receiving, and only
  while a path is active — so a camera nobody is watching is never recorded.
- **DPDP Act 2023** (+ Rules notified 13 Nov 2025), **CERT-In 2022 directions** (6-hour incident
  reporting, log retention, time synchronisation), ISO 27001, OWASP ASVS, GIGW 3.0 + WCAG 2.1 AA, data
  residency in India.
- **Facial recognition: documented integration-readiness only.** AFIS and NAFIS expose no lookup at
  all — only a statement that no biometric matching is performed and no biometric data stored.
- **Every mocked system says so**, in the response body, in an HTTP header, and on screen.

---

## 8. Scaling to ~80,000 cameras

The arithmetic that decides the architecture:

| | |
|---|---|
| 1080p H.265 | ≈ 2 Mbps (H.264 ≈ 4) |
| 80,000 cameras | ≈ 160 Gbps aggregate |
| Per day | ≈ 1.73 PB |
| 7 / 15 / 30-day retention | ≈ 12 / 26 / 52 PB |
| GSDC available bandwidth | ~30 Gbps |

**Raw video cannot be centralised.** 160 Gbps against ~30 Gbps is not a procurement problem, it is an
impossibility. The architecture is therefore edge → regional → central, anchored to VISWAS, NETRAM,
TRINETRA and GSWAN, with **metadata centralised and video staying local**. Model 1's registry is what
makes that coherent: the centre knows about every camera without holding its footage.

Inference capacity: ~25–35 1080p streams per T4/L4 with a light detector. Measured here: 25 sampled
fps on one laptop GPU for one camera at 4–5 fps sampling — about ten cameras per device at demo
settings.

Indicative costs (INR): RTX 4090 workstation ≈ ₹2.8 L · A100 server ≈ ₹18 L · cloud A100 ≈ ₹170–219/hr
· L40S ≈ ₹61/hr.

---

## 9. What is not built, and what we do not claim

Stated plainly, because a submission that hides its edges invites the discovery of them.

- **The live grid is reachable over HLS, and the pipeline runs on it.** Verified on 26 August:
  the documented HLS endpoint returns the master and media playlists after a cookie/session
  redirect, ffprobe reports H.264 1920x1080 at 25 fps, and a 45-second live run produced 420
  detections across 58 tracks. RTSP `:8554` and WHEP `:8889` remain filtered from this network, so
  HLS is the path in use — which is exactly what the reference nominates for restricted networks.
- **ANPR is not demonstrated on the government feed**, for the geometric reason above: at this
  camera geometry a plate is ~41 px wide.
- **VAHAN, SARTHI, eGujCop, AFIS and NAFIS are local mocks.** No live government access is held or
  implied. AFIS and NAFIS expose no lookup at all.
- **No facial recognition is implemented.** Documented integration-readiness only.
- **The conformance suite runs against our own MediaMTX self-test loop**, not against the grid.

---

## 10. Verification

Everything above is reproducible from the repository:

```
make check            # 165 unit tests, all packages typechecked
make e2e              # 13 end-to-end tests in a real browser
make xcheck-timing    # proves the Python and TypeScript timing rules agree
make conformance      # the organisers' §4 checklist, against our self-test grid
make smoke            # starts every service, checks it answers, stops it again
```
