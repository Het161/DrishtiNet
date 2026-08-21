# Registry reconciliation — 2026-08-21 portal migration

Every camera, what happened to it, and why we believe the row after the sync describes the same
physical camera as the row before it. One row per camera. Read the *Decision basis* column.

## What forced this

The portal removed the camera labelled `17 Rajkot CCTV` and shifted every id above it down by one.
Thirteen cameras kept their identity and changed id. Our registry keyed on `portal_id`, so an
id-keyed sync would have carried each camera's coordinates, district, cluster, department
suggestion, time_sync anchors and audit history onto whichever camera *now* holds that id — without
raising a single error.

Reconciliation is therefore by **label**, which survived the migration unaltered and is unique
across all 30 roster entries (verified). A changed id is recorded as a rename.

## Evidence used

| Signal | Role |
|---|---|
| **Label** | Primary identity. Unique, portal-stable across this migration. |
| **Scene fingerprint** (pHash of a 10 s median frame, bucketed by 30-min slot offset) | Second, independent signal. Computed from fixtures for 4 cameras; from live frames in 2.4. |
| Portal id | Attribute only. Never a key, never a join column. |

Measured fingerprint separation on fixtures: same camera/same bucket **0–14 bits**, different
cameras **22–38 bits**. Day-vs-night on the *same* camera measures 24–32 bits, which is why
comparison is confined to a slot bucket — a cross-bucket comparison would read as a conflict.

## The table

| Old id | New id | Label | Carried forward | Decision basis |
|---:|---:|---|---|---|
| 1 | 1 | `01 Chiman bhai Bridge` | coordinates, location basis, district, cluster, dept suggestion | label match, id unchanged |
| 2 | 2 | `02 Janpath` | location basis, district, cluster, dept suggestion | label match, id unchanged |
| 3 | 3 | `03 O.N.G.C. Office` | coordinates, location basis, district, cluster, dept suggestion | label match, id unchanged |
| 4 | 4 | `04 Paldi Circle` | coordinates, location basis, district, cluster, dept suggestion | label match, id unchanged |
| 5 | 5 | `05 Visat teen Rasta` | coordinates, location basis, district, cluster, dept suggestion | label match, id unchanged |
| 6 | 6 | `06 Timbavadi gate-Junagadh` | coordinates, location basis, district, cluster, dept suggestion | label match, id unchanged |
| 7 | 7 | `07 hero-showroom-gir-somnath` | coordinates, location basis, district, cluster, dept suggestion | label match, id unchanged |
| 8 | 8 | `08 majewadi-gate-junagadh` | coordinates, location basis, district, cluster, dept suggestion | label match, id unchanged |
| 9 | 9 | `09 new-bypass-near-by-circle-junagadh-2` | location basis, district, cluster, dept suggestion | label match, id unchanged |
| 10 | 10 | `10 char-chowk-road-2-junagadh` | coordinates, location basis, district, cluster, dept suggestion | label match, id unchanged |
| 11 | 11 | `11 dolatpara-junagadh` | coordinates, location basis, district, cluster, dept suggestion | label match, id unchanged |
| 12 | 12 | `12 Tri Mandir Adalaj Tollnaka` | coordinates, location basis, district, cluster, dept suggestion | label match, id unchanged |
| 13 | 13 | `13 CN Vidhyalaya` | coordinates, location basis, district, cluster, dept suggestion | label match, id unchanged |
| 14 | 14 | `14 Delight` | location basis, district, cluster | label match, id unchanged |
| 15 | 15 | `15 Suvidha park` | location basis, district, cluster | label match, id unchanged |
| 16 | 16 | `16 Visat P2` | coordinates, location basis, district, cluster, dept suggestion | label match, id unchanged |
| 17 | 17 | `17 Rajkot Bus Port CCTV` | coordinates, location basis, district, cluster, dept suggestion | label match, id unchanged |
| 19 | 18 ↔ | `18 Rajkot CCTV` | location basis, district, cluster, dept suggestion | label match, id shifted 19->18 |
| 20 | 19 ↔ | `19 KHAPARIA GRAM PANCHAYAT , TALUKA GANDEVI, DISTRICT NAVSARI` | coordinates, location basis, district, cluster, dept suggestion | label match, id shifted 20->19 |
| 21 | 20 ↔ | `20 Mohanpura` | location basis | label match, id shifted 21->20 |
| 22 | 21 ↔ | `23 Patan Dethali Char Rasta` | coordinates, location basis, district, cluster, dept suggestion | label match, id shifted 22->21 |
| 23 | 22 ↔ | `28 BK Mervada tran Rasta` | location basis, district, cluster, dept suggestion | label match, id shifted 23->22 |
| 24 | 23 ↔ | `30 kheram` | location basis | label match, id shifted 24->23 |
| 25 | 24 ↔ | `33 dehgam` | coordinates, location basis, district, cluster, dept suggestion | label match, id shifted 25->24 |
| 26 | 25 ↔ | `34 dhanori` | location basis | label match, id shifted 26->25 |
| 27 | 26 ↔ | `35 TANKAL` | location basis, district, cluster, dept suggestion | label match, id shifted 27->26 |
| 28 | 27 ↔ | `36 bilimora` | coordinates, location basis, district, cluster, dept suggestion | label match, id shifted 28->27 |
| 29 | 28 ↔ | `37 bilimora` | coordinates, location basis, district, cluster, dept suggestion | label match, id shifted 29->28 |
| 30 | 29 ↔ | `38 bilimora` | coordinates, location basis, district, cluster, dept suggestion | label match, id shifted 30->29 |
| 31 | 30 ↔ | `Gandhidham Rambaugh p2` | coordinates, location basis, district, cluster, dept suggestion | label match, id shifted 31->30 |
| 18 | released ⚠️ | `17 Rajkot CCTV` | location basis, district, cluster, dept suggestion | absent from /api/ingest; id released, row retained |

↔ = id changed, same physical camera.  ⚠️ = left the roster.

## The departed camera

`17 Rajkot CCTV` is absent from `/api/ingest`. It is **not deleted** — deleting it would erase the
geography research attached to it and, in a real registry, the audit trail of a decommissioned
camera. It is marked `offline`, its `portal_id` is **released** to `NULL` (recorded as
`last_portal_id = 18`), and it is addressed internally as `offline:17-rajkot-cctv`.

The id had to be released because ids get reused: id 18 now belongs to `18 Rajkot CCTV`, a
different physical camera. Two rows claiming id 18 would have meant whichever a lookup found first
silently won. Our loader's duplicate-id check caught this at startup.

## What was NOT carried

Nothing was invented. Specifically:

- **No coordinates were moved between cameras.** Each row kept its own.
- **No department was assigned.** All 31 rows remain `unassigned`; `/api/ingest` carries no
  department field, and assignment happens only through the audited workflow.
- **No position became `verified`.** That tier is reachable only through the drag-to-place tool,
  which records the operator's name.
- **`location` from `/api/ingest` is a display label, not coordinates** — so the 11 unlocated
  cameras gained nothing from the migration.

## Integrity checks after the sync

| Check | Result |
|---|---|
| Live ids matching `/api/ingest` exactly | 30 / 30 |
| Duplicate portal ids | none |
| Duplicate labels | none |
| Streams carrying all three live endpoints | 30 / 30 |
| Camera-referencing columns with a FK to `cameras.id` | 9 / 9 |
| Rows deleted | 0 |

## How to re-verify

```bash
make sync-registry            # dry-run first with --dry-run
make cameras                  # loader refuses duplicate ids or labels
.venv/bin/python scripts/scene_fingerprint.py fixtures
```

The raw roster at the time of each sync is preserved in `api_snapshots`, with a digest and a diff
summary, so this table can be regenerated and audited later.
