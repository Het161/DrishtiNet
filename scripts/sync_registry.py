#!/usr/bin/env python3
"""
Sync the camera registry from the portal's discovery endpoint.

── The rule that matters ────────────────────────────────────────────────────────────────────────

**Reconcile by LABEL, never by portal id.**

On 2026-08-21 the portal removed the camera labelled "17 Rajkot CCTV" and shifted every id above it
down by one. Portal id 22 had been "23 Patan Dethali Char Rasta"; it became "28 BK Mervada tran
Rasta". Fourteen ids came to point at different physical cameras.

An id-keyed sync would have handled that "successfully": it would have found id 22, updated its
portal-owned fields, and carefully preserved our researched coordinates, department suggestion,
time_sync anchors and audit history — all now attached to a camera 200 km away. Nothing would have
errored. The map would simply have been wrong, and it would have stayed wrong.

Labels survived the change unaltered and are unique across the roster, so they are the identity. A
changed id is a rename, and is reported as one.

── Other rules ──────────────────────────────────────────────────────────────────────────────────

- Never delete. A camera that leaves the roster is marked offline with the date it was last seen.
- Never overwrite human knowledge. Coordinates, districts, departments and placements are ours;
  the portal has no such fields. Only portal-owned fields are touched.
- Store URLs, never construct them. The organisers are explicit that URL patterns are not the
  contract; `/api/ingest` is.
- Every fetch is snapshotted, so "when did this change?" stays answerable.

Usage:
    .venv/bin/python scripts/sync_registry.py --dry-run
    .venv/bin/python scripts/sync_registry.py
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

try:
    import requests
    from ruamel.yaml import YAML
    from ruamel.yaml.comments import CommentedMap
except ImportError:  # pragma: no cover
    sys.exit(
        "missing dependencies — run:\n"
        "  python3 -m venv .venv && .venv/bin/pip install 'ruamel.yaml>=0.18' requests"
    )

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "config" / "cameras.yaml"

BASE = os.environ.get("SENTINEL_BASE", "https://live.corp8.cloud")
INGEST_PATH = "/api/ingest"
USER_AGENT = (
    "DrishtiNet-Sentinel2026/0.1 "
    "(Gujarat Police Innovation Challenge participant; hetpatelsk@gmail.com)"
)

# Fields the portal owns. Everything else in the YAML is ours and is never touched by a sync.
PORTAL_FIELDS = (
    "codec", "container", "portal_live", "width", "height", "fps", "bitrate_kbps",
    "rtsp_url", "webrtc_url", "hls_live_url", "portal_id",
)

IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))


def now_ist() -> str:
    return datetime.datetime.now(IST).isoformat(timespec="seconds")


def fetch_ingest(base: str) -> tuple[list[dict], dict]:
    """
    GET the documented discovery endpoint.

    Deliberately follows redirects: the portal moved host on 2026-08-21 and answers the old name
    with a 301. Hardcoding either host would be the same mistake as hardcoding URL patterns.
    """
    resp = requests.get(
        f"{base.rstrip('/')}{INGEST_PATH}",
        headers={"User-Agent": USER_AGENT},
        timeout=30,
        allow_redirects=True,
    )
    resp.raise_for_status()
    payload = resp.json()
    cameras = payload.get("cameras")
    if not isinstance(cameras, list):
        raise ValueError(f"unexpected {INGEST_PATH} payload: no 'cameras' list")
    return cameras, payload


def digest_of(cameras: list[dict]) -> str:
    """Stable hash of the roster, so an unchanged sync is cheap to recognise."""
    normalised = sorted(
        ({k: c.get(k) for k in sorted(c)} for c in cameras),
        key=lambda c: str(c.get("location", "")),
    )
    return hashlib.sha256(json.dumps(normalised, sort_keys=True).encode()).hexdigest()


def label_number(label: str) -> int | None:
    """The number the original deployment gave this camera. Absent on one camera."""
    head = label.strip().split(" ", 1)[0]
    return int(head) if head.isdigit() else None


def safe_write(yaml: YAML, doc, path: Path, expected_count: int) -> None:
    """
    Write, re-read, sanity-check, and restore the original on any failure.

    The registry is the spine of the system; a rewrite that corrupts it must never survive the
    function that caused it. A wrong ruamel indent setting once produced a file that looked
    plausible and no longer parsed.
    """
    original = path.read_text()
    backup = path.with_suffix(path.suffix + ".bak")
    backup.write_text(original)
    try:
        with path.open("w") as fh:
            yaml.dump(doc, fh)
        reloaded = yaml.load(path.read_text())
        cameras = reloaded.get("cameras")
        if not isinstance(cameras, list):
            raise ValueError("re-read produced no 'cameras' list")
        if len(cameras) != expected_count:
            raise ValueError(f"re-read has {len(cameras)} cameras, expected {expected_count}")
        labels = [c.get("label") for c in cameras]
        if len(set(labels)) != len(labels):
            raise ValueError("re-read contains duplicate labels — the identity key is broken")
        for cam in cameras:
            if "portal_id" not in cam or "label" not in cam:
                raise ValueError(f"malformed camera row: {dict(cam)!r}")
    except Exception as exc:  # noqa: BLE001
        path.write_text(original)
        backup.unlink(missing_ok=True)
        raise RuntimeError(f"write aborted and file restored — {exc}") from exc
    backup.unlink(missing_ok=True)


def record_snapshot(payload: dict, cameras: list[dict], summary: str) -> None:
    """Persist the raw roster so roster churn stays auditable. Best-effort; never blocks a sync."""
    script = f"""
import {{ prisma }} from './src/index.js';
const payload = {json.dumps(payload)};
const cameras = payload.cameras ?? [];
await prisma.apiSnapshot.create({{
  data: {{
    endpoint: {json.dumps(INGEST_PATH)},
    cameraCount: cameras.length,
    digest: {json.dumps(digest_of(cameras))},
    payload,
    diffSummary: {json.dumps(summary)},
  }},
}});
await prisma.$disconnect();
"""
    tmp = ROOT / "packages" / "db" / ".snapshot.mts"
    tmp.write_text(script)
    try:
        out = subprocess.run(
            ["pnpm", "exec", "tsx", ".snapshot.mts"],
            cwd=ROOT / "packages" / "db",
            capture_output=True, text=True, timeout=180,
            env={**os.environ, "DATABASE_URL": os.environ.get(
                "DATABASE_URL",
                "postgresql://drishti:drishti_dev_only@localhost:5433/drishtinet?schema=public")},
        )
        if out.returncode != 0:
            print(f"  (snapshot not recorded: {out.stderr.strip()[:160]})")
        else:
            print("  snapshot recorded to api_snapshots")
    finally:
        tmp.unlink(missing_ok=True)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true", help="report changes without writing")
    ap.add_argument("--base", default=BASE)
    ap.add_argument("--config", type=Path, default=CONFIG)
    ap.add_argument("--no-snapshot", action="store_true", help="skip recording to api_snapshots")
    args = ap.parse_args()

    yaml = YAML()
    yaml.preserve_quotes = True
    yaml.width = 100
    yaml.indent(mapping=2, sequence=4, offset=2)

    doc = yaml.load(args.config.read_text())
    local = doc["cameras"]

    try:
        roster, payload = fetch_ingest(args.base)
    except Exception as exc:  # noqa: BLE001
        print(f"could not reach {args.base}{INGEST_PATH}: {exc}", file=sys.stderr)
        print("registry left untouched.", file=sys.stderr)
        return 1

    by_label_local = {str(c.get("label")): c for c in local}
    by_label_remote = {str(c.get("location")): c for c in roster}

    dup = len(by_label_remote) != len(roster)
    if dup:
        print("REFUSING TO SYNC: the roster contains duplicate labels, so labels cannot serve as "
              "the identity key. Investigate before proceeding.", file=sys.stderr)
        return 2

    stamp = now_ist()
    renamed: list[tuple[str, str, str]] = []   # label, old id, new id
    changed: list[tuple[str, str, object, object]] = []
    added: list[str] = []
    vanished: list[str] = []

    for label, remote in by_label_remote.items():
        new_id = str(remote["id"])
        row = by_label_local.get(label)

        if row is None:
            added.append(label)
            if not args.dry_run:
                fresh = CommentedMap()
                fresh["portal_id"] = new_id
                fresh["label"] = label
                fresh["label_number"] = label_number(label)
                fresh["name"] = label
                fresh["district"] = None
                fresh["department"] = "unassigned"
                fresh["department_guess"] = None
                fresh["source_type"] = "RTSP"
                fresh["source_url"] = f"/stream/{new_id}"
                fresh["rtsp_url"] = remote.get("rtsp_url")
                fresh["webrtc_url"] = remote.get("webrtc_url")
                fresh["hls_live_url"] = remote.get("hls_live_url")
                fresh["lat"] = None
                fresh["lng"] = None
                fresh["location_status"] = "unverified"
                fresh["location_uncertainty_m"] = 15000
                fresh["location_basis"] = "no position — shown at district centroid"
                fresh["cluster"] = None
                fresh["status"] = "online"
                fresh["status_source"] = "portal_claim"
                fresh["first_seen"] = stamp
                fresh["last_seen"] = stamp
                fresh["notes"] = "auto-added by sync_registry.py — needs geography review"
                doc["cameras"].append(fresh)
            continue

        old_id = str(row.get("portal_id"))
        if old_id != new_id:
            renamed.append((label, old_id, new_id))

        updates = {
            "portal_id": new_id,
            "codec": remote.get("codec") or None,
            "portal_live": remote.get("live"),
            "width": remote.get("width") or None,
            "height": remote.get("height") or None,
            "fps": remote.get("fps") or None,
            "bitrate_kbps": remote.get("bitrate_kbps") or None,
            "rtsp_url": remote.get("rtsp_url"),
            "webrtc_url": remote.get("webrtc_url"),
            "hls_live_url": remote.get("hls_live_url"),
        }
        for key, new in updates.items():
            if new is None:
                continue
            if row.get(key) != new:
                changed.append((label, key, row.get(key), new))
                if not args.dry_run:
                    row[key] = new
        if not args.dry_run:
            # The live source is now RTSP; progressive is a disabled fallback.
            row["source_type"] = "RTSP"
            row["source_url"] = f"/stream/{new_id}"
            row["last_seen"] = stamp

    for label, row in by_label_local.items():
        if label in by_label_remote:
            continue
        vanished.append(label)
        if not args.dry_run and row.get("portal_live") is not False:
            row["portal_live"] = False
            row["status"] = "offline"
            row["status_source"] = "measured"
            row["last_error"] = f"absent from {INGEST_PATH} since {stamp}"

            # RELEASE THE ID. Portal ids are positional and get reused: when "17 Rajkot CCTV" left,
            # the id it had held (18) was immediately reassigned to a different camera. Keeping the
            # stale id here produces two rows claiming id 18 — and whichever one a lookup finds
            # first wins, silently. The label remains this camera's identity; the id is recorded as
            # historical fact only.
            if row.get("portal_id") is not None:
                row["last_portal_id"] = str(row["portal_id"])
                row["portal_id"] = None

            note = f"left the portal roster on {stamp}; portal_id released (was {row.get('last_portal_id')})"
            existing = str(row.get("notes") or "")
            # Do not accumulate a fresh departure note on every sync of an already-departed camera.
            if "left the portal roster" not in existing:
                row["notes"] = f"{existing}; {note}" if existing else note

    # ── report ──────────────────────────────────────────────────────────────
    print(f"endpoint : {args.base}{INGEST_PATH}")
    print(f"roster   : {len(roster)} cameras     local: {len(local)}")
    print()
    print(f"added    : {len(added)}  {added if added else ''}")
    print(f"vanished : {len(vanished)}  {vanished if vanished else ''}  (marked offline, never deleted)")
    print(f"renamed  : {len(renamed)} camera(s) changed portal id")
    for label, old, new in renamed[:40]:
        print(f"   {old:>3} -> {new:<3}  {label[:56]}")
    if renamed:
        print()
        print("   NOTE: portal ids are positional and have shifted before. These are the SAME")
        print("   physical cameras under new ids, matched by label. Nothing was repointed.")
    print(f"changed  : {len(changed)} field(s)")
    for label, key, old, new in changed[:25]:
        print(f"   {label[:34]:<36} {key}: {old!r} -> {new!r}")
    if len(changed) > 25:
        print(f"   … and {len(changed) - 25} more")

    summary = (f"added={len(added)} vanished={len(vanished)} renamed={len(renamed)} "
               f"changed={len(changed)}")

    if args.dry_run:
        print("\ndry run — nothing written")
        return 0

    if added or changed or vanished or renamed:
        doc.setdefault("meta", {})["camera_count"] = len(roster)
        doc["meta"]["last_synced"] = stamp
        doc["meta"]["source"] = args.base
        doc["meta"]["discovery_endpoint"] = INGEST_PATH
        safe_write(yaml, doc, args.config, expected_count=len(doc["cameras"]))
        print(f"\nwrote {args.config}")
    else:
        print("\nno changes.")

    if not args.no_snapshot:
        record_snapshot(payload, roster, summary)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
