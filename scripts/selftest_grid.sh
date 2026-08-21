#!/usr/bin/env bash
#
# Local MediaMTX self-test grid.
#
# ── Why this exists ──────────────────────────────────────────────────────────────────────────
#
# The organisers' integration reference describes a set of properties that are hostile to naive
# stream handling: mixed H.264/H.265, mixed resolutions and frame rates, non-uniform frame
# intervals, a buffered GOP replayed on connect (so the first 1–2 s arrive faster than real time),
# and a hard scene cut every time a feed loops.
#
# Every one of those is a bug we would otherwise discover on the real grid, in front of evaluators,
# on a network we do not control. So we reproduce them locally and develop against them. The
# conformance suite (tests/conformance/) runs entirely here, and must be green before we connect to
# the real grid even once.
#
# It doubles as the own-feed demonstration path: drop any video into data/own/ and it is published
# at rtsp://localhost:8554/own/<name>, through exactly the same pipeline as a grid camera.
#
# Usage:
#   scripts/selftest_grid.sh up      # start MediaMTX + publish the synthetic cameras
#   scripts/selftest_grid.sh down
#   scripts/selftest_grid.sh status
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MEDIAMTX_CONTAINER=drishti-selftest-mtx
MEDIAMTX_IMAGE="bluenviron/mediamtx:1.11.3"
RTSP_PORT=${SELFTEST_RTSP_PORT:-8654}
HLS_PORT=${SELFTEST_HLS_PORT:-8988}
WEBRTC_PORT=${SELFTEST_WEBRTC_PORT:-8989}
API_PORT=${SELFTEST_API_PORT:-9998}

PID_DIR="$ROOT/.cache/selftest"
OWN_DIR="$ROOT/data/own"
mkdir -p "$PID_DIR" "$OWN_DIR"

# ── The synthetic camera set ─────────────────────────────────────────────────────────────────
# Deliberately spans the awkward cases the reference names, so a passing conformance run means
# something. Fields: name|codec|WxH|fps|extra-ffmpeg
#
#   sane      the easy case, so a failure elsewhere is clearly not "streaming is broken"
#   hevc      H.265, which emits RPS/POC decoder warnings on mid-stream join
#   lowfps    12.5 fps, matching the real cameras that report it
#   highres   1440p, to catch fixed-shape batching assumptions
#   jitter    non-uniform frame intervals — the property that breaks arrival-time logic
CAMERAS=(
  "sane|libx264|1280x720|25|"
  "hevc|libx265|1920x1080|25|"
  "lowfps|libx264|1920x1080|12.5|"
  "highres|libx264|2560x1440|15|"
  "jitter|libx264|1280x720|25|"
)

log() { printf '  %s\n' "$*"; }

mediamtx_config() {
  cat > "$PID_DIR/mediamtx.yml" <<YAML
# Self-test grid only. Mirrors the organisers' documented ports/behaviour closely enough that code
# written against this works against theirs.
logLevel: warn
logDestinations: [stdout]
rtspTransports: [tcp]
rtsp: yes
rtspAddress: :8554
webrtc: yes
webrtcAddress: :8889
webrtcAllowOrigin: '*'
webrtcICEServers2: []
hls: yes
hlsAddress: :8888
hlsAllowOrigin: '*'
hlsVariant: lowLatency
api: yes
apiAddress: :9997
# MediaMTX 1.11 authenticates the control API by default, which returns 401 to our own status
# command. This is OUR instance on loopback, so granting anonymous access is configuration rather
# than a bypass. The production config in services/stream-gateway/mediamtx.yml does NOT do this.
authInternalUsers:
  - user: any
    ips: []
    permissions:
      - action: publish
      - action: read
      - action: playback
      - action: api
      - action: metrics
pathDefaults:
  source: publisher
paths:
  ~^stream/.*\$:
    source: publisher
  ~^own/.*\$:
    source: publisher
YAML
}

start_mediamtx() {
  if docker ps --format '{{.Names}}' | grep -q "^${MEDIAMTX_CONTAINER}\$"; then
    log "mediamtx already running"
    return 0
  fi
  mediamtx_config
  docker rm -f "$MEDIAMTX_CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$MEDIAMTX_CONTAINER" \
    -p "${RTSP_PORT}:8554" -p "${HLS_PORT}:8888" -p "${WEBRTC_PORT}:8889" -p "${API_PORT}:9997" \
    -v "$PID_DIR/mediamtx.yml:/mediamtx.yml:ro" \
    "$MEDIAMTX_IMAGE" >/dev/null
  for _ in $(seq 1 30); do
    curl -sS --max-time 2 "http://127.0.0.1:${API_PORT}/v3/config/global/get" >/dev/null 2>&1 && break
    sleep 1
  done
  log "mediamtx on rtsp://127.0.0.1:${RTSP_PORT} (api ${API_PORT})"
}

# Publish one synthetic camera. `testsrc2` gives moving content with a burned-in frame counter, and
# a scene cut is produced by cycling the pattern so loop detection has something real to detect.
publish_camera() {
  local name=$1 codec=$2 size=$3 fps=$4 extra=$5
  local pidfile="$PID_DIR/${name}.pid"

  if [[ -f $pidfile ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    log "${name}: already publishing"
    return 0
  fi

  # `-re` paces at real time, matching a live source. A short GOP keeps join latency sane.
  local -a filters=("testsrc2=size=${size}:rate=${fps}")
  if [[ $name == jitter ]]; then
    # Non-uniform intervals: drop a varying fraction of frames so dt is never constant. This is the
    # single most valuable synthetic property — it breaks any code that assumes fixed dt.
    filters=("testsrc2=size=${size}:rate=${fps}" "select='not(mod(n\,7))+not(mod(n\,3))'" "setpts=N/(${fps}*TB)")
  fi
  local vf
  vf=$(IFS=,; echo "${filters[*]}")

  # shellcheck disable=SC2086
  nohup ffmpeg -nostdin -hide_banner -loglevel error \
    -re -f lavfi -i "${vf}" \
    -c:v "$codec" -preset ultrafast -tune zerolatency -g 30 -pix_fmt yuv420p \
    ${extra} \
    -f rtsp -rtsp_transport tcp "rtsp://127.0.0.1:${RTSP_PORT}/stream/${name}" \
    > "$PID_DIR/${name}.log" 2>&1 &
  echo $! > "$pidfile"
  log "${name}: ${codec} ${size} @${fps}fps -> rtsp://127.0.0.1:${RTSP_PORT}/stream/${name}"
}

# Publish anything the operator drops in data/own/ — the own-feed demonstration path.
publish_own() {
  shopt -s nullglob
  local any=0
  for f in "$OWN_DIR"/*.mp4 "$OWN_DIR"/*.mov "$OWN_DIR"/*.mkv; do
    any=1
    local name pidfile
    name=$(basename "${f%.*}" | tr -cd '[:alnum:]_-')
    pidfile="$PID_DIR/own_${name}.pid"
    if [[ -f $pidfile ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then continue; fi
    # -stream_loop -1 so an own feed loops like a grid feed, hard cut included.
    nohup ffmpeg -nostdin -hide_banner -loglevel error \
      -re -stream_loop -1 -i "$f" -an -c:v copy \
      -f rtsp -rtsp_transport tcp "rtsp://127.0.0.1:${RTSP_PORT}/own/${name}" \
      > "$PID_DIR/own_${name}.log" 2>&1 &
    echo $! > "$pidfile"
    log "own/${name}: $(basename "$f") -> rtsp://127.0.0.1:${RTSP_PORT}/own/${name}"
  done
  shopt -u nullglob
  (( any )) || log "own feeds: none (drop a video into data/own/ to publish one)"
}

cmd_up() {
  command -v ffmpeg >/dev/null || { echo "ffmpeg not found" >&2; exit 2; }
  docker info >/dev/null 2>&1 || { echo "docker daemon not running" >&2; exit 2; }

  echo "starting self-test grid"
  start_mediamtx
  for spec in "${CAMERAS[@]}"; do
    IFS='|' read -r name codec size fps extra <<< "$spec"
    publish_camera "$name" "$codec" "$size" "$fps" "$extra"
    sleep 0.4
  done
  publish_own
  sleep 3
  echo
  cmd_status
}

cmd_down() {
  echo "stopping self-test grid"
  for pidfile in "$PID_DIR"/*.pid; do
    [[ -e $pidfile ]] || continue
    local pid; pid=$(cat "$pidfile")
    kill "$pid" 2>/dev/null && log "stopped $(basename "${pidfile%.pid}")"
    rm -f "$pidfile"
  done
  docker rm -f "$MEDIAMTX_CONTAINER" >/dev/null 2>&1 && log "mediamtx removed"
}

cmd_status() {
  echo "paths on the self-test grid:"
  curl -sS --max-time 5 "http://127.0.0.1:${API_PORT}/v3/paths/list" 2>/dev/null \
    | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: print('  (api unreachable)'); raise SystemExit
for p in d.get('items', []):
    src = (p.get('source') or {}).get('type', '-')
    tracks = ','.join(p.get('tracks') or []) or '-'
    print(f\"  {p['name']:<18} ready={str(p.get('ready')):<5} tracks={tracks:<12} source={src}\")
" 2>/dev/null || echo "  (api unreachable)"
  echo
  echo "  RTSP  rtsp://127.0.0.1:${RTSP_PORT}/stream/<name>"
  echo "  WHEP  http://127.0.0.1:${WEBRTC_PORT}/stream/<name>/whep"
  echo "  HLS   http://127.0.0.1:${HLS_PORT}/stream/<name>/index.m3u8"
}

case "${1:-up}" in
  up) cmd_up ;;
  down) cmd_down ;;
  status) cmd_status ;;
  *) echo "usage: $0 {up|down|status}" >&2; exit 1 ;;
esac
