# Demo recording script — government feed

**4 min 30 s.** Read the bold instruction, do it, then read the quoted text aloud.
Team Anveshan · DrishtiNet · Gujarat Police Innovation Challenge 2026

Everything here is on a screen that exists. Nothing is described that the build does not do.

---

## Before you press record

```bash
open -a Docker          # wait until it says Running
make infra
npm run dev             # note the port it prints — 3000 or 3001
```

Sign in at `/login` as **admin** / **drishti_dev_only**.

Check the grid is up — if this does not print JSON, stop and try later:

```bash
curl -s https://live.corp8.cloud/api/ingest | head -c 200
```

Open three tabs: **`/registry`** · **`/wall`** · **`/operations`**
Browser zoom 110–125 %. OBS: 1920×1080, 30 fps, ~10 Mbps, capture the browser window only.

---

# 0:00

### ▶ OPEN: `/registry`

**Sit still on the map. Do not move the mouse.**

> "This is DrishtiNet, built for the Sentinel challenge by Team Anveshan.
>
> It is Reference Model 1 — the centralised CCTV registry and GIS the challenge makes mandatory —
> with a working slice of Model 4 on top: vehicle analytics, watchlist alerts, and cross-camera
> route reconstruction.
>
> Everything you are about to see runs offline on this one laptop. No cloud. The only thing it
> reaches out to is the organisers' camera grid."

---

# 0:20

### ▶ SWITCH TO: your terminal

**Type and run:**

```bash
curl -s https://live.corp8.cloud/api/ingest | head -c 300
```

**Let the JSON sit on screen while you say:**

> "The catalogue is the contract, not the URL pattern — so everything starts here. Thirty cameras,
> each with its id, codec, live status, and all three stream URLs.
>
> On this network the RTSP port and the WebRTC port do not answer. They hang rather than refuse,
> which is what a filtered port looks like. So our gateway falls through to the HLS endpoint the
> integration reference nominates for restricted networks — and that one works."

---

# 0:50

### ▶ SWITCH TO: `/wall`

**Click "Open live" on the first camera tile. Wait for the picture to appear.**

> "That is a live camera on the organisers' grid, playing in this browser."

**Now stop talking. Let the video run for five full seconds.**

> "It is not connected directly. One pull per camera goes into our own media server, and every
> viewer reads from us — so fifty operators watching this junction is still one connection to their
> infrastructure.
>
> Tiles never open by themselves, and at most five cameras are pulled at once. That is a politeness
> limit, not a performance one: each client gets its own copy of their stream."

---

# 1:20

### ▶ SWITCH TO: your terminal

**Run this and leave it running in the background:**

```bash
make index-fixture ARGS='--url "https://live.corp8.cloud/live/stream/10/index.m3u8" --label "10 char-chowk-road-2-junagadh" --seconds 45'
```

> "While that tile plays, the analytics service is reading the same grid and indexing what it sees.
>
> Every frame is sampled on a presentation-timestamp grid, never on arrival time. The gateway
> replays a buffered group of pictures when you connect, so the first second arrives faster than
> real time — and a tracker that timestamps by arrival computes impossible speeds."

---

# 1:45

### ▶ SWITCH TO: `/operations`

**Point at the counters along the top.**

> "Detections, tracks, and vehicle signatures — written as they happen, not batched at the end.
> Forensic search is served from this index and never from video."

**Use the filters: pick a vehicle type, then a colour.**

> "Search comes back in about a tenth of a second, and the page prints the measured time rather than
> a target."

**Point at the PLATE column.**

> "Now look at the plate column. It says *not legible* — and that is the most important thing in
> this demonstration."

---

# 2:15

### ▶ STAY ON: `/operations` — hover the "not legible" tooltip

> "We measured plates on these cameras, in daylight. The median vehicle is 164 pixels wide, which
> puts a ten-character plate at about 41 pixels. Reliable recognition needs around 90. Zero of the
> twenty-seven vehicles we sampled cleared that bar.
>
> The limit is camera distance and sensor resolution — not lighting — so no model choice fixes it.
>
> We did not install an OCR engine. A recogniser on a 41-pixel plate does not fail cleanly: it
> returns a confident, wrong registration number. In a police alert, that is worse than no alert."

---

# 2:40

### ▶ STAY ON: `/operations`

> "So vehicles are identified by appearance instead: type, colour, and a 512-dimension embedding.
>
> Measured on real vehicles from this grid, the same vehicle scores 0.95 against itself and 0.54
> against a different one.
>
> That is separation, not accuracy. We have no hand-labelled ground truth, so no precision or recall
> figure appears anywhere in this submission."

---

# 3:00

### ▶ CLICK: any vehicle type in the results → opens the route page

> "This is that vehicle's route across cameras, reconstructed in about two-tenths of a second.
>
> And here is the trap we had to design around. At our matching threshold, the appearance model
> found 949 matches between cameras 5 and 16 — one junction seen from two angles, which is correct.
> It also found twenty matches between cameras three hundred kilometres apart, in different
> districts.
>
> Those are two white cars that look alike. The model cannot tell them apart, because nobody asked
> it about geography."

**Scroll to "How this route was built".**

> "So a sighting joins a route only if it also comes next in forensic time, and is somewhere the
> vehicle could physically have reached.
>
> Legs touching a camera nobody has placed on the map are kept — but shown as *not verifiable*. A
> mapping gap is not evidence of absence, and 'not disproved' must never look like 'confirmed'."

---

# 3:35

### ▶ GO BACK TO: `/operations` — point at the live alerts panel

> "When a signature matches the watchlist, an alert reaches the operator. Detection to screen is
> measured between 3 and 46 milliseconds, against a budget of 500."

**Point at an alert's "Detection → alert" figure.**

> "Every alert records how it was reached: what matched, how confident, and whether a plate reading
> had to be repaired. A repaired reading never renders the same as a clean one.
>
> Colour carries the same discipline — below a measured brightness threshold the system marks it
> uncertain rather than asserting it. Zero of 138 signatures flagged in daylight, thirteen of 146 at
> night."

---

# 3:55

### ▶ SWITCH TO: your terminal

**Run:**

```bash
curl -s localhost:4003/vahan/GJ01AB1234 | head -20
```

> "Alerts can be enriched from VAHAN, SARTHI, eGujCop, AFIS and NAFIS.
>
> Every one of those is a local mock. We hold no live government access, and every response says so
> — in its body, in an HTTP header, and on screen. AFIS and NAFIS expose no lookup at all: this
> platform performs no biometric matching and stores no biometric data."

---

# 4:10

### ▶ SWITCH TO: `/registry` — zoom the map out to the whole state

> "At eighty thousand cameras this is 160 gigabits per second, against about thirty available on the
> state network. Raw video cannot be centralised — that is arithmetic, not procurement.
>
> So video stays at the edge and only metadata moves, which is exactly what Model 1's registry makes
> possible.
>
> The registry also states what it does not know: twelve cameras have unverified positions, and every
> camera is still unassigned to a department. Those are the honest starting conditions of any
> integration like this — and they are the list a rollout works down."

---

# 4:25

### ▶ STAY ON: `/registry` — hold still on the map

> "DrishtiNet. The source is public at github.com/Het161/DrishtiNet, with every measurement in this
> video reproducible from the repository.
>
> Thank you."

**Stop recording.**

---

## If something breaks mid-take

| What you see | What it means | Fix |
|---|---|---|
| Tile will not open | Grid may be down | Check `/api/ingest` still answers. If not, stop — record later |
| "no database" on a page | Docker stopped | `make infra`, reload |
| Alerts say "feed offline" | Redis down | `make infra`, reload |
| Port already in use | Another dev server | Follow what the preflight prints |

**Do not** speed up, cut away from, or re-time the live video tile. If it stutters, that is the
network — and it is more honest than an edit.

## Do not demonstrate these — say them if asked

- ANPR reading a plate on the government feed — geometrically impossible here
- Watchlist editing, alert triage, evidence export as screens — the capabilities exist in the
  database and libraries; the interfaces are not built
- Face recognition — documented integration-readiness only, by choice
