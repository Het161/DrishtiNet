# Basemap data: sources, licences, and how to rebuild

The demo runs with no internet, so every map asset is generated once while online and committed.
This document records what those assets are, where they came from, and under what terms — which
matters more than usual here, because the submission goes to a state police force and could become
a product.

## What ships

| Asset | Size | Source | Licence |
|---|---|---|---|
| `apps/web/public/map/gujarat-districts.geojson` | 310 KB | DataMeet Census 2011 district boundaries | **CC BY 4.0** |
| `apps/web/public/map/gujarat-z10.pmtiles` | 6.0 MB | Protomaps planet build (OpenStreetMap) | **ODbL** (data), tiles © Protomaps |
| `apps/web/public/map/junagadh-detail.pmtiles` | 1.1 MB | as above | as above |
| `apps/web/public/map/corridor-detail.pmtiles` | 4.5 MB | as above | as above |
| `apps/web/src/lib/districts.ts` | — | derived from the DataMeet boundaries | CC BY 4.0 |

**Total ~12 MB**, against a 120 MB budget.

## Attribution shown on the map

Both licences require attribution, and both appear in the map's attribution control:

- `Districts © DataMeet (CC BY 4.0)` — set as `customAttribution` in `RegistryMap.tsx`
- `© OpenStreetMap contributors (ODbL) · tiles © Protomaps` — carried in the PMTiles metadata and
  surfaced automatically by MapLibre

Do not remove either. Do not collapse them into a generic "map data" credit.

## Why not GADM

The first version of this basemap used the `geohacker/india` district GeoJSON, which is
GADM-derived. **GADM's terms permit academic and other non-commercial use only, and prohibit
redistribution without prior permission.** Committing it into this repository would have been
redistribution, inside a submission that may become a commercial product — a licensing problem
hidden in a data file that nobody would think to check.

DataMeet publishes Census 2011 district boundaries under CC BY 4.0: redistributable with
attribution. It also has 26 Gujarat districts to GADM's 25, and uses the same `Ahmadabad` spelling,
so the alias table in `scripts/build_basemap.py` did not change.

It ships as a shapefile rather than GeoJSON, which is why the build reads it with **pyshp** — pure
Python, installed into the repo's own `.venv`, so no system GDAL is required.

## Why not OSM admin relations for the districts

The PMTiles archives already contain an OSM `boundaries` layer, and using it would have meant one
source and one licence. It is used for the dashed administrative lines. But the district
*polygons* are also needed for **centroids** — where a camera with no verified position is placed —
and for the district names the registry groups by. OSM's `admin_level=5` coverage for Indian
districts is uneven, and a missing relation would silently drop a district from the gap analysis.
The Census-derived set is complete and stable, which is what a registry needs.

## Why `pmtiles extract` rather than Planetiler

The obvious route — download an OSM extract and run Planetiler — was rejected after measurement:

- **Geofabrik publishes no Gujarat sub-region.** The India page lists only `india-latest.osm.pbf`,
  and the `gujarat-latest.osm.pbf` URL 302-redirects to an HTML page. Verified 2026-08-21.
- `india-latest.osm.pbf` is **1,625 MB**, and Planetiler's node-location cache on a file that size
  can exceed the free disk on the demo laptop (~12 GB at the time of writing).

`pmtiles extract` instead pulls only the tiles inside our bounding boxes out of a hosted planet
archive over HTTP range requests. Measured cost for all three archives: **~12 MB transferred, about
15 seconds**, versus a multi-gigabyte download and an hour of tile building.

## Rebuilding

```bash
make basemap    # district boundaries + centroids (DataMeet -> GeoJSON, needs internet)
make pmtiles    # roads/labels archives (Protomaps -> PMTiles, needs internet)
make doctor     # confirms every offline asset is present before you travel
```

`scripts/build_pmtiles.sh` resolves the newest planet build from
`https://build-metadata.protomaps.dev/builds.json` rather than hardcoding a date. It dry-runs each
extract first and aborts if the total exceeds `BUDGET_MB` (default 120).

Bounding boxes, and why:

| Archive | bbox | Zooms | Covers |
|---|---|---|---|
| `gujarat-z10` | `68.10,20.05,74.50,24.75` | 0–10 | statewide context |
| `junagadh-detail` | `70.35,21.42,70.60,21.62` | 11–15 | cameras 6, 8, 10, 11 — primary route demo |
| `corridor-detail` | `72.50,23.02,72.68,23.22` | 11–15 | cameras 1, 3, 5, 16, 12 — Visat–Adalaj corridor |

## The overzoom trap (do not undo this)

A MapLibre vector source does **not** stop drawing past its `maxzoom` — it overzooms the last
available tile indefinitely. Left alone, the statewide z0–10 archive keeps painting roads and place
labels at z14 *underneath* the detail archives, giving doubled road casings and duplicated labels at
exactly the zoom the demo runs at.

`apps/web/src/lib/map-style.ts` prevents this with **layer-level** zoom ranges, not source-level:

- statewide layers: `maxzoom = DETAIL_MIN_ZOOM` (11)
- detail layers: `minzoom = DETAIL_MIN_ZOOM` (11)

MapLibre treats layer `maxzoom` as exclusive and `minzoom` as inclusive, so they meet exactly with
neither gap nor overlap. Place labels are drawn from the **statewide archive only** at all zooms,
because MapLibre's collision detection does not deduplicate across sources — two archives both
offering "Junagadh" would render it twice, slightly offset.

Verified at z13 over Junagadh: active basemap layers were `junagadh:*` and `corridor:*` plus
`statewide:places` only, with no `statewide:roads-*`.

## Serving

PMTiles requires HTTP range requests. Next.js serves `public/` with `Accept-Ranges: bytes` and
returns `206 Partial Content`, so no custom route is needed — confirmed against the production
build.

The `pmtiles://` protocol is registered once per page in `RegistryMap.tsx`. If the archives are
missing, `hasPmtilesArchives()` detects it **server-side** and the style falls back to district
outlines. That fallback is the state the app already shipped in, so a missing basemap degrades
rather than regressing — and it is checked on the server because MapLibre reports a missing vector
source as a non-fatal error and simply renders nothing, which on a projector looks identical to a
working map over empty terrain.

## Fonts and glyphs

The style deliberately declares **no `glyphs` and no `sprite` URL**. Place labels use the browser's
own font stack, so nothing is fetched from a glyph server the venue cannot reach. If a future
change adds a text layer needing a glyph range, self-host the PBFs under `public/map/glyphs/` and
record it here.
