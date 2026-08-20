#!/usr/bin/env python3
"""
Sync config/cameras.yaml against the Sentinel portal's live camera list.

The portal's roster is not stable. As of 2026-08-20 it publishes 31 cameras while the FAQ says
"~50", and the display labels show the original deployment was larger still (label numbers 21, 22,
24-27, 29, 31, 32 are absent). Cameras will appear and disappear before the finale.

Three rules this script enforces:

  1. **portal_id is the only key.** The number embedded in the label is NOT unique — portal_id 17
     is labelled "17 Rajkot Bus Port CCTV" and portal_id 18 is labelled "17 Rajkot CCTV". Keying on
     the label number would silently merge two different cameras.
  2. **Never delete.** A camera that vanishes from the portal is marked `status: offline` and kept,
     with the date it was last seen. Deleting it would erase the geography research attached to it
     and, in a real registry, would erase the audit trail of a decommissioned camera.
  3. **Never overwrite human knowledge.** Coordinates, districts and department research are ours;
     the portal has no such fields. Sync only touches portal-owned fields (label, codec, container,
     delivery, status) and leaves everything else alone.

Usage:
    .venv/bin/python scripts/sync_registry.py --dry-run
    .venv/bin/python scripts/sync_registry.py
"""
from __future__ import annotations

import argparse
import datetime
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

BASE = "https://live.sentinelgujarat.in"
USER_AGENT = (
    "DrishtiNet-Sentinel2026/0.1 "
    "(Gujarat Police Innovation Challenge participant; hetpatelsk@gmail.com)"
)

# Fields the portal owns. Everything else in the YAML is ours and is never touched.
PORTAL_FIELDS = ("label", "codec", "container", "delivery", "portal_status")


def fetch_roster(base: str) -> list[dict]:
    resp = requests.get(
        f"{base}/api/cameras",
        headers={"User-Agent": USER_AGENT},
        timeout=30,
    )
    resp.raise_for_status()
    cameras = resp.json().get("cameras", [])
    if not isinstance(cameras, list):
        raise ValueError("unexpected /api/cameras payload: no 'cameras' list")
    return cameras


def label_number_of(location: str) -> int | None:
    """The number embedded in the portal label, which is NOT the portal id. May be absent."""
    head = location.strip().split(" ", 1)[0]
    return int(head) if head.isdigit() else None


def safe_write(yaml: YAML, doc, path: Path, expected_count: int) -> None:
    """
    Write, then re-read and sanity-check. Restore the original on any failure.

    Learned the hard way: a wrong ruamel `indent(sequence=...)` setting silently emits a sequence
    whose items' keys sit at the wrong column, producing a file that looks plausible and no longer
    parses. The registry is the spine of the whole system, so a rewrite that corrupts it must never
    survive the function that caused it.
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
        for cam in cameras:
            if "portal_id" not in cam or "source_url" not in cam:
                raise ValueError(f"re-read produced a malformed camera row: {dict(cam)!r}")
    except Exception as exc:  # noqa: BLE001
        path.write_text(original)
        backup.unlink(missing_ok=True)
        raise RuntimeError(f"write aborted and file restored — {exc}") from exc

    backup.unlink(missing_ok=True)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true", help="report changes without writing")
    ap.add_argument("--base", default=BASE)
    ap.add_argument("--config", type=Path, default=CONFIG)
    args = ap.parse_args()

    yaml = YAML()
    yaml.preserve_quotes = True
    yaml.width = 100
    yaml.indent(mapping=2, sequence=4, offset=2)

    doc = yaml.load(args.config.read_text())
    existing = {str(c["portal_id"]): c for c in doc["cameras"]}

    try:
        roster = fetch_roster(args.base)
    except Exception as exc:  # noqa: BLE001
        print(f"could not reach the portal: {exc}", file=sys.stderr)
        print("registry left untouched.", file=sys.stderr)
        return 1

    today = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=5, minutes=30)))
    stamp = today.isoformat(timespec="seconds")

    seen: set[str] = set()
    added: list[str] = []
    changed: list[tuple[str, str, object, object]] = []
    vanished: list[str] = []

    for cam in roster:
        cid = str(cam["id"])
        seen.add(cid)
        location = str(cam.get("location") or "")

        if cid not in existing:
            added.append(cid)
            if not args.dry_run:
                row = CommentedMap()
                row["portal_id"] = cid
                row["label"] = location
                row["label_number"] = label_number_of(location)
                row["name"] = location or f"Camera {cid}"
                row["district"] = None
                row["department"] = "unassigned"
                row["department_guess"] = None
                row["source_type"] = "MP4_PROGRESSIVE"
                row["source_url"] = f"/stream/{cid}"
                row["lat"] = None
                row["lng"] = None
                # New cameras always start unlocated — we have done no geography research on them.
                row["geo_confidence"] = "geocode"
                row["cluster"] = None
                row["codec"] = cam.get("codec")
                row["container"] = cam.get("container")
                row["portal_status"] = cam.get("status")
                row["first_seen"] = stamp
                row["last_seen"] = stamp
                row["notes"] = "auto-added by sync_registry.py — needs geography review"
                doc["cameras"].append(row)
            continue

        row = existing[cid]
        updates = {
            "label": location,
            "codec": cam.get("codec"),
            "container": cam.get("container"),
            "delivery": cam.get("delivery"),
            "portal_status": cam.get("status"),
        }
        for key, new in updates.items():
            old = row.get(key)
            if old != new and new is not None:
                changed.append((cid, key, old, new))
                if not args.dry_run:
                    row[key] = new
        if not args.dry_run:
            row["last_seen"] = stamp

    for cid, row in existing.items():
        if cid in seen:
            continue
        vanished.append(cid)
        if not args.dry_run and row.get("portal_status") != "offline":
            row["portal_status"] = "offline"
            note = f"disappeared from the portal roster on {stamp}"
            row["notes"] = f"{row['notes']}; {note}" if row.get("notes") else note

    print(f"portal roster : {len(roster)} cameras")
    print(f"local registry: {len(existing)} cameras")
    print()
    print(f"added    : {len(added)}  {added if added else ''}")
    print(f"vanished : {len(vanished)}  {vanished if vanished else ''}  (marked offline, never deleted)")
    print(f"changed  : {len(changed)}")
    for cid, key, old, new in changed[:40]:
        print(f"   [{cid}] {key}: {old!r} → {new!r}")
    if len(changed) > 40:
        print(f"   … and {len(changed) - 40} more")

    if args.dry_run:
        print("\ndry run — config/cameras.yaml untouched")
        return 0

    if added or changed or vanished:
        doc.setdefault("meta", {})["camera_count"] = len(roster)
        doc["meta"]["last_synced"] = stamp
        safe_write(yaml, doc, args.config, expected_count=len(doc["cameras"]))
        print(f"\nwrote {args.config}")
        print("Review the diff: newly added cameras have no geography and will render unlocated.")
    else:
        print("\nno changes.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
