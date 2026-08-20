#!/usr/bin/env bash
#
# Preflight check. Run before a long build or a trip to the venue.
#
# Exists because the expensive failures on this project have all been environmental: a basemap
# build that runs out of disk after 40 minutes, an ffmpeg that cannot seek, a Docker daemon that is
# not running. Every one of them is cheap to detect up front and painful to discover halfway.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PASS=0; WARN=0; FAIL=0
ok()   { printf '  \033[32m✓\033[0m %-26s %s\n' "$1" "${2:-}"; PASS=$((PASS+1)); }
warn() { printf '  \033[33m!\033[0m %-26s %s\n' "$1" "${2:-}"; WARN=$((WARN+1)); }
bad()  { printf '  \033[31m✗\033[0m %-26s %s\n' "$1" "${2:-}"; FAIL=$((FAIL+1)); }

need_bin() {
  local bin=$1 label=${2:-$1} hint=${3:-}
  if command -v "$bin" >/dev/null; then ok "$label" "$(command -v "$bin")"
  else bad "$label" "not found${hint:+ — $hint}"; fi
}

echo "DrishtiNet doctor"
echo
echo "toolchain"
need_bin node
need_bin pnpm
need_bin python3
need_bin ffmpeg
need_bin ffprobe
need_bin docker
need_bin java "java (Planetiler)"
if [[ -x .venv/bin/python ]]; then ok "python venv" ".venv/"; else bad "python venv" "run: make setup"; fi

echo
echo "services"
if docker info >/dev/null 2>&1; then ok "docker daemon" "running"
else bad "docker daemon" "start Docker Desktop"; fi
if docker ps --format '{{.Names}}' 2>/dev/null | grep -q drishti-postgres; then
  ok "postgres" "drishti-postgres up"
else warn "postgres" "not running — make infra"; fi

echo
echo "workspace containment"
for d in .venv node_modules .cache data models; do
  [[ -e $d ]] && ok "$d" "in repo" || warn "$d" "missing (created on demand)"
done
if [[ -f .env ]]; then ok ".env" "present"; else warn ".env" "run: make env"; fi

echo
echo "disk"
AVAIL_GB=$(df -g . | awk 'NR==2{print $4}')
if   (( AVAIL_GB >= 25 )); then ok   "free space" "${AVAIL_GB} GB"
elif (( AVAIL_GB >= 10 )); then warn "free space" "${AVAIL_GB} GB — tight for a basemap build (needs ~8 GB headroom)"
else                            bad  "free space" "${AVAIL_GB} GB — too low; run make clean-data"; fi

echo
echo "captured footage"
if [[ -d data/mirror ]]; then
  CLIPS=$(find data/mirror -maxdepth 1 -name '*.mp4' | wc -l | tr -d ' ')
  SIZE=$(du -sh data/mirror 2>/dev/null | cut -f1 | tr -d ' ')
  ok "mirror" "${CLIPS} clips, ${SIZE} (verify with: make verify-mirror)"
else warn "mirror" "no footage captured yet"; fi

echo
echo "offline assets (demo day has no network)"
[[ -f apps/web/public/map/gujarat-districts.geojson ]] \
  && ok "district basemap" "$(du -h apps/web/public/map/gujarat-districts.geojson | cut -f1 | tr -d ' ')" \
  || bad "district basemap" "run: make basemap"
if compgen -G "apps/web/public/map/*.pmtiles" >/dev/null; then
  ok "pmtiles roads" "$(du -ch apps/web/public/map/*.pmtiles 2>/dev/null | tail -1 | cut -f1)"
else warn "pmtiles roads" "not built — run: make pmtiles"; fi
[[ -f apps/web/public/maplibre/maplibre-gl-csp-worker.js ]] \
  && ok "maplibre worker" "copied" \
  || warn "maplibre worker" "regenerated on next build"

echo
printf 'passed %d   warnings %d   failures %d\n' "$PASS" "$WARN" "$FAIL"
(( FAIL == 0 )) || { echo "resolve the failures above before continuing."; exit 1; }
