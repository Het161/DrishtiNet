#!/usr/bin/env bash
#
# Record a local sample set from the Sentinel portal feeds.
#
# Purpose is twofold:
#   1. an offline development dataset, so we can iterate on ANPR without touching the portal;
#   2. the on-site fallback — if the venue cannot reach live.sentinelgujarat.in, the FILE_LOOP
#      adapter replays these and the entire demo runs with no network at all.
#
# Deliberately sequential: one connection at a time, because the portal is shared government
# infrastructure that every competing team is also using.
#
# Usage:
#   scripts/record_samples.sh [duration_seconds] [camera_ids]
#   scripts/record_samples.sh 90              # all cameras, 90 s each
#   scripts/record_samples.sh 60 6,8,10,11    # just the Junagadh cluster
#
# Output lands in data/samples/ (gitignored). Remove with: rm -rf data/samples
set -euo pipefail

DUR=${1:-90}
ONLY=${2:-}

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GATEWAY="$ROOT/services/stream-gateway"
OUT="$ROOT/data/samples"
BASE="${SENTINEL_BASE:-https://live.sentinelgujarat.in}"
UA="DrishtiNet-Sentinel2026/0.1 (Gujarat Police Innovation Challenge participant; hetpatelsk@gmail.com)"

mkdir -p "$OUT"

if ! command -v ffmpeg >/dev/null; then echo "ffmpeg not found on PATH" >&2; exit 2; fi

# Ask the validated TypeScript loader for the roster rather than parsing YAML in bash.
# `position` is where "now" sits inside each file — recording from byte 0 would capture footage
# from the start of the 12-hour slot, not what an operator is currently watching.
ROSTER="$(cd "$GATEWAY" && pnpm -s exec tsx src/cli.ts list --tsv id,url,position)"

if [[ -n "$ONLY" ]]; then
  KEEP=",${ONLY},"
  ROSTER="$(awk -v keep="$KEEP" -F'\t' 'index(keep, "," $1 ",") > 0' <<<"$ROSTER")"
fi

TOTAL=$(wc -l <<<"$ROSTER" | tr -d ' ')
echo "Recording ${DUR}s from ${TOTAL} camera(s), sequentially. Output: $OUT"
echo

OK=0; FAILED=()
IDX=0

while IFS=$'\t' read -r id url position; do
  [[ -z "$id" ]] && continue
  IDX=$((IDX + 1))
  full="${BASE}${url}"
  clip="$OUT/cam_${id}.mp4"
  snap="$OUT/cam_${id}.jpg"

  printf '[%2d/%2d] cam %-3s seek=%-10s ' "$IDX" "$TOTAL" "$id" "${position%.*}s"

  # Stream-copy first (cheap, no quality loss). Fall back to a re-encode for the AVI sources
  # whose codec cannot be copied into MP4.
  if ffmpeg -nostdin -hide_banner -loglevel error -y \
      -user_agent "$UA" -rw_timeout 30000000 \
      -ss "$position" -i "$full" -t "$DUR" -an -c:v copy "$clip" 2>/dev/null \
    || ffmpeg -nostdin -hide_banner -loglevel error -y \
      -user_agent "$UA" -rw_timeout 30000000 \
      -ss "$position" -i "$full" -t "$DUR" -an -c:v libx264 -preset veryfast "$clip" 2>/dev/null
  then
    # One full-resolution still, for the plate-legibility assessment.
    ffmpeg -nostdin -hide_banner -loglevel error -y -i "$clip" -frames:v 1 -q:v 2 "$snap" 2>/dev/null || true
    size=$(du -h "$clip" | cut -f1 | tr -d ' ')
    info=$(ffprobe -v error -select_streams v:0 \
      -show_entries stream=width,height,r_frame_rate \
      -of csv=p=0:s=x "$clip" 2>/dev/null || echo '?')
    printf 'OK  %-8s %s\n' "$size" "$info"
    OK=$((OK + 1))
  else
    printf 'FAILED\n'
    FAILED+=("$id")
    rm -f "$clip"
  fi

  sleep 1   # be polite between cameras
done <<<"$ROSTER"

echo
echo "──────────────────────────────────────────────"
echo "recorded : $OK / $TOTAL"
if ((${#FAILED[@]})); then
  echo "failed   : ${FAILED[*]}"
fi
echo "total size: $(du -sh "$OUT" 2>/dev/null | cut -f1)"
echo "location  : $OUT  (gitignored)"
echo
echo "Next: open three snapshots at 100% zoom and judge whether number plates are legible."
echo "That single observation decides whether ANPR is the hero of the demo or the fallback"
echo "behind vehicle colour/type matching."
echo "Clean up with: rm -rf $OUT"
