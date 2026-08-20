#!/usr/bin/env python3
"""
Build the offline basemap for the GIS view.

The venue has no internet, so the map cannot fetch tiles from anywhere. Rather than ship several
gigabytes of raster tiles for Gujarat, we render a vector basemap from district boundaries: a
handful of MB, styled as a dark ops surface, which is what a control-room map actually needs.
Camera markers, health colours, uncertainty circles and route polylines are drawn on top as
GeoJSON sources.

Run once, ONLINE, to produce apps/web/public/map/gujarat-districts.geojson. That output is
committed so the demo machine never needs the network.

Source: DataMeet Census 2011 district boundaries, CC BY 4.0.

Deliberately NOT GADM (which the geohacker/india GeoJSON derives from): GADM's terms permit
academic and non-commercial use only and forbid redistribution without permission. Shipping it
inside a submission to a state police force — which may become a product — would be a licensing
problem hiding in a data file. DataMeet is CC BY 4.0: redistributable with attribution, which the
map carries.

Usage:
    python3 scripts/build_basemap.py                       # downloads if needed, then builds
    python3 scripts/build_basemap.py --input <file.geojson>
"""
from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / ".cache" / "geo"
SOURCE_BASE = "https://raw.githubusercontent.com/datameet/maps/master/Districts/Census_2011/2011_Dist"
SOURCE_EXTS = ("shp", "shx", "dbf", "prj")
SOURCE_ATTRIBUTION = (
    "District boundaries by DataMeet India community (CC BY 4.0) — "
    "https://github.com/datameet/maps"
)
OUT_PATH = ROOT / "apps" / "web" / "public" / "map" / "gujarat-districts.geojson"

STATE_NAME = "Gujarat"

# ~11 m at this latitude. District outlines at state zoom do not benefit from more, and every
# extra digit is bytes the demo laptop has to parse on every page load.
COORD_PRECISION = 4

# Douglas-Peucker tolerance in degrees. 0.001 deg is roughly 110 m — invisible at state zoom,
# and it removes the bulk of the vertices.
SIMPLIFY_TOLERANCE = 0.001


def download(base: Path) -> None:
    """Fetch the DataMeet shapefile set. A shapefile is several files; all are required."""
    base.parent.mkdir(parents=True, exist_ok=True)
    print(f"downloading DataMeet district boundaries -> {base}.*")
    for ext in SOURCE_EXTS:
        out = subprocess.run(
            ["curl", "-sSL", "--fail", "--max-time", "300",
             "-o", f"{base}.{ext}", f"{SOURCE_BASE}.{ext}"],
            capture_output=True, text=True,
        )
        if out.returncode != 0:
            sys.exit(f"download of .{ext} failed: {out.stderr[:200]}")


def read_districts(base: Path, state: str) -> list[dict]:
    """
    Read the shapefile into GeoJSON-shaped features, filtered to one state.

    pyshp rather than ogr2ogr/GDAL: it is pure Python and installs into the repo's own venv, so
    nothing lands on the system. Shapefile rings are already closed and in lon/lat (the .prj is
    WGS84), which is what MapLibre wants.
    """
    try:
        import shapefile  # pyshp
    except ImportError:
        sys.exit("pyshp missing — run: .venv/bin/pip install pyshp")

    reader = shapefile.Reader(str(base))
    fields = [f[0] for f in reader.fields[1:]]
    out = []
    for sr in reader.shapeRecords():
        rec = dict(zip(fields, sr.record))
        if str(rec.get("ST_NM", "")).strip().lower() != state.lower():
            continue
        geo = sr.shape.__geo_interface__
        if geo["type"] not in ("Polygon", "MultiPolygon"):
            continue
        out.append({
            "properties": {
                "district": str(rec.get("DISTRICT", "")).strip(),
                "state": str(rec.get("ST_NM", "")).strip(),
                "censuscode": rec.get("censuscode"),
            },
            "geometry": geo,
        })
    return out


def perpendicular_distance(pt, start, end) -> float:
    """Distance from `pt` to the segment start→end, in degrees."""
    (x, y), (x1, y1), (x2, y2) = pt, start, end
    dx, dy = x2 - x1, y2 - y1
    if dx == 0 and dy == 0:
        return math.hypot(x - x1, y - y1)
    t = max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)))
    return math.hypot(x - (x1 + t * dx), y - (y1 + t * dy))


def simplify(points: list, tolerance: float) -> list:
    """
    Iterative Douglas-Peucker.

    Iterative rather than recursive on purpose: a district ring can carry tens of thousands of
    vertices, and the recursive form hits Python's stack limit on real input.
    """
    if len(points) < 3:
        return points

    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]

    while stack:
        first, last = stack.pop()
        if last <= first + 1:
            continue
        max_dist, index = 0.0, first
        for i in range(first + 1, last):
            d = perpendicular_distance(points[i], points[first], points[last])
            if d > max_dist:
                max_dist, index = d, i
        if max_dist > tolerance:
            keep[index] = True
            stack.append((first, index))
            stack.append((index, last))

    return [p for p, k in zip(points, keep) if k]


def round_ring(ring: list) -> list:
    out = []
    for x, y in ring:
        p = (round(x, COORD_PRECISION), round(y, COORD_PRECISION))
        # Drop consecutive duplicates created by rounding.
        if not out or out[-1] != p:
            out.append(p)
    # A polygon ring must stay closed.
    if len(out) > 2 and out[0] != out[-1]:
        out.append(out[0])
    return out


def process_ring(ring: list) -> list | None:
    simplified = simplify([tuple(p[:2]) for p in ring], SIMPLIFY_TOLERANCE)
    rounded = round_ring(simplified)
    # Fewer than 4 points cannot describe a closed polygon.
    return [list(p) for p in rounded] if len(rounded) >= 4 else None


def process_geometry(geom: dict) -> dict | None:
    kind = geom.get("type")
    if kind == "Polygon":
        rings = [r for r in (process_ring(r) for r in geom["coordinates"]) if r]
        return {"type": "Polygon", "coordinates": rings} if rings else None
    if kind == "MultiPolygon":
        polys = []
        for poly in geom["coordinates"]:
            rings = [r for r in (process_ring(r) for r in poly) if r]
            if rings:
                polys.append(rings)
        return {"type": "MultiPolygon", "coordinates": polys} if polys else None
    return None


def count_points(geom: dict) -> int:
    if geom["type"] == "Polygon":
        return sum(len(r) for r in geom["coordinates"])
    return sum(len(r) for poly in geom["coordinates"] for r in poly)


def bounds_of(features: list) -> list:
    xs, ys = [], []
    for f in features:
        g = f["geometry"]
        rings = g["coordinates"] if g["type"] == "Polygon" else [r for p in g["coordinates"] for r in p]
        for ring in rings:
            for x, y in ring:
                xs.append(x)
                ys.append(y)
    return [min(xs), min(ys), max(xs), max(ys)]


def centroid_of(geom: dict) -> tuple[float, float]:
    """
    Area-weighted centroid of the largest ring.

    Deliberately the largest ring rather than all rings: Gujarat's coastal districts have many
    small offshore islands, and averaging them drags the "centre" of Kachchh into the Rann.
    """
    rings = geom["coordinates"] if geom["type"] == "Polygon" else [p[0] for p in geom["coordinates"]]
    best_ring, best_area = None, -1.0
    for ring in rings:
        area = abs(sum(
            ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]
            for i in range(len(ring) - 1)
        ) / 2)
        if area > best_area:
            best_area, best_ring = area, ring

    if not best_ring or best_area == 0:
        pts = best_ring or rings[0]
        return (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))

    cx = cy = 0.0
    for i in range(len(best_ring) - 1):
        x0, y0 = best_ring[i]
        x1, y1 = best_ring[i + 1]
        cross = x0 * y1 - x1 * y0
        cx += (x0 + x1) * cross
        cy += (y0 + y1) * cross
    signed = sum(
        best_ring[i][0] * best_ring[i + 1][1] - best_ring[i + 1][0] * best_ring[i][1]
        for i in range(len(best_ring) - 1)
    ) / 2
    return (cx / (6 * signed), cy / (6 * signed))


# Our camera districts use current names; the boundary source is 2011-era GADM. Districts created
# since (Gir Somnath, 2013) have no boundary at all, so they fall back to their parent district's
# centroid with the substitution recorded here rather than silently mislocated.
DISTRICT_ALIASES = {
    # GADM spells it "Ahmadabad"; every other source we use says "Ahmedabad".
    "Ahmedabad": ["Ahmadabad"],
    "Mehsana": ["Mahesana"],
    "Banaskantha": ["Banas Kantha"],
    "Kutch": ["Kachchh"],
    "Sabarkantha": ["Sabar Kantha"],
    "Panchmahal": ["Panch Mahals"],
    "Dahod": ["Dohad"],
    "Chhota Udaipur": ["Vadodara"],
    "Gir Somnath": ["Junagadh"],
    "Devbhoomi Dwarka": ["Jamnagar"],
    "Morbi": ["Rajkot"],
    "Botad": ["Bhavnagar"],
    "Mahisagar": ["Panch Mahals"],
    "Aravalli": ["Sabar Kantha"],
}


def write_district_centroids(features: list, out_path: Path) -> None:
    """Emit a TS module of district centroids, used to place cameras with no verified position."""
    centroids: dict[str, tuple[float, float]] = {}
    for f in features:
        name = f["properties"]["district"]
        if not name:
            continue
        lng, lat = centroid_of(f["geometry"])
        centroids[name] = (round(lat, 5), round(lng, 5))

    # Resolve current district names that the 2011 boundaries do not carry.
    for current, sources in DISTRICT_ALIASES.items():
        if current in centroids:
            continue
        for src in sources:
            if src in centroids:
                centroids[current] = centroids[src]
                break

    all_lat = sum(v[0] for v in centroids.values()) / len(centroids)
    all_lng = sum(v[1] for v in centroids.values()) / len(centroids)

    lines = [
        "// GENERATED by scripts/build_basemap.py — do not edit by hand.",
        "//",
        "// Centroids of Gujarat's district boundaries, used to place a camera whose own position is",
        "// unverified. A camera placed here is ALWAYS drawn hollow with an uncertainty circle and",
        "// labelled 'position unverified' — the centroid is an admission of ignorance, not a location.",
        "",
        "export interface Centroid {",
        "  lat: number;",
        "  lng: number;",
        "}",
        "",
        "export const DISTRICT_CENTROIDS: Record<string, Centroid> = {",
    ]
    for name in sorted(centroids):
        lat, lng = centroids[name]
        lines.append(f"  {json.dumps(name)}: {{ lat: {lat}, lng: {lng} }},")
    lines += [
        "};",
        "",
        "/** Last resort when even the district is unknown. */",
        f"export const GUJARAT_CENTROID: Centroid = {{ lat: {round(all_lat, 5)}, lng: {round(all_lng, 5)} }};",
        "",
    ]
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("\n".join(lines))
    print(f"district centroids -> {out_path} ({len(centroids)} districts)")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--input", type=Path, default=CACHE / "datameet" / "2011_Dist.shp")
    ap.add_argument("--out", type=Path, default=OUT_PATH)
    ap.add_argument("--state", default=STATE_NAME)
    args = ap.parse_args()

    shp_base = args.input.with_suffix("")
    if not Path(f"{shp_base}.shp").exists():
        download(shp_base)

    print(f"reading {shp_base}.shp")
    features = read_districts(shp_base, args.state)
    print(f"  {len(features)} districts in {args.state}")

    source_points = 0
    out_features = []
    for feature in features:
        props = feature["properties"]
        geom = feature.get("geometry")
        if not geom:
            continue
        source_points += count_points(geom)
        simplified = process_geometry(geom)
        if not simplified:
            continue
        out_features.append({
            "type": "Feature",
            "properties": {
                "district": props.get("district"),
                "state": props.get("state"),
                "censuscode": props.get("censuscode"),
            },
            "geometry": simplified,
        })

    if not out_features:
        sys.exit(f"no districts matched state {args.state!r}")

    out_features.sort(key=lambda f: f["properties"]["district"] or "")
    kept_points = sum(count_points(f["geometry"]) for f in out_features)

    collection = {
        "type": "FeatureCollection",
        "metadata": {
            "state": args.state,
            "districts": len(out_features),
            "source": f"{SOURCE_BASE}.shp",
            "licence": "CC BY 4.0",
            "attribution": SOURCE_ATTRIBUTION,
            "simplify_tolerance_deg": SIMPLIFY_TOLERANCE,
            "coordinate_precision": COORD_PRECISION,
            "note": "Built offline by scripts/build_basemap.py. Committed so the demo needs no network.",
        },
        "bbox": bounds_of(out_features),
        "features": out_features,
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    # Compact separators: this file is parsed by the browser on every map load.
    args.out.write_text(json.dumps(collection, separators=(",", ":")))

    write_district_centroids(out_features, ROOT / "apps/web/src/lib/districts.ts")

    size_mb = args.out.stat().st_size / 1e6
    print(f"\ndistricts     : {len(out_features)}")
    print(f"vertices      : {source_points:,} -> {kept_points:,} "
          f"({100 * kept_points / source_points:.1f}% kept)")
    print(f"bbox          : {[round(b, 3) for b in collection['bbox']]}")
    print(f"wrote         : {args.out} ({size_mb:.2f} MB)")
    print("\nCommit this file — the demo machine has no internet.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
