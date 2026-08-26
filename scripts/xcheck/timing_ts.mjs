import { backoffDelayMs, PtsGridSampler, AbsoluteTimeAnchor, PtsDiscontinuityDetector,
         isBenignDecoderWarning, isFatalStreamError }
  from '../../services/stream-gateway/src/live/stream-reader.ts';
const out = { backoff: [], sampler: [], anchor: null, disc: [], benign: [], fatal: [] };
for (let a = 0; a < 12; a++) for (const j of [0, 0.25, 0.5, 0.75, 0.999])
  out.backoff.push(backoffDelayMs(a, j));
const s = new PtsGridSampler(200);
let t = 0;
for (const gap of [33,50,17,41,33,25,60,33,33,45,120,33,33,3000,40,33]) {
  t += gap; const f = s.offer({ ptsMs: t, arrivalMs: t });
  if (f) out.sampler.push(f.ptsMs);
}
const an = new AbsoluteTimeAnchor(1000, 100);
for (let i = 0; i < 200; i++) {
  const pts = i * 40; const delay = i === 120 ? 0 : 3;
  an.observe({ ptsMs: pts, arrivalMs: 500000 + pts + delay });
}
out.anchor = an.anchorMs;
const d = new PtsDiscontinuityDetector(5000);
for (const p of [1000, 1040, 1073, 9000, 0, 40, 80]) out.disc.push(d.observe(p));
for (const m of ['Could not find ref with POC 12','RPS','corrupted macroblock 4 12','no frame','Frame num gap'])
  out.benign.push(isBenignDecoderWarning(m));
for (const m of ['Connection refused','401 Unauthorized','RPS: Server returned 500','No route to host'])
  out.fatal.push(isFatalStreamError(m));
console.log(JSON.stringify(out));
