"""
The vehicle signature — what actually identifies a vehicle across cameras on this grid.

Why the signature and not the plate
-----------------------------------
Measured on the organisers' own footage, in *daylight*, at the geometry their cameras are installed
at: the median vehicle box is 164 px wide, which puts the number plate at roughly 41 px across for
ten characters. Reliable OCR needs something closer to 90 px. Zero of 27 sampled vehicles cleared
that bar. At night CLAUDE.md records the same conclusion from the other direction — plates around
50x14 px with ~6 px glyphs, detectable but not readable.

So the limit is camera distance and sensor resolution, not lighting, and no amount of model choice
fixes it. A system that reported plate numbers from this grid would be inventing them.

The signature is therefore class + colour + a 512-dimension appearance embedding, with the plate as
an opportunistic extra that is attempted only when a crop is actually large enough to carry one.
Measured separation for the embedding on real cam_10 vehicles: same vehicle median cosine 0.950,
different vehicles 0.544 — a 0.405 margin, which is what cross-camera matching runs on.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

import cv2
import numpy as np

log = logging.getLogger(__name__)

#: OSNet x0.25 trained on MSMT17, MIT licensed, exported to ONNX. Small enough (0.9 MB) to commit to
#: the offline bundle, and it needs no torchreid dependency.
EMBEDDING_MODEL = "osnet_x0_25_msmt17.onnx"
EMBEDDING_DIM = 512

#: The exported graph has a fixed batch dimension, so crops are padded up to it.
_ONNX_BATCH = 16
_INPUT_H, _INPUT_W = 256, 128

_IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
_IMAGENET_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)

#: Below this mean brightness (0-255) the scene is dark enough that hue is not trustworthy.
#: The signature records the doubt rather than asserting a colour, because "grey car" stated
#: confidently is worse than "colour uncertain" in an investigation.
LOW_LIGHT_VALUE = 60.0

#: A plate needs about this many pixels of width to hold ten legible characters. Below it, OCR
#: produces confident nonsense, which is the one output worse than no output.
MIN_PLATE_WIDTH_PX = 90.0


@dataclass
class Signature:
    cls: str
    colour: str | None
    colour_confidence: float | None
    colour_uncertain: bool
    embedding: list[float]
    embedding_model: str | None
    partial_plate: str | None


# ── colour ──────────────────────────────────────────────────────────────────────

#: Hue ranges in OpenCV's 0-179 scale. Deliberately coarse: an operator filters by "a red car",
#: not by a specific shade, and fine distinctions do not survive compression and street lighting.
_HUE_BANDS = [
    ("red", 0, 10),
    ("orange", 11, 22),
    ("yellow", 23, 33),
    ("green", 34, 85),
    ("blue", 86, 125),
    ("purple", 126, 155),
    ("red", 156, 179),
]


def estimate_colour(crop: np.ndarray) -> tuple[str | None, float, bool]:
    """
    Estimate a vehicle's colour, and say how much to trust it.

    Returns ``(colour, confidence, uncertain)``. The middle of the box is sampled rather than the
    whole of it: the edges are road, sky and the vehicle behind, and including them pulls every
    estimate toward the road's grey.
    """
    if crop is None or crop.size == 0:
        return None, 0.0, True

    h, w = crop.shape[:2]
    if h < 8 or w < 8:
        return None, 0.0, True

    # Central half, biased slightly upward to favour bodywork over shadow and wheels.
    y0, y1 = int(h * 0.20), int(h * 0.65)
    x0, x1 = int(w * 0.25), int(w * 0.75)
    body = crop[y0:y1, x0:x1]
    if body.size == 0:
        return None, 0.0, True

    hsv = cv2.cvtColor(body, cv2.COLOR_BGR2HSV)
    hue, sat, val = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    mean_val = float(val.mean())

    uncertain = mean_val < LOW_LIGHT_VALUE

    # Achromatic first: most vehicles on this grid are white, silver, grey or black, and those are
    # decided by brightness and saturation, not hue.
    weak_colour = sat < 60
    achromatic_share = float(weak_colour.mean())
    if achromatic_share > 0.6:
        if mean_val > 170:
            name = "white"
        elif mean_val > 90:
            name = "grey"
        else:
            name = "black"
        confidence = min(1.0, achromatic_share)
        return name, round(confidence, 3), uncertain or name == "black" and mean_val < 40

    # Chromatic: take the dominant hue among the saturated pixels only.
    strong = sat >= 60
    if not strong.any():
        return "grey", 0.3, True
    hist = np.bincount(hue[strong].ravel(), minlength=180)
    dominant = int(hist.argmax())
    share = float(hist[dominant] / max(1, hist.sum()))

    name = next((n for n, lo, hi in _HUE_BANDS if lo <= dominant <= hi), None)
    return name, round(min(1.0, share * 3), 3), uncertain


# ── appearance embedding ────────────────────────────────────────────────────────


class OsnetEmbedder:
    """
    OSNet appearance embeddings via ONNX Runtime.

    ONNX rather than PyTorch weights on purpose: it removes the torchreid dependency entirely, the
    file is under a megabyte, and it is MIT licensed, which the open-source-only requirement needs.
    """

    def __init__(self, model_path: str) -> None:
        import onnxruntime as ort

        self.session = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
        self.input_name = self.session.get_inputs()[0].name
        self.model_name = EMBEDDING_MODEL

    def _preprocess(self, crop: np.ndarray) -> np.ndarray:
        resized = cv2.resize(crop, (_INPUT_W, _INPUT_H)).astype(np.float32) / 255.0
        # OpenCV gives BGR; the model was trained on RGB.
        resized = resized[..., ::-1]
        normalised = (resized - _IMAGENET_MEAN) / _IMAGENET_STD
        return normalised.transpose(2, 0, 1)

    def embed(self, crops: list[np.ndarray]) -> np.ndarray:
        """Return one L2-normalised embedding per crop. Cosine similarity is then a dot product."""
        usable = [c for c in crops if c is not None and c.size > 0]
        if not usable:
            return np.zeros((0, EMBEDDING_DIM), dtype=np.float32)

        out: list[np.ndarray] = []
        for start in range(0, len(usable), _ONNX_BATCH):
            chunk = usable[start : start + _ONNX_BATCH]
            batch = np.zeros((_ONNX_BATCH, 3, _INPUT_H, _INPUT_W), dtype=np.float32)
            for i, crop in enumerate(chunk):
                batch[i] = self._preprocess(crop)
            vectors = self.session.run(None, {self.input_name: batch})[0][: len(chunk)]
            out.extend(vectors)

        matrix = np.asarray(out, dtype=np.float32)
        norms = np.linalg.norm(matrix, axis=1, keepdims=True)
        return matrix / np.clip(norms, 1e-6, None)

    def track_embedding(self, crops: list[np.ndarray]) -> np.ndarray:
        """
        One embedding for a whole track.

        The mean of the per-crop embeddings, renormalised. Averaging across several views is what
        makes the signature robust to a single bad frame — a moment of occlusion or motion blur
        moves the mean far less than it would move a single-frame embedding.
        """
        vectors = self.embed(crops)
        if len(vectors) == 0:
            return np.zeros(EMBEDDING_DIM, dtype=np.float32)
        mean = vectors.mean(axis=0)
        norm = float(np.linalg.norm(mean))
        return mean / norm if norm > 1e-6 else mean


def cosine_similarity(a, b) -> float:
    """Both sides are stored L2-normalised, so this is a dot product."""
    a = np.asarray(a, dtype=np.float32)
    b = np.asarray(b, dtype=np.float32)
    na, nb = float(np.linalg.norm(a)), float(np.linalg.norm(b))
    if na < 1e-6 or nb < 1e-6:
        return 0.0
    return float(a @ b / (na * nb))


# ── plate, opportunistically ────────────────────────────────────────────────────


def plate_is_worth_reading(crop: np.ndarray) -> bool:
    """
    Would a plate in this crop be large enough to read?

    Gate first, OCR second. Running recognition on a 40 px plate does not fail cleanly — it returns
    a confident string that is wrong, and a wrong registration number in an alert is worse than no
    alert at all.
    """
    if crop is None or crop.size == 0:
        return False
    width = crop.shape[1]
    # A plate spans roughly a quarter of a vehicle's width at these viewing angles.
    return width * 0.25 >= MIN_PLATE_WIDTH_PX


def build_signature(
    cls: str,
    crops: list[np.ndarray],
    embedder: OsnetEmbedder | None,
    *,
    read_plate=None,
) -> Signature:
    """
    Assemble one signature for a finished track.

    ``read_plate`` is injected and optional. No OCR engine is installed by default, because on this
    grid's geometry it would have nothing to read — see the module docstring for the measurement.
    The hook exists so the own-feed demonstration, where we control camera placement, can supply one.
    """
    best = max(crops, key=lambda c: c.size, default=None) if crops else None

    colour, colour_conf, uncertain = estimate_colour(best) if best is not None else (None, 0.0, True)

    if embedder is not None:
        embedding = embedder.track_embedding(crops).tolist()
        model = embedder.model_name
    else:
        embedding, model = [], None

    partial_plate = None
    if read_plate is not None and best is not None and plate_is_worth_reading(best):
        partial_plate = read_plate(best)

    return Signature(
        cls=cls,
        colour=colour,
        colour_confidence=colour_conf,
        colour_uncertain=uncertain,
        embedding=embedding,
        embedding_model=model,
        partial_plate=partial_plate,
    )
