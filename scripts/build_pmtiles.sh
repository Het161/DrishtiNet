#!/usr/bin/env bash
#
# Build the offline roads/labels basemap as PMTiles.
#
# ── Why extraction rather than a local tile build ────────────────────────────────────────────
#
# The obvious route — download india-latest.osm.pbf and run Planetiler — is the wrong one here.
# Geofabrik publishes NO Gujarat sub-region (the India page lists only india-latest.osm.pbf, and
# the gujarat URL 302s to an HTML page), so it would mean pulling 1,625 MB and then running
# Planetiler, whose node-location cache on a file that size can easily exceed the free disk we
# have. `pmtiles extract` instead pulls only the tiles inside our bounding boxes out of a hosted
# planet archive over HTTP range requests: minutes instead of an hour, and no multi-gigabyte
# intermediate files.
#
# ── Three archives, not one ─────────────────────────────────────────────────────────────────
#
# Statewide context at low zoom, plus real detail over the two demo areas. They are kept separate
# because merging PMTiles needs tooling we would otherwise not have, and MapLibre is perfectly
# happy with three vector sources.
#
# IMPORTANT: a vector source overzooms past its maxzoom, so the statewide archive would keep
# drawing roads and labels underneath the detail archives inside the demo bboxes — double-drawn
# roads and duplicated labels. The style must set layer-level maxzoom 11 on statewide layers and
# minzoom 11 on detail layers. See apps/web/src/lib/map-style.ts.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PMTILES="$ROOT/.cache/bin/pmtiles"
OUT_DIR="$ROOT/apps/web/public/map"
BUILDS_URL="https://build-metadata.protomaps.dev/builds.json"

# Areas of interest.
GUJARAT_BBOX="68.10,20.05,74.50,24.75"
# Junagadh cluster: cameras 6, 8, 10, 11 — the primary route demo.
JUNAGADH_BBOX="70.35,21.42,70.60,21.62"
# Visat–Adalaj corridor: cameras 1, 3, 5, 16, 12 along the Sabarmati–Gandhinagar highway.
CORRIDOR_BBOX="72.50,23.02,72.68,23.22"

STATE_MAXZOOM=${STATE_MAXZOOM:-10}
DETAIL_MAXZOOM=${DETAIL_MAXZOOM:-15}
DETAIL_MINZOOM=${DETAIL_MINZOOM:-11}
BUDGET_MB=${BUDGET_MB:-120}

command -v "$PMTILES" >/dev/null 2>&1 || [[ -x $PMTILES ]] || {
  echo "pmtiles CLI missing. Fetch it into .cache/bin (see docs/basemap-data.md)." >&2; exit 2; }

mkdir -p "$OUT_DIR" "$ROOT/.cache/geo"

# Resolve the newest planet build rather than hardcoding a date that will rot.
BUILD_KEY=$(curl -sSL --max-time 60 "$BUILDS_URL" \
  | python3 -c "import json,sys; print(sorted(b['key'] for b in json.load(sys.stdin))[-1])")
SOURCE="https://build.protomaps.com/${BUILD_KEY}"
echo "source build : $BUILD_KEY"
echo "output       : $OUT_DIR"
echo

extract() {
  local name=$1 bbox=$2 minz=$3 maxz=$4
  local out="$OUT_DIR/${name}.pmtiles"

  if [[ -f $out ]]; then
    echo "  $name: already present ($(du -h "$out" | cut -f1 | tr -d ' ')) — delete to rebuild"
    return 0
  fi

  echo "  $name: z${minz}-${maxz} bbox=${bbox}"
  # Estimate first: a surprise multi-gigabyte pull on a laptop with 12 GB free is not recoverable.
  "$PMTILES" extract "$SOURCE" "$out.tmp" \
    --bbox="$bbox" --minzoom="$minz" --maxzoom="$maxz" --dry-run 2>&1 | tail -3

  "$PMTILES" extract "$SOURCE" "$out.tmp" \
    --bbox="$bbox" --minzoom="$minz" --maxzoom="$maxz" --download-threads=4
  mv "$out.tmp" "$out"
  echo "  $name: $(du -h "$out" | cut -f1 | tr -d ' ')"
}

extract "gujarat-z${STATE_MAXZOOM}" "$GUJARAT_BBOX" 0 "$STATE_MAXZOOM"
extract "junagadh-detail" "$JUNAGADH_BBOX" "$DETAIL_MINZOOM" "$DETAIL_MAXZOOM"
extract "corridor-detail" "$CORRIDOR_BBOX" "$DETAIL_MINZOOM" "$DETAIL_MAXZOOM"

echo
TOTAL_MB=$(du -cm "$OUT_DIR"/*.pmtiles 2>/dev/null | tail -1 | cut -f1)
echo "total pmtiles: ${TOTAL_MB} MB (budget ${BUDGET_MB} MB)"
if (( TOTAL_MB > BUDGET_MB )); then
  echo "OVER BUDGET — reduce STATE_MAXZOOM to 9 or narrow the detail bboxes, then rebuild." >&2
  exit 1
fi

echo
echo "Attribution required on the map: © OpenStreetMap contributors (ODbL), tiles © Protomaps."
echo "Record any change of source in docs/basemap-data.md."
