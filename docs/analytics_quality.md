# Analytics quality — what is measured, and what is not

Cited by the solution presentation and the technical annex. Its job is to make every analytics
figure in this submission traceable, and to be explicit about the ones that are weaker than they
look.

---

## The distinction this document exists to make

**There is no hand-labelled ground-truth set in this repository.** `data/labels/` does not exist.

That has a consequence worth stating before any number appears: nothing here is an *accuracy*. We
have not sat down with the organisers' footage and recorded, frame by frame, which vehicle is which
and what colour it really is. So this document reports two different kinds of figure, and never
lets one borrow the other's authority:

| Kind | What it means | Trustworthy for |
|---|---|---|
| **Geometric** | A measurement of pixels, distances or timings. Independent of any model being right. | Hard limits — what the cameras physically cannot deliver |
| **Distributional** | The spread of values the system produced, using its own output as the reference | Whether a threshold separates two populations. **Not** whether it labelled them correctly |

A distributional figure can look excellent while being wrong in the same direction throughout. Where
one is quoted, it is quoted as separation, never as precision or recall.

**No precision, recall or F1 appears anywhere in this submission**, because computing one would
require a label set we do not have. Inventing it would be worse than the gap.

---

## 1. Plate legibility — geometric

The most important measurement in the submission, and the most solid, because it does not depend on
any model being right.

| | |
|---|---|
| Sample | 27 vehicle detections, cameras 5 and 10, **daylight** |
| Median vehicle bounding box | **164 px wide** |
| p90 | 199 px |
| Implied plate width (a plate spans ~¼ of vehicle width at these angles) | **median 41 px**, p90 50 px |
| Threshold for ten legible characters | ~90 px |
| **Vehicles clearing it** | **0 of 27 (0.0 %)** |

Independently, CLAUDE.md records the night-time case from the other direction: plates around
50×14 px with roughly 6 px glyphs.

**Conclusion.** The limit is camera distance and sensor resolution, not lighting. It is not
addressable by model choice, better weights, or super-resolution — the information is not in the
pixels. This is why no OCR engine is installed and why the vehicle signature, not the plate, is the
primary identifier.

*Reproduce:* sample vehicle boxes with the detector on any daylight fixture and take the width
distribution. The quarter-width ratio is the standard proportion of an Indian plate to a car's
frontal width.

---

## 2. Appearance re-identification — distributional

Cosine similarity between OSNet embeddings, measured on real cam_10 vehicles.

| | Median cosine |
|---|---|
| Same vehicle, different frames | **0.950** |
| Different vehicles | **0.544** |
| **Separation** | **0.405** |

Sample: 7 vehicles with ≥4 usable crops, 86 same-vehicle pairs and 21 different-vehicle pairs.

**What this is not.** "Same vehicle" means *the tracker assigned the same id*. Where the tracker was
wrong, this figure is wrong in the flattering direction. It says the threshold separates two
populations cleanly; it does not say the populations were correctly assembled.

**What makes it usable anyway.** The operational threshold is 0.82, which sits far from the
different-vehicle median (0.544) with room for a poorer viewing angle. And the failure mode is
visible rather than silent: cross-camera matches are additionally constrained by geography (§4), so
a false appearance match still has to be physically possible before it reaches an operator.

---

## 3. Cross-camera matching — measured, and its failure exposed

At threshold 0.82, same-class matches between indexed cameras:

| Camera pair | Separation | Matches | Reading |
|---|---|---|---|
| 5 ↔ 16 — one junction, two angles | ~0 km | **949** | The system working |
| 5 ↔ 10 — different districts | **~300 km** | **20** | **False positives** |
| 10 ↔ 16 | ~300 km | 1 | False positive |

The 21 impossible matches are the honest result of appearance similarity alone: two white cars that
look alike, on cameras 300 km apart. An appearance model cannot tell them apart because it was never
asked about geography.

**This is why route reconstruction constrains on physics.** A sighting joins a route only if it also
comes next in forensic time and sits somewhere the vehicle could have reached under 140 km/h. The
false positives above are rejected by that rule, not by a better model.

---

## 4. Colour estimation — distributional, and deliberately hedged

| | Signatures | Flagged `colour_uncertain` |
|---|---|---|
| Daylight (cam 10) | 138 | **0** |
| Night (cam 11) | 146 | **13 (8.9 %)** |

**What this shows.** The low-light flag fires selectively — never in daylight, sometimes at night —
so it is a working signal rather than decoration. Streetlit scenes stay confident, which is why the
night figure is 8.9 % rather than 100 %.

**What this does not show.** Whether the colours are *correct*. No labelled set exists, so colour
accuracy is unmeasured. The system reports colour with an uncertainty flag and the interface shows
it; neither claims the colour is right.

---

## 5. Clock anchoring by OCR — measured, and the feature disabled

The one figure here that was checked against read values rather than the system's own output.

| | |
|---|---|
| Exact-read accuracy | **35.4 %** |
| Required gate | **95 %** |
| Result | **Feature disabled** |

Camera 16 carries no burned-in clock at all, so the technique cannot apply to the whole grid even
if accuracy improved.

Automatic anchoring is off, and `recorded_at` uses the slot model with a per-camera drift correction
instead. Where no anchor has been measured for a camera, the fallback rate (+0.5139 %) is labelled
as borrowed from camera 10 rather than measured on the camera it is applied to.

---

## 6. Scene fingerprinting — distributional

Perceptual hash of a 10-second median frame, bucketed by time-of-day slot.

| | Hamming distance |
|---|---|
| Same camera, same bucket | **0–14 bits** |
| Different cameras | **22–38 bits** |

Match below 10 bits, conflict above 18, and the band between requires a human. Comparison is always
within a time bucket: comparing a camera's day frame against its own night frame gives 24–32 bits,
which read as a conflict when the fingerprint is genuinely the same camera. That is a real bug found
and fixed during development, and it is why the bucket exists.

---

## 7. Throughput and latency — measured on this machine

| | Measured |
|---|---|
| Detector, 640 px, Apple MPS | **19 ms/frame** (≈53 fps) |
| Detector, 960 px | 26 ms/frame (≈39 fps) |
| Pipeline on a fixture | **25 sampled fps** |
| Pipeline on the live grid | 1.5 sampled fps — *bounded by real time, not compute* |
| Detection → alert on screen | **3–46 ms** (budget 500 ms) |
| Forensic search over the index | **36–141 ms** (budget 200 ms) |
| Route reconstruction | 139–373 ms |

The live figure is lower than the fixture figure by design: HLS delivers at real time and cannot be
run ahead of, which the organisers' reference states plainly. It is a property of the source, not a
shortfall in the pipeline.

Hardware: Apple M-series, MPS backend, `yolov8n`. A T4/L4 with a light detector is published at
25–35 1080p streams.

---

## 8. Index scale

| | |
|---|---|
| Detections | 12,969 |
| Tracks | 1,896 |
| Vehicle signatures | 973 |
| Cameras indexed | 3 |
| Of which, from the **live** grid | 420 detections / 58 tracks, in a 45-second run on 26 August |

---

## What would strengthen this

Honestly stated, because a reviewer will think of it anyway:

1. **A hand-labelled set.** A few hundred vehicles labelled by identity and colour across two
   cameras would convert §2 and §4 from separation into accuracy, and would let a precision/recall
   figure exist at all.
2. **Re-ID validated against labelled identities** rather than tracker-assigned ones, which is the
   single largest caveat in this document.
3. **More live-grid hours.** One 45-second live run is proof of the path, not a performance sample.

None of these were possible in the time available. Saying so is better than presenting a
distributional figure as though a label set stood behind it.
