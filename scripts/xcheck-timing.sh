#!/usr/bin/env bash
#
# Prove the Python and TypeScript live-stream timing rules still agree.
#
# The gateway (TypeScript) and the analytics service (Python) both timestamp the same frames. They
# cannot share code, so the rules exist twice — and two copies of a rule drift. A drift here would
# not crash anything: it would quietly place the same vehicle at two different times on two
# cameras, which is exactly the error cross-camera correlation cannot survive and which no
# single-language test suite can catch.
#
# Both implementations are run over identical inputs and their outputs compared exactly.
#
#   make xcheck-timing
set -uo pipefail
cd "$(dirname "$0")/.."

TS=$(cd services/stream-gateway && npx --no-install tsx ../../scripts/xcheck/timing_ts.mjs 2>/dev/null)
if [[ -z ${TS:-} ]]; then
  echo "could not run the TypeScript side — is tsx installed? (pnpm install)" >&2
  exit 1
fi

PY=$(.venv/bin/python scripts/xcheck/timing_py.py)
if [[ -z ${PY:-} ]]; then
  echo "could not run the Python side — is .venv set up? (make setup)" >&2
  exit 1
fi

python3 - "$TS" "$PY" <<'CMP'
import json, sys

ts, py = json.loads(sys.argv[1]), json.loads(sys.argv[2])
labels = {
    "backoff": "reconnect backoff (§4.5)",
    "sampler": "PTS grid sampling (§4.2-4.4)",
    "anchor":  "absolute time anchor",
    "disc":    "loop discontinuity (§4.8)",
    "benign":  "benign decoder warnings (§4.6)",
    "fatal":   "fatal stream errors",
}

ok = True
for key, label in labels.items():
    a, b = ts.get(key), py.get(key)
    same = a == b
    ok &= same
    print(f"  {'agree ' if same else 'DIFFER'}  {label}")
    if not same:
        print(f"            ts: {a}")
        print(f"            py: {b}")

print()
if ok:
    print("  The two implementations agree.")
    sys.exit(0)
print("  They have drifted. Fix whichever side changed before trusting any timestamp.")
sys.exit(1)
CMP
