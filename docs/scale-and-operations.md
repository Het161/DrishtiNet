# Scaling, cost, disaster recovery and rollout

**Step 6 deliverable.** Companion to `hld.md`, which carries the architecture; this carries the
numbers and the plan for running it statewide.

---

## 1. The constraint everything follows from

| | |
|---|---|
| 1080p H.265 | ≈ 2 Mbps per camera (H.264 ≈ 4) |
| GB/day per camera | ≈ Mbps × 10.8 |
| 80,000 cameras, aggregate | **≈ 160 Gbps** |
| Per day | **≈ 1.73 PB** |
| 7 / 15 / 30-day retention | ≈ 12 / 26 / 52 PB |
| GSDC available | **~30 Gbps** |

160 Gbps against ~30 Gbps settles the architecture before any preference is expressed: **raw video
cannot be centralised.** Every design choice below is downstream of that single comparison.

---

## 2. Three tiers

**Edge (at or near the camera site).** Decode, sample on a PTS grid at 4–5 fps, detect, track, and
produce a vehicle signature. Video never leaves unless an operator asks for it. What leaves is
metadata — a signature is roughly 2 KB against roughly 216 MB/day of video for the same camera, a
reduction of about five orders of magnitude.

**Regional (district or range).** Aggregate metadata, hold the evidence ring buffer for its own
cameras, serve live view to operators in that region without crossing the state backbone. Retention
is set per department, since observed policy already varies between 7 and 15 days or more.

**Central (SCRB).** The registry, the statewide index, watchlists, alerting, cross-region
correlation and audit. It knows about every camera without holding a frame from any of them. This is
Model 1 doing the work that makes Model 4 affordable.

Anchored to existing infrastructure — VISWAS, NETRAM, TRINETRA, GSWAN, GSDC — rather than proposing
a parallel network.

---

## 3. Compute

Measured on this build: **25 sampled fps for one camera** on an Apple M-series GPU at 640 px
inference, which is roughly ten cameras per device at 4–5 fps sampling. Published capacity for a
T4/L4 with a light detector is ~25–35 1080p streams.

| Scale | Approach | Indicative GPUs |
|---|---|---|
| Pilot, 50 cameras | one workstation | 1 × RTX 4090 |
| District, ~2,000 cameras | regional edge cluster | ~60–80 × L4 |
| State, 80,000 cameras | distributed edge | ~2,300–3,200 × L4 equivalent |

The statewide figure is deliberately unflattering. Phasing matters more than the total: cameras in
the public domain on arterial roads carry most of the investigative value, and there is no need to
run heavy analytics on every godown camera to get most of the benefit.

**Indicative costs (INR).** RTX 4090 workstation ≈ ₹2.8 L · A100 server ≈ ₹18 L · cloud A100 ≈
₹170–219/hr · L40S ≈ ₹61/hr. On-premise wins decisively at steady state; cloud is useful for burst
re-processing during a live investigation.

---

## 4. Storage

| Tier | Holds | Where | Typical |
|---|---|---|---|
| Hot | live ring buffer, active investigations | regional NVMe | 24–72 h |
| Warm | departmental retention | regional bulk | 7–30 days per policy |
| Cold | evidence clips only | central, immutable | per case, years |

**Evidence is the only footage that travels.** A clip is cut stream-copy from the ring buffer with a
SHA-256 over the bytes and a sidecar recording the camera's internal id, the portal id as it was at
that moment, the time range, actor and reason. Re-encoding is never used — it would make the hash a
statement about our transcoder rather than about what the camera sent.

The index itself is small: 12,549 detections, 1,838 tracks and 957 signatures currently occupy well
under a gigabyte, and forensic search runs against it in 36–141 ms.

---

## 5. Network and low-bandwidth operation

- **Metadata-first** is the bandwidth strategy, not an optimisation on top of one.
- **Lazy pulls, bounded.** One upstream connection per camera, opened on demand, closed after 60 s
  idle, at most five concurrent. Viewers fan out from our own MediaMTX, so 50 operators watching one
  camera is still one upstream connection.
- **Documented fallbacks in order**: RTSP over TCP → HLS → WHEP. Restricted sites use HLS on 443.
- **Reconnect with 2 s → 30 s exponential backoff and jitter**, so a shared outage does not produce a
  thundering herd of thirty cameras retrying on the same millisecond.
- **Degraded mode is designed, not incidental**: with the bus down, indexing continues and only live
  alerting stops; with a camera unreachable, its last known state and index remain queryable.

---

## 6. High availability and disaster recovery

| Component | Failure mode | Recovery |
|---|---|---|
| Edge node | hardware loss | Cameras reassigned to a neighbouring node; index gap recorded explicitly, never silently |
| Regional store | disk loss | Metadata replicated to central; video for that window is lost and the registry says so |
| Central Postgres | corruption | Streaming replication + PITR; RPO ≤ 5 min, RTO ≤ 1 h |
| Event bus | outage | Indexing unaffected; alerts resume on reconnect — verified, ~9 s in practice |
| Whole site | loss | Regional nodes keep serving their own districts; central is not on the live path for viewing |

**Recorded gaps are first-class.** When a camera or node was down, the index says so rather than
presenting an absence of detections as an absence of vehicles. An investigator drawing a conclusion
from a gap needs to know it was a gap.

**Backups**: nightly full plus continuous WAL for Postgres; evidence clips written once and never
mutated; configuration in version control. Restore is rehearsed, not assumed.

---

## 7. Security operations

- **RBAC** with five roles; the only action that produces a `verified` camera position is restricted
  to two of them and writes an append-only audit row naming the human.
- **CERT-In 2022**: 6-hour incident reporting, 180-day log retention, NTP synchronisation to
  NIC/NPL. Time sync is not paperwork here — the whole correlation model depends on it.
- **DPDP Act 2023** (+ Rules notified 13 Nov 2025): purpose limitation, retention limits enforced by
  the ring buffer rather than by policy alone, and no biometric processing.
- **Facial recognition**: documented integration-readiness only. AFIS and NAFIS expose no lookup —
  only a statement that no matching is performed and no biometric data stored.

---

## 8. Rollout

**Phase 1 — Pilot (0–3 months).** One district. Registry and GIS for every camera in it, analytics on
the arterial subset. Proves the integration against real heterogeneous vendors, which is where
schedules actually slip.

**Phase 2 — Range (3–9 months).** Regional edge clusters, cross-district correlation, watchlist
integration with eGujCop under a real data-sharing agreement replacing the mock.

**Phase 3 — State (9–24 months).** Progressive onboarding by department, prioritising public-domain
cameras. Private cameras from societies and malls onboarded where permitted, through the same
adapter contract.

**What determines the pace** is not our software. It is data-sharing agreements, per-department
network reach, and the condition of existing installations. The registry is designed to be useful
from day one of each phase — a department that has only registered its cameras already gains
statewide visibility of what exists and what is broken, before any analytics is switched on.

---

## 9. Gap analysis as a standing feature

The registry tracks, per camera: position confidence and its basis, measured availability versus
what the portal claims, codec and resolution actually reported, and department assignment. Today
that shows 12 unverified positions and 31 unassigned departments out of 31 cameras — not a defect,
but the honest starting condition of any integration of this kind, and the list a rollout works
down.
