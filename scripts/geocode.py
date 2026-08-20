#!/usr/bin/env python3
"""
Resolve camera positions flagged `geo_confidence: geocode` via OpenStreetMap Nominatim.

RUN THIS MANUALLY, ONLINE, AND ONLY WHEN YOU MEAN TO. It is never invoked at runtime: the demo
machine is assumed to have no internet, and a map that silently phones home mid-demo is exactly
the failure mode we designed the whole offline stack to avoid.

Nominatim's usage policy is respected literally: one request per second maximum, a real
identifying User-Agent, and no bulk/parallel querying.

Results are written back into config/cameras.yaml **with comments preserved** (ruamel round-trip),
because that file's comments carry the reasoning about what we do and do not know.

Nothing is written unless a result clears a confidence bar — a wrong dot on a police GIS map is
worse than an honest gap, so ambiguous results are reported for a human to resolve by hand.

Usage:
    .venv/bin/python scripts/geocode.py --dry-run     # show what it would do
    .venv/bin/python scripts/geocode.py               # resolve and write back
    .venv/bin/python scripts/geocode.py --ids 2,14,15
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

try:
    import requests
    from ruamel.yaml import YAML
except ImportError:  # pragma: no cover
    sys.exit(
        "missing dependencies — run:\n"
        "  python3 -m venv .venv && .venv/bin/pip install 'ruamel.yaml>=0.18' requests"
    )

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "config" / "cameras.yaml"

NOMINATIM = "https://nominatim.openstreetmap.org/search"
USER_AGENT = (
    "DrishtiNet-Sentinel2026/0.1 "
    "(Gujarat Police Innovation Challenge participant; hetpatelsk@gmail.com)"
)

# Nominatim's policy is an absolute maximum of 1 request/second. We use 1.2 s for headroom.
RATE_LIMIT_S = 1.2

# Gujarat's bounding box, so a query for "Janpath" cannot return the Delhi one.
# viewbox order is left,top,right,bottom (lon_min, lat_max, lon_max, lat_min).
GUJARAT_VIEWBOX = "68.10,24.75,74.50,20.05"

# Nominatim `importance` below this is too speculative to place on a police GIS map.
MIN_IMPORTANCE = 0.15


def build_queries(cam: dict) -> list[str]:
    """
    Query candidates, most specific first.

    The portal labels are messy ("09 new-bypass-near-by-circle-junagadh-2"), so we strip the
    leading number, split hyphenated slugs, and always append the district and state to anchor
    the search.
    """
    name = str(cam.get("name") or "").strip()
    label = str(cam.get("label") or "").strip()
    district = cam.get("district")

    # Drop a leading label number like "09 " and turn slug hyphens into spaces.
    cleaned = label
    parts = cleaned.split(" ", 1)
    if parts and parts[0].isdigit() and len(parts) > 1:
        cleaned = parts[1]
    cleaned = cleaned.replace("-", " ").replace("_", " ").strip()
    # Trailing disambiguators like "2" add nothing to a place search.
    while cleaned and cleaned.split()[-1].isdigit():
        cleaned = cleaned.rsplit(" ", 1)[0].strip()

    candidates: list[str] = []
    for base in (name, cleaned):
        if not base:
            continue
        if district:
            candidates.append(f"{base}, {district}, Gujarat, India")
        candidates.append(f"{base}, Gujarat, India")

    seen, out = set(), []
    for q in candidates:
        if q.lower() not in seen:
            seen.add(q.lower())
            out.append(q)
    return out


def query_nominatim(session: requests.Session, q: str) -> list[dict]:
    resp = session.get(
        NOMINATIM,
        params={
            "q": q,
            "format": "jsonv2",
            "limit": 3,
            "countrycodes": "in",
            "viewbox": GUJARAT_VIEWBOX,
            "bounded": 1,
            "addressdetails": 1,
        },
        headers={"User-Agent": USER_AGENT},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()


def _norm_district(value: str | None) -> str:
    return (value or "").lower().replace(" district", "").strip()


def pick(results: list[dict], expected_district: str | None) -> tuple[dict | None, str]:
    """
    Choose a result, or refuse.

    Two independent guards, because either alone lets a wrong dot through:

      * an importance floor, and
      * a district-consistency check.

    The second is not theoretical. Querying "Janpath, Ahmedabad, Gujarat, India" returns three
    *hotels in Mehsana district* — a confidently-returned, completely wrong location. The portal's
    labels are informal junction names ("Char Rasta", "teen Rasta", "Visat P2") that OSM largely
    does not carry, so wrong-but-plausible matches are the normal case, not the edge case.
    """
    if not results:
        return None, "no results"

    best = max(results, key=lambda r: float(r.get("importance") or 0.0))
    importance = float(best.get("importance") or 0.0)

    if expected_district:
        got = _norm_district(best.get("address", {}).get("state_district"))
        want = _norm_district(expected_district)
        if got and want and got != want:
            return None, f"district mismatch: expected {expected_district}, got {best['address']['state_district']}"

    if importance < MIN_IMPORTANCE:
        return None, f"importance {importance:.5f} below {MIN_IMPORTANCE} threshold"

    return best, f"importance {importance:.3f}"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--ids", help="comma-separated portal_ids (default: every geocode-flagged row)")
    ap.add_argument("--dry-run", action="store_true", help="resolve but do not write the file")
    ap.add_argument("--config", type=Path, default=CONFIG)
    args = ap.parse_args()

    yaml = YAML()
    yaml.preserve_quotes = True
    # Keep the hand-written layout intact rather than reflowing the whole file.
    yaml.width = 100
    yaml.indent(mapping=2, sequence=4, offset=2)

    doc = yaml.load(args.config.read_text())
    cameras = doc["cameras"]

    wanted = {i.strip() for i in args.ids.split(",")} if args.ids else None
    targets = [
        c for c in cameras
        if (c.get("geo_confidence") == "geocode")
        and (wanted is None or str(c.get("portal_id")) in wanted)
    ]

    if not targets:
        print("nothing to geocode — every camera already has a position.")
        return 0

    print(f"resolving {len(targets)} camera(s) via Nominatim at 1 request / {RATE_LIMIT_S}s")
    print("(OpenStreetMap contributors, ODbL — https://osm.org/copyright)\n")

    session = requests.Session()
    resolved = unresolved = 0

    for cam in targets:
        cid = str(cam.get("portal_id"))
        label = str(cam.get("label"))
        print(f"  [{cid:>2}] {label}")

        hit = None
        why = "no query produced a confident match"
        for q in build_queries(cam):
            time.sleep(RATE_LIMIT_S)
            try:
                results = query_nominatim(session, q)
            except requests.RequestException as exc:
                print(f"        query failed ({exc}) — skipping")
                continue
            hit, why = pick(results, cam.get("district"))
            print(f"        ? {q!r} → {why}")
            if hit:
                break

        if not hit:
            print("        ✗ unresolved — leave as geocode and fix by hand if it matters\n")
            unresolved += 1
            continue

        lat, lon = round(float(hit["lat"]), 6), round(float(hit["lon"]), 6)
        display = hit.get("display_name", "")
        print(f"        ✓ {lat}, {lon}  ({display[:70]})\n")

        if not args.dry_run:
            cam["lat"] = lat
            cam["lng"] = lon
            # Nominatim gives a real place, but not a surveyed camera pole — "approx", never "high".
            cam["geo_confidence"] = "approx"
            note = f"position from OpenStreetMap Nominatim: {display[:90]}"
            cam["notes"] = f"{cam['notes']}; {note}" if cam.get("notes") else note
        resolved += 1

    print("──────────────────────────────────────────────")
    print(f"resolved   : {resolved}")
    print(f"unresolved : {unresolved}")

    if args.dry_run:
        print("\ndry run — config/cameras.yaml untouched")
        return 0

    if resolved:
        with args.config.open("w") as fh:
            yaml.dump(doc, fh)
        print(f"\nwrote {args.config} (comments preserved)")
        print("Review the diff before committing — a wrong dot on a police map is worse than a gap.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
