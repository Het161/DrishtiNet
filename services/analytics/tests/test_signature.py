"""
Vehicle signature behaviour.

The signature is what identifies a vehicle across cameras on this grid, because the plate cannot:
measured in daylight at the organisers' own camera geometry, the median vehicle box is 164 px wide,
putting a ten-character plate at roughly 41 px. Zero of 27 sampled vehicles reached the ~90 px an
OCR engine needs. These tests pin the consequences of that: colour states its own doubt, and the
plate path refuses to guess.
"""

from __future__ import annotations

import numpy as np
import pytest

from analytics.signature import (
    EMBEDDING_DIM,
    LOW_LIGHT_VALUE,
    MIN_PLATE_WIDTH_PX,
    build_signature,
    cosine_similarity,
    estimate_colour,
    plate_is_worth_reading,
)


def solid(bgr: tuple[int, int, int], size: int = 120, value_scale: float = 1.0) -> np.ndarray:
    """A crop of one colour, optionally darkened to simulate low light."""
    img = np.zeros((size, size, 3), dtype=np.uint8)
    img[:, :] = [int(c * value_scale) for c in bgr]
    return img


class TestColour:
    def test_recognises_a_saturated_colour(self) -> None:
        colour, confidence, _ = estimate_colour(solid((0, 0, 220)))  # BGR red
        assert colour == "red"
        assert confidence > 0.5

    def test_recognises_blue(self) -> None:
        colour, _, _ = estimate_colour(solid((220, 0, 0)))  # BGR blue
        assert colour == "blue"

    @pytest.mark.parametrize(
        "grey_level,expected",
        [(230, "white"), (130, "grey"), (20, "black")],
    )
    def test_achromatic_vehicles_go_by_brightness_not_hue(self, grey_level, expected) -> None:
        # Most vehicles on this grid are white, silver, grey or black, where hue means nothing.
        colour, _, _ = estimate_colour(solid((grey_level, grey_level, grey_level)))
        assert colour == expected

    def test_states_doubt_in_low_light(self) -> None:
        """
        The flag exists so the interface can say "colour uncertain" instead of asserting one.
        A confidently wrong colour in an investigation is worse than an admitted unknown.
        """
        bright = solid((0, 0, 220))
        dark = solid((0, 0, 220), value_scale=0.12)
        assert estimate_colour(bright)[2] is False
        assert estimate_colour(dark)[2] is True

    def test_low_light_threshold_is_the_documented_one(self) -> None:
        just_dark = solid((int(LOW_LIGHT_VALUE) - 20,) * 3)
        assert estimate_colour(just_dark)[2] is True

    def test_degenerate_crops_do_not_raise(self) -> None:
        # A detection at the very edge of a frame can produce a crop with no area at all.
        for crop in (None, np.zeros((0, 0, 3), np.uint8), np.zeros((3, 3, 3), np.uint8)):
            colour, confidence, uncertain = estimate_colour(crop)
            assert uncertain is True
            assert confidence == 0.0 or colour is None


class TestPlateGating:
    def test_refuses_a_crop_too_small_to_carry_a_plate(self) -> None:
        # 164 px is the measured median vehicle width on this grid.
        assert plate_is_worth_reading(np.zeros((80, 164, 3), np.uint8)) is False

    def test_accepts_a_crop_large_enough(self) -> None:
        wide = int(MIN_PLATE_WIDTH_PX * 4) + 10
        assert plate_is_worth_reading(np.zeros((200, wide, 3), np.uint8)) is True

    def test_ocr_is_not_even_called_below_the_gate(self) -> None:
        """
        Gate first, OCR second.

        Recognition on a 40 px plate does not fail cleanly — it returns a confident wrong string,
        and a wrong registration number in an alert is worse than no alert.
        """
        calls = []
        signature = build_signature(
            "car",
            [np.zeros((80, 164, 3), np.uint8)],
            embedder=None,
            read_plate=lambda crop: calls.append(crop) or "GJ01AB1234",
        )
        assert calls == []
        assert signature.partial_plate is None

    def test_a_legible_plate_is_recorded(self) -> None:
        wide = int(MIN_PLATE_WIDTH_PX * 4) + 10
        signature = build_signature(
            "car",
            [np.zeros((200, wide, 3), np.uint8)],
            embedder=None,
            read_plate=lambda crop: "GJ01AB1234",
        )
        assert signature.partial_plate == "GJ01AB1234"


class FakeEmbedder:
    """Stands in for OSNet so the assembly logic is testable without the model file."""

    model_name = "fake"

    def __init__(self, vector) -> None:
        self.vector = np.asarray(vector, dtype=np.float32)

    def track_embedding(self, crops):
        return self.vector


class TestSignatureAssembly:
    def test_runs_without_an_embedder(self) -> None:
        """
        A missing re-ID model must degrade the system, not stop it.

        Losing cross-camera matching is bad; a service that will not start on demo day because one
        non-critical file is absent is worse.
        """
        signature = build_signature("car", [solid((0, 0, 220))], embedder=None)
        assert signature.embedding == []
        assert signature.embedding_model is None
        assert signature.colour == "red"

    def test_records_which_model_produced_the_embedding(self) -> None:
        # Without this an embedding cannot be compared safely against one from another model.
        signature = build_signature(
            "car", [solid((0, 0, 220))], embedder=FakeEmbedder(np.ones(EMBEDDING_DIM))
        )
        assert signature.embedding_model == "fake"
        assert len(signature.embedding) == EMBEDDING_DIM

    def test_uses_the_largest_crop_for_colour(self) -> None:
        # A distant 20 px crop carries almost no colour information; the nearest view carries most.
        small_red = solid((0, 0, 220), size=16)
        large_blue = solid((220, 0, 0), size=200)
        signature = build_signature("car", [small_red, large_blue], embedder=None)
        assert signature.colour == "blue"


class TestCosineSimilarity:
    def test_identical_vectors_match(self) -> None:
        v = np.random.rand(EMBEDDING_DIM).astype(np.float32)
        assert cosine_similarity(v, v) == pytest.approx(1.0, abs=1e-5)

    def test_orthogonal_vectors_do_not(self) -> None:
        a = np.zeros(EMBEDDING_DIM, dtype=np.float32); a[0] = 1
        b = np.zeros(EMBEDDING_DIM, dtype=np.float32); b[1] = 1
        assert cosine_similarity(a, b) == pytest.approx(0.0, abs=1e-6)

    def test_a_zero_vector_never_matches_anything(self) -> None:
        # A track with no usable crops stores a zero embedding; it must not match every vehicle.
        zero = np.zeros(EMBEDDING_DIM, dtype=np.float32)
        other = np.ones(EMBEDDING_DIM, dtype=np.float32)
        assert cosine_similarity(zero, other) == 0.0
        assert cosine_similarity(zero, zero) == 0.0
