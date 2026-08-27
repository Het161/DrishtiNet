# Government-feed demonstration — recording script

**4 minutes 30 seconds. Screen recording with voice-over.**
Team Anveshan · DrishtiNet · Gujarat Police Innovation Challenge 2026

Everything below is on a screen that exists today. Nothing is described that the build does not do.
Where a capability is deliberately absent — ANPR on this grid, live government database access — the
script says so out loud, because an evaluator who discovers a gap you hid discounts everything else.

---

## Before you press record

```bash
open -a Docker                     # it stops on its own; check it is running
make infra                         # postgres, redis, mediamtx, minio
npm run dev                        # web :3001 · gateway :4001 · alerts :4002 · integrations :4003
make slot                          # says what the footage is showing right now
```

Then:

- Sign in at `http://localhost:3001/login` as **admin**, and leave the tab on `/wall`
- Open a second tab on `/operations`
- Confirm `curl -s https://live.corp8.cloud/api/ingest | head -c 200` returns JSON — if the grid is
  down, stop and try later rather than recording a fallback
- **OBS**: 1920×1080, 30 fps, ~10 Mbps H.264, capture the browser window only, system audio off
- Zoom the browser to 110–125 % so text is readable when the video is scaled down
- If `VIRTUAL_NOW_IST` is set, the time-shift badge must stay visible — never crop it

---

## 0:00 – 0:20 · What this is

**On screen:** `/registry`, the map with camera markers.

> "This is DrishtiNet, built for the Sentinel challenge by Team Anveshan. It is Reference Model 1 —
> the centralised CCTV registry and GIS the challenge makes mandatory — with a working slice of
> Model 4 on top: vehicle analytics, watchlist alerts and cross-camera route reconstruction.
>
> Everything you are about to see runs offline on this one laptop. No cloud, no internet needed at
> the venue. The only thing it reaches out to is the organisers' camera grid."

*Pause on the map. Let the districts and markers register.*

---

## 0:20 – 1:05 · Connecting to the live grid

**On screen:** terminal, then `/wall`.

> "The catalogue is the contract, not the URL pattern. Everything starts here."

**Do:** run `curl -s https://live.corp8.cloud/api/ingest | head -c 300` — show real JSON coming back.

> "Thirty cameras, each with its id, codec, live status and all three stream URLs.
>
> On this network the RTSP port and the WebRTC port do not answer. They hang rather than refuse,
> which is what a filtered port looks like. So the gateway falls through to the HLS endpoint the
> integration reference nominates for restricted networks — and that works."

**Do:** switch to `/wall`, click **Open live** on one camera. Wait for the picture.

> "That is a live camera on the organisers' grid, playing in this browser.
>
> It is not connected directly. One pull per camera goes into our own media server, and every viewer
> reads from us. Fifty operators watching this junction is still one connection to their
> infrastructure. Tiles never open by themselves, and at most five cameras are pulled at once —
> that is a politeness limit, because each client gets its own copy of their stream."

*Let the live picture run for a full five seconds. It is the single most convincing shot in the video.*

---

## 1:05 – 2:20 · Finding a vehicle

**On screen:** terminal running the indexer, then `/operations`.

**Do:** start `make index-fixture ARGS='--url "https://live.corp8.cloud/live/stream/10/index.m3u8" --label "10 char-chowk-road-2-junagadh" --seconds 45'`

> "While that tile plays, the analytics service is reading the same grid and indexing what it sees.
> Every frame is sampled on a presentation-timestamp grid, never on arrival time — the gateway
> replays a buffered group of pictures when you connect, so the first second arrives faster than
> real time, and a tracker that timestamps by arrival computes impossible speeds."

**Do:** switch to `/operations` and let the counters show.

> "Detections, tracks and vehicle signatures, written as they happen. Not batched at the end —
> forensic search is served from this index and never from video."

**Do:** use the filters — pick a vehicle type, then a colour.

> "Search comes back in about a tenth of a second, and the page prints the measured time rather than
> a target.
>
> Notice the plate column. It says *not legible*, and that is the most important thing in this
> demonstration."

**Do:** hover the "not legible" tooltip.

> "We measured plates on these cameras, in daylight. The median vehicle is 164 pixels wide, which
> puts a ten-character plate at about 41 pixels. Reliable recognition needs around 90. Zero of the
> twenty-seven vehicles we sampled cleared that bar.
>
> The limit is camera distance and sensor resolution, not lighting, so no model choice fixes it. We
> did not install an OCR engine, because a recogniser on a 41-pixel plate does not fail cleanly — it
> returns a confident, wrong registration number. In a police alert that is worse than no alert."

---

## 2:20 – 3:20 · What identifies a vehicle instead

**On screen:** `/operations`, then click a vehicle to open its route.

> "So vehicles are identified by appearance: type, colour, and a 512-dimension embedding.
>
> Measured on real vehicles from this grid, the same vehicle scores 0.95 against itself and 0.54
> against a different vehicle. That is separation, not accuracy — we have no hand-labelled ground
> truth, so no precision or recall figure appears anywhere in this submission."

**Do:** click a vehicle type in the results to open `/operations/route/…`

> "This is that vehicle's route across cameras, reconstructed in about two-tenths of a second.
>
> And here is the trap we had to design around. At our matching threshold, the appearance model
> found 949 matches between cameras 5 and 16 — one junction seen from two angles, which is correct.
> It also found twenty matches between cameras 300 kilometres apart in different districts. Those
> are two white cars that look alike. The model cannot tell them apart, because nobody asked it
> about geography."

**Do:** scroll to "How this route was built".

> "So a sighting joins a route only if it also comes next in forensic time and is somewhere the
> vehicle could physically have reached. Legs touching a camera nobody has placed on the map are
> kept, but shown as *not verifiable* — a mapping gap is not evidence of absence, and 'not disproved'
> must never look like 'confirmed'."

---

## 3:20 – 4:00 · Alerts and honesty

**On screen:** `/operations`, live alerts panel.

> "When a signature matches the watchlist, an alert reaches the operator. Detection to screen is
> measured at between 3 and 46 milliseconds, against a budget of 500."

**Do:** point at a live alert's *Detection → alert* figure.

> "Every alert records how it was reached: what matched, how confident, and whether a plate reading
> had to be repaired. A repaired reading never renders the same as a clean one.
>
> Colour carries the same discipline. Below a measured brightness threshold the system marks it
> uncertain rather than asserting it — zero of 138 signatures flagged in daylight, thirteen of 146
> at night."

**Do:** briefly show `curl -s localhost:4003/vahan/GJ01AB1234 | head -20`

> "Alerts can be enriched from VAHAN, SARTHI, eGujCop, AFIS and NAFIS. Every one of those is a local
> mock — we hold no live government access, and every response says so in its body, in an HTTP
> header, and on screen. AFIS and NAFIS expose no lookup at all: this platform performs no biometric
> matching and stores no biometric data."

---

## 4:00 – 4:30 · Scale, and close

**On screen:** `/registry`, zoomed out to the whole state.

> "At eighty thousand cameras this is 160 gigabits per second against about thirty available on the
> state network. Raw video cannot be centralised — that is arithmetic, not procurement. So video
> stays at the edge and only metadata moves, which is exactly what Model 1's registry makes possible.
>
> The registry also states what it does not know: twelve cameras have unverified positions and every
> camera is still unassigned to a department. Those are the honest starting conditions of any
> integration like this, and they are the list a rollout works down."

*End on the map.*

> "DrishtiNet. The source is public at github.com/Het161/DrishtiNet, with every measurement in this
> video reproducible from the repository. Thank you."

---

## If something goes wrong mid-take

- **Tile will not open** — the grid may be down. Check `/api/ingest` still answers before blaming the build; if it does not, stop and record later.
- **Alert panel says "feed offline"** — the alerts service lost Redis. `make infra`, then reload. Do not narrate over a stale panel.
- **A page 500s** — Docker stopped. `make infra`.
- **Do not** speed up, cut away from, or re-time the live tile. If it stutters, that is the network, and it is more honest than a cut.

## What is deliberately not in this video

State these if asked, do not perform them:

- ANPR reading a plate on the government feed — geometrically impossible here, shown in the own-feed video instead
- Watchlist editing, alert triage and evidence export as screens — the capabilities exist in the
  database and libraries; the interfaces are not built
- Face recognition — documented integration-readiness only, by choice
