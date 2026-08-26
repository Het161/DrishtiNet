"""
Publishing to the event bus.

Redis Streams, chosen over Kafka or NATS for one reason that matters more than throughput here: the
whole system has to come up with ``docker compose up`` on a single laptop with no internet, and
Redis is already in that compose file for other reasons. Kafka would add a broker, a coordinator and
several hundred megabytes to an offline bundle, to move a few hundred events a second.

What is published
-----------------
A finished vehicle signature, at the moment it is written. Not every detection — a detection is not
yet an identity, and publishing 11,000 of them per camera-minute would make the bus the bottleneck
for no gain. The signature is the unit the watchlist matches against.

Latency
-------
``detected_at_ms`` travels with the event so the alerts service can measure the whole path
detection → alert → render against the 500 ms budget, rather than measuring only its own half of it.
A budget nobody measures end to end is a wish.
"""

from __future__ import annotations

import json
import logging
import os
import time

log = logging.getLogger(__name__)

#: Must stay identical to STREAM_KEYS.signatures in packages/shared/src/events.ts, which is the
#: canonical contract both sides validate against. A stream name invented here instead would
#: publish into a channel nothing consumes, and nothing would fail — the alerts would simply never
#: arrive, which is the hardest kind of bug to notice.
SIGNATURE_STREAM = "drishti:signatures"

#: Bounded so a long unattended run cannot fill the disk. The stream is a transport, not a store —
#: everything on it is already in Postgres, which is what forensic search reads.
STREAM_MAXLEN = 10_000


class EventBus:
    """
    A thin publisher.

    Deliberately fails soft: if Redis is unavailable the pipeline keeps indexing and only alerting
    stops. Losing live alerts is bad, but losing the index would also lose the forensic record, and
    the record is the thing that cannot be reconstructed later.
    """

    def __init__(self, url: str | None = None) -> None:
        self.url = url or os.environ.get("REDIS_URL", "redis://localhost:6379")
        self._client = None
        self._warned = False

    def _connect(self):
        if self._client is None:
            import redis

            self._client = redis.Redis.from_url(self.url, socket_connect_timeout=2)
        return self._client

    def publish_signature(
        self,
        *,
        camera_id: str,
        camera_label: str,
        track_id: str,
        signature,
        recorded_at_ms: float,
        detected_at_ms: float,
    ) -> bool:
        """Publish one finished signature. Returns whether it reached the bus."""
        payload = {
            # Field names mirror the SignatureEvent Zod schema in the shared package; the consumer
            # validates against it and will reject anything shaped differently.
            "type": "signature.created",
            "event_id": f"{track_id}:{int(detected_at_ms)}",
            "track_id": track_id,
            "camera_id": camera_id,
            "camera_label": camera_label,
            "cls": signature.cls,
            "colour": signature.colour or "",
            "colour_confidence": signature.colour_confidence or 0.0,
            "colour_uncertain": int(bool(signature.colour_uncertain)),
            "partial_plate": signature.partial_plate or "",
            "embedding": json.dumps([round(float(v), 5) for v in signature.embedding]),
            "embedding_model": signature.embedding_model or "",
            "recorded_at_ms": recorded_at_ms,
            # Wall-clock at which this became known, for the end-to-end latency measurement.
            "detected_at_ms": detected_at_ms,
        }
        try:
            self._connect().xadd(SIGNATURE_STREAM, payload, maxlen=STREAM_MAXLEN, approximate=True)
            return True
        except Exception as err:  # redis down, wrong URL, network gone
            if not self._warned:
                log.warning(
                    "event bus unavailable (%s) — indexing continues, live alerting is off. "
                    "The forensic record is unaffected.", err,
                )
                self._warned = True
            self._client = None
            return False


def now_ms() -> float:
    return time.time() * 1000.0
