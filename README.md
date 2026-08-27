# DrishtiNet

**A centralised CCTV registry and GIS, with vehicle analytics that respects what the cameras can
actually see.**

Gujarat Police Innovation Challenge 2026 ("Sentinel") · SCRB Gujarat Police · i-Hub Gujarat
Student category · Reference Model 1 (mandatory) + a deep slice of Model 4

---

## What it does

A vehicle passes a camera. Within tens of milliseconds an operator sees an alert naming the camera,
what the vehicle looks like, how confident the match is, and how that confidence was reached. An
investigator can then ask where else that vehicle has been and get an answer from an index rather
than from video.

| Property | Budget | Measured |
|---|---|---|
| Detection → alert on screen | 500 ms | **3–46 ms** |
| Forensic search over the index | 200 ms | **36–141 ms** |
| Cross-camera route reconstruction | — | **139–373 ms** |
| Analytics throughput, one camera | 5 fps | **25 sampled fps** |

165 unit tests · 13 end-to-end tests in a real browser · runs fully offline

---

## The measurement that shaped the design

ANPR does not work on this grid, and that is demonstrable rather than an opinion:

> Measured in **daylight**, at the organisers' own camera geometry: the median vehicle box is
> **164 px wide**, which puts a ten-character number plate at roughly **41 px**. Reliable OCR needs
> nearer 90 px. **Zero of 27 sampled vehicles** cleared that bar.

The limit is camera distance and sensor resolution, not lighting. So no OCR engine is installed — a
recogniser run on a 41 px plate does not fail cleanly, it returns a confident wrong registration
number, and a wrong registration in a police alert is worse than no alert.

What identifies a vehicle instead is **class + colour + a 512-dimension appearance embedding**:

| | Median cosine similarity |
|---|---|
| Same vehicle, different frames | **0.950** |
| Different vehicles | **0.544** |

Plate is corroboration when legible, never the primary key.

---

## Routes respect geography, not just resemblance

At a cosine threshold of 0.82 the appearance model found **949 matches** between cameras 5 and 16 —
one junction seen from two angles, which is correct — and **20 matches between cameras 5 and 10,
which are ~300 km apart in different districts**. Those are two white cars that look alike.

So a route requires four things: it looks the same, it is the same class of vehicle, it comes next
in forensic time, and **it is somewhere the vehicle could physically have reached**. Legs involving a
camera with no placed position are kept but shown as *not verifiable* — a mapping gap is not evidence
of absence, and "not disproved" must never render as "confirmed".

---

## Honesty as a design constraint

The system states its own uncertainty rather than rounding it away:

- **Colour uncertain** below a measured brightness threshold — verified selective: 0 of 138
  signatures flagged in daylight, 13 of 146 at night
- **"Not legible"** where a plate could not be read, never a guess
- **Repaired plate readings** never render identically to clean ones
- **MOCK** on anything a mocked government system touched
- Automatic clock-anchoring by OCR was built, **measured at 35.4 % against a 95 % gate, and disabled**

---

## Architecture

```
organisers' grid            DrishtiNet
  RTSP :8554  ──pull──▶  stream-gateway ──▶ our MediaMTX ──┬──▶ browser (WHEP)
  WHEP :8889             ≤5 concurrent, lazy,              ├──▶ analytics
  HLS  :443              60 s idle close                   └──▶ evidence ring buffer
  /api/ingest
                         analytics: PTS-grid sample → YOLO → ByteTrack → signature
                              │
                              ▼ Redis Streams
                         alerts engine ──SSE──▶ operator screen
                              │
                              └──▶ integrations (MOCK: VAHAN, SARTHI, eGujCop, AFIS, NAFIS)

                         PostgreSQL + PostGIS — registry, index, alerts, audit
```

| Path | What it is |
|---|---|
| `apps/web` | Next.js 15 — registry + GIS, operations screen, route reconstruction |
| `services/stream-gateway` | One upstream pull per camera; the uniform adapter contract |
| `services/analytics` | Python: PTS-grid sampling, detection, tracking, vehicle signatures |
| `services/alerts` | Watchlist matching, priority, SSE fan-out, latency instrumented |
| `services/integrations` | Mock government systems, every response labelled |
| `packages/db` | PostGIS schema, migrations, seed |
| `docs/` | [HLD](docs/hld.md) · [deck](docs/deck.md) · [scaling & operations](docs/scale-and-operations.md) |

---

## Running it

Everything runs offline on one machine — no internet, no cloud.

```bash
make setup          # dependencies into .venv/ and node_modules/, both in-repo
make infra          # postgres + postgis, redis, minio, mediamtx
make migrate        # additive migrations; never resets
make analytics-deps # torch, ultralytics, and model weights into ./models/
npm run dev         # web on :3001, gateway :4001, alerts :4002, integrations :4003
```

Sign in at `/login` with `admin` / `drishti_dev_only` (seed default; set `SEED_PASSWORD` and
re-seed for anything beyond local use).

Index a development fixture to populate the operations screen:

```bash
make index-fixture ARGS='--fixture data/fixtures/cam_10_daylight.mp4 \
  --label "10 char-chowk-road-2-junagadh" --seconds 60'
```

### Verification

```bash
make check          # 165 unit tests, all packages typechecked
make e2e            # 13 end-to-end tests in a real browser
make xcheck-timing  # proves the Python and TypeScript timing rules still agree
make conformance    # the organisers' §4 checklist, against our own self-test grid
make smoke          # starts every service, checks it answers, stops it again
```

`xcheck-timing` exists because the live-stream rules are implemented twice — TypeScript in the
gateway, Python in analytics — since the two processes timestamp the same frames and cannot share
code. Two copies of a rule drift, and a drift there would not crash anything: it would quietly place
one vehicle at two different times on two cameras.

---

## What this does not claim

- **No live-grid demonstration yet.** RTSP :8554 and WHEP :8889 do not answer from our network —
  they hang rather than refuse, the signature of a filtered port — and the documented HLS fallback
  returns 401 on its media playlist. `/api/ingest` answers 200, so the grid is up and we reach it.
  All analytics results here were produced against offline development fixtures, and none is
  presented as live.
- **VAHAN, SARTHI, eGujCop, AFIS and NAFIS are local mocks.** No live government access is held or
  implied. AFIS and NAFIS expose no lookup at all.
- **No facial recognition is implemented.** Documented integration-readiness only.
- **The conformance suite has not run against the real grid**, because the grid has not been
  reachable. It runs green against our own MediaMTX self-test loop.

---

## Data handling

Footage is government property. It is never committed, uploaded or shared.

- Pre-migration captures under `data/fixtures/` are **offline development fixtures only** — unit
  tests, re-identification labelling, CI — and are deleted after the event.
- The **evidence ring buffer** is the only government footage written to disk from now on: we record
  what we are already receiving and never fetch files.
- `make clean-data` removes both.
- Secrets live only in `.env`, which is gitignored and has never been committed.

---

## Licence

Open source throughout, as the challenge requires. Model weights: YOLOv8n (Ultralytics, AGPL-3.0)
and OSNet x0.25 (MIT). Basemap: OpenStreetMap contributors (ODbL) via Protomaps; district boundaries
from DataMeet (CC BY 4.0).
