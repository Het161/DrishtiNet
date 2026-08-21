#!/usr/bin/env bash
#
# Capture the demo cameras' daylight and night windows through the local range proxy.
#
# Why windows rather than whole files: the five demo cameras total 54.7 GB (camera 8 alone is
# 20.9 GB) and the laptop has ~14 GB free. Two targeted windows per camera give us everything the
# demo and the analytics index actually need for ~5 GB.
#
# Why through the proxy: `ffmpeg -ss 36000` against the portal fails — FFmpeg opens with an
# un-ranged GET that the origin answers with an empty body, and these MP4s keep `moov` at the end,
# so it cannot seek without reading the whole file. The proxy converts every upstream read into a
# retried, cached, rate-limited range request. Deep seeks work; the portal sees far less traffic.
#
# Offsets map to recorded time as recorded = 21:00 + offset (see data/probe/REPORT.md):
#   offset 36000 → 07:00  daylight  ← the only window where plates stand a chance
#   offset  3600 → 22:00  night     ← representative of a working-hours demo on the live portal
#
# Usage: scripts/capture_demo_windows.sh [camera_ids] [daylight_seconds] [night_seconds]
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

IDS=${1:-5,16,10,11,8}          # smallest/highest-value first: re-ID pair, then Junagadh cluster
DAY_SECS=${2:-2700}             # 45 min
NIGHT_SECS=${3:-1200}           # 20 min
PROXY=${RANGE_PROXY_URL:-http://127.0.0.1:4010}

if ! curl -sS --max-time 10 "$PROXY/health" >/dev/null 2>&1; then
  echo "range proxy is not running at $PROXY" >&2
  echo "start it with: cd services/stream-gateway && pnpm -s exec tsx src/range-proxy-server.ts" >&2
  exit 2
fi

echo "capture starting $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "  cameras : $IDS"
echo "  daylight: offset 36000 (recorded 07:00) for ${DAY_SECS}s"
echo "  night   : offset  3600 (recorded 22:00) for ${NIGHT_SECS}s"
echo "  proxy   : $PROXY"
echo

# Daylight first — it is the scarce, decisive footage. If the portal dies overnight we would much
# rather have daylight than night.
python3 scripts/mirror.py window --ids "$IDS" --at 36000 --duration "$DAY_SECS" \
  --tag daylight --proxy "$PROXY"

echo
python3 scripts/mirror.py window --ids "$IDS" --at 3600 --duration "$NIGHT_SECS" \
  --tag night --proxy "$PROXY"

echo
echo "capture finished $(date '+%Y-%m-%d %H:%M:%S %Z')"
du -sh data/mirror 2>/dev/null
df -h /Users/het | tail -1
