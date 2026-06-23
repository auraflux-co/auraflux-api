# ClipzWorld Live Host — Equipment Shopping List

**Goal:** Go live on Twitch (News → Sports → Streamers), record locally for YouTube, react on camera to clips — **no green screen required.**

Jira: [CPD-1057](https://aurafluxco.atlassian.net/browse/CPD-1057) · OBS template: `OBS_TEMPLATE_NO_GREENSCREEN.md`

---

## Skip green screen (recommended)

Green screen adds wrinkle lighting, spill on skin, and OBS chroma-key fiddling — the main reason people hate OBS.

**Use instead:** dark wall or navy curtain **behind you** + **digital backdrop** in OBS (Browser Source). Your camera sits **on top** of the branded graphic. No keying, no “green halo.”

---

## Tier 1 — Pilot kit (~$250–450)

Enough for a 45–60 min test show. Buy this first; upgrade only after one clean pilot.

| Item | Why | Examples |
|------|-----|----------|
| **USB mic (dynamic)** | Laptop mics sound bad on Twitch + YouTube | Shure MV7, Audio-Technica AT2040USB, Samson Q2U |
| **1080p webcam** | Fixed frame every night | Logitech Brio, Razer Kiyo Pro, Logitech C920s |
| **Key light** | Dark room = noisy camera + tired look | Neewer 18" ring light, Elgato Key Light Mini, small softbox |
| **Closed-back headphones** | Hear clip audio before it goes live | Any wired studio cans (Sony MDR-7506, ATH-M40x) |
| **Second screen** | Rundown + chat off the program monitor | Old monitor, iPad sidecar, or laptop screen |
| **Navy backdrop (optional)** | Cleaner look than random wall | Collapsible **dark gray/navy** cloth 5×7 ft — **not green** |

**Wi‑Fi is fine** — no ethernet adapter required. See **Wi‑Fi streaming** below.

**Already have:** Mac/PC that runs `auraflux` + OBS at 1080p30, 50 GB free disk.

**Do not buy yet:** Green screen, second camera, XLR chain, teleprompter hardware.

---

## Tier 2 — Weekly show kit (~$800–1,500)

After pilot works; better picture + audio + lighting consistency.

| Item | Why | Examples |
|------|-----|----------|
| **Mirrorless + capture card** | Cleaner image than webcam | Sony ZV-E10 / ZV-1 + Elgato Cam Link 4K |
| **Tripod + ball head** | Same framing every scene | Manfrotto compact video tripod |
| **Two lights** | Key 45° + soft fill opposite | Elgato Key Light Air ×2, or key + small fill LED |
| **XLR mic + interface** | Broadcast voice (if you want SM7B sound) | Shure SM7B + Cloudlifter + Focusrite Scarlett Solo |
| **Desk boom or arm** | Mic off desk bumps | Rode PSA1, Elgato Wave Mic Arm |
| **Power strip + cable ties** | 3-hour set — one plug, no tripping | — |

---

## Tier 3 — Nice to have (later)

| Item | When |
|------|------|
| Teleprompter app on iPad + stand | When scripts are long and you stop ad-libbing |
| Stream Deck Mini | Scene hotkeys without keyboard |
| Dedicated stream NUC/mini PC | When gaming + OBS on same machine stutters |
| UPS battery | Power blip doesn’t kill recording |

---

## Software (free)

| Tool | Use |
|------|-----|
| **OBS Studio** | Scenes, stream, **local recording** |
| **auraflux dashboard** | Comps, rundown, clip URLs |
| **Epidemic Sound** (already in stack) | Open/outro music — licensed |
| **CapCut / ffmpeg** | Portrait cuts from Twitch VOD after live |

**Skip for v1:** Streamlabs as primary switcher, green-screen plugins, multiple OBS profiles.

---

## Room setup (5 minutes, no construction)

1. **Camera** at eye level — laptop on stack of books is fine for pilot.
2. **Light** in front of you, slightly above eye line — **not** behind you (window behind = silhouette).
3. **Wall/curtain** 3–6 ft behind you — dark navy/charcoal; turn off overhead room lights if they cast yellow blobs.
4. **Mic** 6–8 inches from mouth, off-axis (not straight into mouth pops).
5. **Frame:** head + shoulders to mid-chest — same crop in every HOST scene.

---

## One-page “buy this weekend” list

```
□ USB dynamic mic (MV7 or AT2040USB)
□ Webcam (Brio or C920s) OR phone + Cam Link if you already own a good phone camera
□ Ring light or small LED panel
□ Wired headphones
□ Dark backdrop cloth OR paint one wall corner #22304b / charcoal
□ OBS Studio installed
□ Folder: ~/ClipzWorld/obs/music/ + ~/ClipzWorld/recordings/
```

(Ethernet adapter **not** on the list — Wi‑Fi works.)

---

## Wi‑Fi streaming (no ethernet)

You do **not** need ethernet for the pilot or weekly show. **Local recording in OBS is the master** — if Twitch hiccups, you still have the MKV.

| Do this | Why |
|---------|-----|
| Stream machine **near the router** | Weak signal = dropped frames |
| **5 GHz** Wi‑Fi if available (not 2.4 only) | Less congestion |
| Close heavy downloads on the same network during show | Bandwidth fights with 6000 Kbps upload |
| **Always record locally** in OBS (MKV) | Twitch VOD is backup; YouTube comes from local file |
| Phone on **same Wi‑Fi** for chat — not hotspotting the stream PC | Hotspot adds jitter |
| Pilot at **45–60 min** first | Proves Wi‑Fi holds before a 3-hour block |

If you get dropped frames: lower stream to **4500 Kbps** in OBS Profile → Output, or drop to **720p30** for the pilot only. Local recording can stay 1080p.

Optional later: mesh node or powerline adapter in the room — still not a cable into the laptop.

---

## What each desk uses (same gear)

| Desk | Gear change |
|------|-------------|
| News | Same camera — OBS backdrop `?desk=news` (gold accent) |
| Sports | Same — `?desk=sports` (blue accent) |
| Streamers | Same — `?desk=streaming` (purple accent) |

Clips play full-screen in `CLIP` scene; your face returns on `HOST` / `DESK_*` scenes.

---

*Last updated: 2026-06-13*
