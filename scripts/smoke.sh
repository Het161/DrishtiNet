#!/usr/bin/env bash
#
# Start the stack, check it answers, and always stop it again.
#
#   make smoke
#
# This exists because the obvious way to verify a change — start `npm run dev` in the background,
# curl it, move on — leaves servers running. The next `npm run dev` then refuses to start, and the
# person who hits that is never the one who left them behind.
#
# Everything started here is killed on the way out, including on failure, Ctrl-C, or a timeout.
set -uo pipefail
cd "$(dirname "$0")/.."

# Read the configured ports, so this checks the same places the stack actually binds.
set -a; [ -f .env ] && . ./.env; set +a
WEB_PORT=${WEB_PORT:-3000}
STREAM_GATEWAY_PORT=${STREAM_GATEWAY_PORT:-4001}
ALERTS_PORT=${ALERTS_PORT:-4002}
INTEGRATIONS_PORT=${INTEGRATIONS_PORT:-4003}

LOG=.cache/smoke.log
mkdir -p .cache

STACK_PID=""
cleanup() {
  local rc=$?
  if [[ -n $STACK_PID ]]; then
    # Kill the process group: pnpm --parallel spawns children that outlive their parent.
    kill -- "-$STACK_PID" 2>/dev/null || kill "$STACK_PID" 2>/dev/null
  fi
  # Belt and braces — anything of ours still holding a port goes too.
  for port in "$WEB_PORT" "$STREAM_GATEWAY_PORT" "$ALERTS_PORT" "$INTEGRATIONS_PORT"; do
    for pid in $(lsof -ti:"$port" -sTCP:LISTEN 2>/dev/null); do
      local cwd
      cwd=$(lsof -p "$pid" -a -d cwd -Fn 2>/dev/null | grep '^n' | sed 's/^n//')
      case "$cwd" in "$PWD"*) kill -9 "$pid" 2>/dev/null ;; esac
    done
  done
  exit $rc
}
trap cleanup EXIT INT TERM

check() {
  local name=$1 url=$2 expect=${3:-200}
  local code
  code=$(curl -s -o /dev/null --max-time 20 -w '%{http_code}' "$url" 2>/dev/null)
  code=${code:-000}
  if [[ $code == "$expect" ]]; then
    printf '  \033[32mok\033[0m    %-22s %s\n' "$name" "$code"
    return 0
  fi
  printf '  \033[31mFAIL\033[0m  %-22s %s (expected %s)\n' "$name" "$code" "$expect"
  return 1
}

echo "starting the stack…"
set -m                      # own process group, so cleanup can take the children with it
npm run dev > "$LOG" 2>&1 &
STACK_PID=$!
set +m

for _ in $(seq 1 40); do
  sleep 2
  if grep -q "Cannot start: a port" "$LOG" 2>/dev/null; then
    echo
    sed -n '/Cannot start: a port/,$p' "$LOG"
    exit 1
  fi
  curl -s -o /dev/null --max-time 3 "http://localhost:${WEB_PORT}/" && break
done

echo
failures=0
check "web /"            "http://localhost:${WEB_PORT}/"                || failures=$((failures+1))
check "web /registry"    "http://localhost:${WEB_PORT}/registry"        || failures=$((failures+1))
check "gateway /health"  "http://localhost:${STREAM_GATEWAY_PORT}/health" || failures=$((failures+1))
check "gateway /cameras" "http://localhost:${STREAM_GATEWAY_PORT}/cameras" || failures=$((failures+1))
check "alerts /health"   "http://localhost:${ALERTS_PORT}/health"       || failures=$((failures+1))
check "integrations"     "http://localhost:${INTEGRATIONS_PORT}/health" || failures=$((failures+1))

echo
if grep -qE "Unhandled error event|ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL|EADDRINUSE" "$LOG"; then
  echo "  a service reported a fatal startup error — see $LOG"
  failures=$((failures+1))
fi

if (( failures == 0 )); then
  echo "  stack healthy; stopping it again"
else
  echo "  $failures check(s) failed; log kept at $LOG"
fi
exit $(( failures > 0 ))
