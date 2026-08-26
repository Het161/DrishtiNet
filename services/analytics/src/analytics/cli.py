"""
Run the pipeline over one camera.

    python -m analytics.cli index --fixture data/fixtures/cam_10_daylight.mp4 --label "10 char-chowk-road-2-junagadh" --seconds 60
    python -m analytics.cli index --camera 10 --seconds 60

A fixture is offline development material and is labelled as such in everything it writes, so a
row produced from one can never be mistaken for a row produced from the live grid.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import time
from pathlib import Path

from . import db as dbmod
from .bus import EventBus, now_ms
from .pipeline import VEHICLE_CLASSES, Detector, run
from .slot import DriftModel, fixture_recorded_at_ms
from .signature import EMBEDDING_MODEL, OsnetEmbedder, build_signature
from .source import FrameSource

log = logging.getLogger("analytics")

REPO_ROOT = Path(__file__).resolve().parents[4]


def _load_repo_env() -> None:
    """
    Load the repository-root .env.

    One .env at the root is shared by the web app, Prisma, the gateway and this service. Values
    already in the environment win, which is what containers rely on.
    """
    env_path = REPO_ROOT / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def _resolve_weights(configured: str) -> str | None:
    """
    Turn the configured detector into a real path under ``./models/``.

    ``ANALYTICS_DETECTOR_MODEL`` may name a model (``yolo11n``) or give a path
    (``models/yolov8n.pt``). A bare name must still resolve to a local file: Ultralytics would
    happily download it on first use, into ``$HOME`` and over a network the venue does not have.
    Both are unacceptable, so a name that is not already on disk is an error, not a fetch.
    """
    candidate = Path(configured)
    if candidate.suffix and candidate.exists():
        return str(candidate)

    stem = candidate.stem or configured
    for path in (REPO_ROOT / "models" / f"{stem}.pt", Path("models") / f"{stem}.pt"):
        if path.exists():
            return str(path)

    # Fall back to whatever detector we do have, rather than failing a demo over a name.
    for path in sorted((REPO_ROOT / "models").glob("*.pt")):
        log.warning("configured detector %r is not present; using %s", configured, path.name)
        return str(path)
    return None


def _load_embedder():
    """
    Load the appearance embedder, or run without one.

    A missing re-ID model degrades the system to per-camera tracking rather than stopping it: the
    index, alerts and search all still work, only cross-camera matching is lost. That is worth
    saying out loud at start-up instead of failing, because the alternative on demo day is a service
    that will not boot over a file that is not on the critical path.
    """
    path = REPO_ROOT / "models" / EMBEDDING_MODEL
    if not path.exists():
        log.warning(
            "re-ID model %s not found — running without cross-camera matching. "
            "Fetch it with `make analytics-deps`.", EMBEDDING_MODEL,
        )
        return None
    return OsnetEmbedder(str(path))


def _device() -> str:
    requested = os.environ.get("ANALYTICS_DEVICE", "auto")
    if requested != "auto":
        return requested
    try:
        import torch

        if torch.backends.mps.is_available():
            return "mps"
        if torch.cuda.is_available():
            return "cuda"
    except Exception:  # pragma: no cover - torch absent or misbuilt
        pass
    return "cpu"


def cmd_index(args: argparse.Namespace) -> int:
    _load_repo_env()

    weights = _resolve_weights(os.environ.get("ANALYTICS_DETECTOR_MODEL", "yolov8n"))
    if weights is None:
        configured = os.environ.get("ANALYTICS_DETECTOR_MODEL", "yolov8n")
        print(
            f"detector weights for {configured!r} not found under ./models/.\n"
            f"Run `make analytics-deps` to fetch them. Weights are never downloaded at run time: "
            f"the venue has no network, so anything not already in ./models/ will not exist there.",
            file=sys.stderr,
        )
        return 2

    sample_fps = float(os.environ.get("ANALYTICS_SAMPLE_FPS", "5"))

    if args.fixture:
        url, is_live = args.fixture, False
        if not Path(url).exists():
            print(f"fixture not found: {url}", file=sys.stderr)
            return 2
    else:
        # Live cameras are read from OUR MediaMTX, never from the organisers' host directly.
        rtsp_host = os.environ.get("MEDIAMTX_RTSP_HOST", "127.0.0.1")
        rtsp_port = os.environ.get("MEDIAMTX_RTSP_PORT", "8554")
        url, is_live = f"rtsp://{rtsp_host}:{rtsp_port}/cam/{args.camera}", True

    with dbmod.connect() as conn:
        camera_id = dbmod.resolve_camera_id(
            conn, label=args.label, portal_id=None if args.label else args.camera
        )
        writer = dbmod.IndexWriter(conn, camera_id)

        detector = Detector(
            weights,
            device=_device(),
            imgsz=args.imgsz,
            confidence=args.confidence,
        )
        embedder = _load_embedder()
        bus = EventBus()
        source = FrameSource(url, sample_fps=sample_fps, is_live=is_live,
                             max_reconnects=0 if not is_live else None)

        drift = DriftModel.global_default()
        started = time.time()
        deadline = started + args.seconds if args.seconds else None

        def recorded_at_for(frame):
            # A fixture is a recording of a slot, so its PTS is the slot position directly.
            # A live stream needs the anchor, which is why the two paths are kept apart.
            if not is_live:
                return fixture_recorded_at_ms(frame.pts_ms, drift)
            from .slot import recorded_at_ms, slot_position_seconds

            absolute = frame.absolute_ms
            if absolute is None:
                return fixture_recorded_at_ms(frame.pts_ms, drift)
            return recorded_at_ms(slot_position_seconds(absolute), drift)

        def frames():
            for frame in source.frames():
                if deadline and time.time() > deadline:
                    return
                yield frame

        def on_discontinuity(frame):
            log.info("scene discontinuity at pts=%.0f ms — resetting tracker state", frame.pts_ms)
            writer.record_event(
                "camera.loop",
                {"pts_ms": frame.pts_ms, "source": "fixture" if not is_live else "live"},
            )

        def emit_signature(track, provisional: bool):
            """Identify a vehicle and publish it. Called while in view, and again at close."""
            track_id = writer.ensure_track(track)
            signature = build_signature(track.cls, track.crops, embedder)
            writer.write_signature(track_id, signature)
            bus.publish_signature(
                camera_id=camera_id,
                camera_label=args.label or str(args.camera),
                track_id=track_id,
                signature=signature,
                recorded_at_ms=track.last_recorded_at_ms,
                detected_at_ms=now_ms(),
            )

        def on_signature_ready(tracks):
            for track in tracks:
                emit_signature(track, provisional=True)

        def on_track_closed(tracks):
            writer.close_tracks(tracks)
            # The closing signature is built from every view collected, so it supersedes whatever
            # was published provisionally. A track without a signature is invisible to cross-camera
            # matching, so the two must not drift apart.
            for track in tracks:
                if track.cls not in VEHICLE_CLASSES:
                    continue  # People are indexed, but no appearance gallery is built for them.
                emit_signature(track, provisional=False)

        print(f"indexing {url}")
        print(f"  camera   : {camera_id}")
        print(f"  device   : {_device()}   sample: {sample_fps} fps   imgsz: {args.imgsz}")

        stats = run(
            frames(),
            detector,
            recorded_at_for=recorded_at_for,
            on_detections=writer.stage,
            on_track_closed=on_track_closed,
            on_discontinuity=on_discontinuity,
            on_signature_ready=on_signature_ready,
        )

        elapsed = time.time() - started
        print(f"\n  frames sampled   : {stats.frames}")
        print(f"  detections       : {stats.detections}")
        print(f"  tracks closed    : {stats.tracks_closed}")
        print(f"  discontinuities  : {stats.discontinuities}")
        print(f"  rows written     : {writer.tracks_written} tracks, "
              f"{writer.detections_written} detections")
        print(f"  wall clock       : {elapsed:.1f}s "
              f"({stats.frames / elapsed:.1f} sampled fps)" if elapsed else "")
    return 0


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    parser = argparse.ArgumentParser(prog="analytics")
    sub = parser.add_subparsers(dest="command", required=True)

    idx = sub.add_parser("index", help="index one camera or fixture into the live index")
    src = idx.add_mutually_exclusive_group(required=True)
    src.add_argument("--fixture", help="path to an offline development fixture")
    src.add_argument("--camera", help="portal id of a live camera, read via our MediaMTX")
    idx.add_argument("--label", help="camera label — the identity; preferred over --camera")
    idx.add_argument("--seconds", type=float, default=0, help="stop after N seconds (0 = run on)")
    idx.add_argument("--imgsz", type=int, default=640)
    idx.add_argument("--confidence", type=float, default=0.35)
    idx.set_defaults(func=cmd_index)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
