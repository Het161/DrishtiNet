#!/usr/bin/env bash
#
# Grid reachability check — run this from a different network (phone hotspot) to find out whether
# 8554/8889 are closed on the ORGANISERS' side or on YOURS.
#
# It performs exactly three checks, once each, against the documented endpoints with documented
# clients. It sends no credentials, tries no alternative paths, and retries nothing. This is the
# same thing our product does for real cameras: health monitoring.
#
#   scripts/grid-check.sh                 # uses camera 10
#   scripts/grid-check.sh 5               # a different camera
#
# Read the verdict at the bottom. It tells you in plain words what to conclude.
set -uo pipefail

CAM=${1:-10}
HOST=${SENTINEL_HOST:-live.corp8.cloud}
UA="DrishtiNet-Sentinel2026/0.1 (Gujarat Police Innovation Challenge participant; hetpatelsk@gmail.com)"
STAMP_UTC=$(date -u "+%Y-%m-%dT%H:%M:%SZ")
STAMP_IST=$(TZ=Asia/Kolkata date "+%Y-%m-%d %H:%M:%S IST")

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }

echo
bold "DrishtiNet grid reachability check"
echo "  host      : $HOST"
echo "  camera    : $CAM"
echo "  time      : $STAMP_IST  ($STAMP_UTC)"
echo "  network   : $(curl -sS --max-time 10 https://api.ipify.org 2>/dev/null || echo 'unknown (no egress?)')"
echo

RTSP_OK=0; HLS_MASTER_OK=0; HLS_MEDIA_OK=0; WHEP_OK=0; API_OK=0

# ── 0. Is the host reachable at all? ─────────────────────────────────────────
bold "0. Discovery endpoint (port 443)"
API_CODE=$(curl -sSL --max-time 20 -A "$UA" -o /dev/null -w '%{http_code}' \
  "https://${HOST}/api/ingest" 2>/dev/null || echo "000")
if [[ $API_CODE == 200 ]]; then
  API_OK=1; ok "GET /api/ingest -> 200"
  info "The host is reachable and the camera catalogue is readable."
else
  bad "GET /api/ingest -> ${API_CODE}"
  info "If this fails, nothing below is meaningful — you have no route to the host at all."
fi
echo

# ── 1. RTSP on 8554 ──────────────────────────────────────────────────────────
bold "1. RTSP (port 8554) — the inference path"
if command -v nc >/dev/null && nc -z -G 8 "$HOST" 8554 2>/dev/null; then
  ok "TCP connect to ${HOST}:8554 succeeded"
  if ffprobe -v error -rtsp_transport tcp -rw_timeout 15000000 \
       -i "rtsp://${HOST}:8554/stream/${CAM}" \
       -show_entries stream=codec_name,width,height -of default=nw=1 2>/dev/null; then
    RTSP_OK=1; ok "RTSP DESCRIBE + stream info succeeded"
  else
    bad "TCP is open but RTSP did not return stream info"
    info "The port is reachable; the stream itself did not answer."
  fi
else
  bad "TCP connect to ${HOST}:8554 failed (closed or filtered)"
  info "Either they do not expose 8554 publicly, or your network blocks it."
fi
echo

# ── 2. HLS on 443 ────────────────────────────────────────────────────────────
bold "2. HLS (port 443) — the restricted-network fallback"
MASTER=$(mktemp); MEDIA_CODE="000"
MASTER_CODE=$(curl -sSL --max-time 20 -A "$UA" -o "$MASTER" -w '%{http_code}' \
  "https://${HOST}/live/stream/${CAM}/index.m3u8" 2>/dev/null || echo "000")
if [[ $MASTER_CODE == 200 ]] && head -1 "$MASTER" | grep -q '#EXTM3U'; then
  HLS_MASTER_OK=1; ok "master playlist -> 200 (valid #EXTM3U)"
  VARIANT=$(grep -vE '^#|^$' "$MASTER" | head -1)
  info "variant: ${VARIANT:-<none>}"
  if [[ -n ${VARIANT:-} ]]; then
    MEDIA_CODE=$(curl -sSL --max-time 20 -A "$UA" -o /dev/null -w '%{http_code}' \
      "https://${HOST}/live/stream/${CAM}/${VARIANT}" 2>/dev/null || echo "000")
    if [[ $MEDIA_CODE == 200 ]]; then
      HLS_MEDIA_OK=1; ok "media playlist -> 200"
    else
      bad "media playlist -> ${MEDIA_CODE}"
      info "The master is public but the segments behind it are not."
    fi
  fi
else
  bad "master playlist -> ${MASTER_CODE}"
fi
rm -f "$MASTER"
echo

# ── 3. WHEP on 8889 ──────────────────────────────────────────────────────────
bold "3. WebRTC WHEP (port 8889) — the browser path"
if command -v nc >/dev/null && nc -z -G 8 "$HOST" 8889 2>/dev/null; then
  ok "TCP connect to ${HOST}:8889 succeeded"
  WHEP_CODE=$(curl -sS --max-time 15 -A "$UA" -o /dev/null -w '%{http_code}' \
    -X OPTIONS "http://${HOST}:8889/stream/${CAM}/whep" 2>/dev/null || echo "000")
  if [[ $WHEP_CODE =~ ^2 ]]; then WHEP_OK=1; ok "OPTIONS -> ${WHEP_CODE}"; else bad "OPTIONS -> ${WHEP_CODE}"; fi
else
  bad "TCP connect to ${HOST}:8889 failed (closed or filtered)"
fi
echo

# ── verdict ──────────────────────────────────────────────────────────────────
bold "What this means"
if (( API_OK == 0 )); then
  echo "  You have no route to ${HOST} at all. Check the hotspot has working internet,"
  echo "  then re-run. Nothing else here is meaningful until this passes."
elif (( RTSP_OK == 1 )); then
  echo "  RTSP WORKS FROM THIS NETWORK."
  echo
  echo "  This is the important result: 8554 is open on their side, and whatever blocked it"
  echo "  earlier is on the other network (home ISP, router, or firewall). Run the same check"
  echo "  from the normal network to confirm the contrast, and we build on RTSP as primary."
elif (( WHEP_OK == 1 )); then
  echo "  RTSP is blocked but WHEP (8889) works from here — an unusual combination that"
  echo "  suggests selective filtering rather than a wholesale block. Worth reporting."
else
  echo "  8554 and 8889 are BOTH unreachable from this network too."
  echo
  echo "  Two networks blocking the same two non-standard ports is unlikely to be coincidence,"
  echo "  so the most probable explanation is that the organisers do not expose those ports"
  echo "  publicly, and they are reachable only from the venue or an allow-listed network."
  echo
  if (( HLS_MASTER_OK == 1 && HLS_MEDIA_OK == 0 )); then
    echo "  That makes HLS the only documented path available to us — and its media playlist"
    echo "  returns ${MEDIA_CODE}. This is exactly the point to raise in the §5 report: the"
    echo "  documented fallback for restricted networks is itself unavailable."
  elif (( HLS_MEDIA_OK == 1 )); then
    echo "  HLS works end to end, so we have a usable path. RTSP would still be preferable"
    echo "  for inference; ask whether it can be opened."
  fi
fi
echo
echo "  Paste this whole output into the support thread — it is exactly the evidence §5 asks for."
echo
