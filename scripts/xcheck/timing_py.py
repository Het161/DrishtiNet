import json, sys
sys.path.insert(0, "services/analytics/src")
from analytics.timing import (backoff_delay_ms, PtsGridSampler, AbsoluteTimeAnchor, Frame,
                              PtsDiscontinuityDetector, is_benign_decoder_warning, is_fatal_stream_error)
out = {"backoff": [], "sampler": [], "anchor": None, "disc": [], "benign": [], "fatal": []}
for a in range(12):
    for j in (0, 0.25, 0.5, 0.75, 0.999):
        out["backoff"].append(backoff_delay_ms(a, j))
s = PtsGridSampler(200); t = 0
for gap in [33,50,17,41,33,25,60,33,33,45,120,33,33,3000,40,33]:
    t += gap
    f = s.offer(Frame(t, t))
    if f: out["sampler"].append(f.pts_ms)
an = AbsoluteTimeAnchor(1000, 100)
for i in range(200):
    pts = i * 40; delay = 0 if i == 120 else 3
    an.observe(Frame(pts, 500000 + pts + delay))
out["anchor"] = an.anchor_ms
d = PtsDiscontinuityDetector(5000)
for p in [1000, 1040, 1073, 9000, 0, 40, 80]: out["disc"].append(d.observe(p))
for m in ['Could not find ref with POC 12','RPS','corrupted macroblock 4 12','no frame','Frame num gap']:
    out["benign"].append(is_benign_decoder_warning(m))
for m in ['Connection refused','401 Unauthorized','RPS: Server returned 500','No route to host']:
    out["fatal"].append(is_fatal_stream_error(m))
print(json.dumps(out))
