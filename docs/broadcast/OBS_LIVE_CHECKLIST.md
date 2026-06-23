# ClipzWorld Live — OBS & Set Checklist

**Purpose:** Everything on **your side** (Rob) to go live on Twitch with host + clips — 3-hour magazine show (**News → Sports → Streamers**), then archive to YouTube and cut shorts.

**Target window:** 3:00–6:00 PM ET (replaces ClipzWorld TV VOD loop while you are live).

**Output spec (match pipeline):** 1920×1080, 30 fps, H.264 + AAC — same as long-form VOD.

---

## Quick reference — brand (overlays)

| Use | Hex | Notes |
|-----|-----|--------|
| Background / lower third | `#22304b` | Broadcast navy |
| Accent / headlines | `#c7af4f` | Gold |
| Streaming desk accent | `#6441A5` | Twitch purple (optional) |
| Sports desk accent | `#17408B` / `#C9082A` | When NBA/NFL returns |
| Logo | `assets/cwn_logo.png` | Top-right or lower-third |

Fonts (if adding text in OBS): **Bebas Neue** (headlines), **Barlow Condensed** (body) — same as VOD chrome.

---

## Phase 0 — Decision (before buying gear)

- [ ] **Avatar path:** Still monitoring HeyGen? If avatar ships, live-you may be 1×/week only; this checklist still applies for flagship hour.
- [ ] **Live length:** Pilot 45–60 min → 90 → 120 → **180 min** (do not start at 3 hours day one).
- [ ] **Same Twitch channel** as ClipzWorld TV loop (`TWITCH_STREAM_KEY` in `.env`).
- [ ] **Record locally in OBS** (always) — Twitch VOD is backup, not master for YouTube.

---

## 1. Hardware checklist

### Camera

- [ ] **Primary camera:** 1080p minimum (webcam Logitech Brio / Sony ZV-E10 / mirrorless with clean HDMI).
- [ ] **Tripod or mount** — fixed frame every show (same head position = consistent overlays).
- [ ] **Optional:** Key light + fill (ring light or softbox); avoid window behind you unless controlled.

### Audio (non-negotiable — bad audio kills live + VOD)

- [ ] **Mic:** USB dynamic (MV7, SM7B+interface) or lav (Rode Wireless GO) — not laptop mic.
- [ ] **Headphones** — monitor Twitch chat TTS off; hear clip audio before it goes live.
- [ ] **Optional:** Audio interface (Focusrite) if XLR mic.
- [ ] **Filters in OBS:** Noise suppression ON; gain so peaks sit around **-12 to -6 dB** (yellow, not red).

### Computer

- [ ] **Encoder:** Apple Silicon Mac or PC with NVENC — 1080p30 @ 6000 kbps video + 160 kbps audio (4500 kbps OK on Wi‑Fi if dropped frames).
- [ ] **Network:** Wi‑Fi is fine — router nearby, 5 GHz preferred; **local OBS recording** is the YouTube master regardless of stream hiccups.
- [ ] **Disk space:** ≥50 GB free for local recording (3 hr ≈ 8–15 GB depending on bitrate).

### Second screen (strongly recommended)

- [ ] **Teleprompter / rundown monitor** — script + clip order from dashboard (read-only window).
- [ ] **Chat monitor** — Twitch chat on phone or second display (not on program feed).

---

## 2. Physical set checklist

Pick **one** path for v1:

### Option A — Simple desk (fastest pilot) **← recommended, no green screen**

- [ ] Plain or **navy/dark wall** behind you — or use **`host_backdrop.html`** in OBS (camera on top, no chroma key).
- [ ] Desk at consistent distance from camera.
- [ ] No visible clutter; mug/water ok.
- [ ] Brand = **OBS browser backdrop + lower third** — see `OBS_TEMPLATE_NO_GREENSCREEN.md`.

### Option B — Branded corner

- [ ] Paint or backdrop **~#0d1424 / #22304b**.
- [ ] One practical light: key 45° off camera.
- [ ] Optional: small ClipzWorld logo print or monitor with static brand slide (not program).

### Option C — Green screen **(skip for v1 — use Option A + host_backdrop.html instead)**

- [ ] Even green, no wrinkles; separate from you (avoid green spill on skin).
- [ ] OBS **Chroma Key** filter on camera source — test before first live.
- [ ] Virtual background: solid navy `#22304b` or subtle gradient (not busy image).

**Most operators should skip Option C.** Digital backdrop + real dark wall is faster and looks more consistent than cheap green fabric.

**Set rule:** Frame **head + shoulders to mid-chest** — same crop every scene so switching Host ↔ Clip feels intentional.

---

## 3. OBS install & global settings

- [ ] Install **OBS Studio** (latest stable) from obsproject.com.
- [ ] **Settings → General:** Enable replay buffer optional; confirm **Theme** readable for long sessions.

### Video

- [ ] **Base (canvas):** 1920×1080  
- [ ] **Output (scaled):** 1920×1080  
- [ ] **FPS:** 30 (match ClipzWorld TV / VOD pipeline)

### Output → Streaming (Twitch)

- [ ] **Service:** Twitch  
- [ ] **Server:** Auto / closest ingest  
- [ ] **Stream key:** From Twitch Dashboard → Settings → Stream (same key as `TWITCH_STREAM_KEY` in server `.env` — **never commit key to git**)

Suggested live encode (Twitch):

| Setting | Value |
|---------|--------|
| Encoder | x264 (veryfast/faster) or Apple VT / NVENC |
| Rate control | CBR |
| Bitrate | **6000 Kbps** (Twitch 1080p cap) |
| Keyframe | 2 s |
| Preset | Quality balance for your CPU |

### Output → Recording (YouTube master)

- [ ] **Recording format:** MKV or MP4 (MKV safer if OBS crashes mid-show)  
- [ ] **Recording path:** e.g. `~/ClipzWorld/recordings/YYYY-MM-DD/`  
- [ ] **Same resolution** as stream OR **record at 1080p60 locally** if you want smoother YouTube master (stream can stay 30 fps)

### Audio

- [ ] **Sample rate:** 48 kHz  
- [ ] **Channels:** Stereo  
- [ ] **Desktop audio:** Capture clip playback source only (see scene design — avoid echo)

---

## 4. Scene list (build in this order)

Create scenes — **exact names help muscle memory.**

**Show packaging (v1 — no looping “starting soon”):** music + branded open → **camera appears** (“lights on”) → show → optional montage → outro music. Browser stings live in `assets/broadcast/obs/` — see that folder’s README for URLs and wiring.

| Scene | Purpose |
|-------|---------|
| `OPEN_LEAD` | Optional 3–5s dark slate while **open music** starts — **not** a loop |
| `OPEN_STING` | ~10s branded opener (Browser: `open_sting.html?desk=streaming`) + same music |
| `HOST` | **Camera on** + overlays — mic hot; music ducked or stopped |
| `CLIP` | Full-screen clip (video/browser) + optional small facecam |
| `HOST_CLIP_PIP` | Optional: clip large + you corner (use if not full-screen clip) |
| `DESK_NEWS` | HOST + lower third “BECAUSE THE LIGHT WAS ON” (**block 1**) |
| `DESK_SPORTS` | HOST + lower third sports branding (**block 2**) |
| `DESK_STREAMING` | HOST + lower third “TWITCH SOUP” / purple accent (**block 3**) |
| `BUMPER_NEWS` / `BUMPER_SPORTS` / `BUMPER_STREAMING` | ~5s desk chapter (`desk_bumper.html?desk=…`) + short music hit |
| `BUFFER_QA` | HOST + “ASK CHAT” graphic |
| `BUFFER_GAME` | HOST + game/trivia slide |
| `BRB` | Be right back — static (no long loop on pilot) |
| `MONTAGE_END` | End-of-show highlights — MP4 under browser overlay `montage_end.html` |
| `OUTRO_STING` | ~13s thank-you card + **outro music** (Browser: `outro_sting.html`) |
| `STARTING_SOON` | *Legacy* — only if you want a long pre-show wait; skip for magazine open |

Minimum for **pilot:** `OPEN_STING`, `HOST`, `CLIP`, `BRB`, `OUTRO_STING`.

### Open / close sequence (on air)

1. **Start Recording** → **Go Live** on `OPEN_LEAD` or `OPEN_STING` (music only — you are off camera).  
2. `OPEN_STING` runs ~8–10s → switch to **`HOST`** (camera + key light = “lights on, action”).  
3. Run desk (`HOST` ↔ `CLIP`).  
4. Optional **`MONTAGE_END`** (15–30s) — pre-cut `montage.mp4` or placeholder overlay until you have one.  
5. **`OUTRO_STING`** + outro music → stop stream → stop recording.

Music files: `~/ClipzWorld/obs/music/show_open.mp3`, `show_outro.mp3` (royalty-free / Epidemic Sound).

### HOST scene sources (bottom → top)

1. [ ] **Camera** (Video Capture Device)  
2. [ ] **Optional:** Chroma key filter on camera  
3. [ ] **Lower third** — Image or Text (GDI+) — story title / desk name  
4. [ ] **Logo** — Image `cwn_logo.png` (~80–90 px, top-right or bottom-right)  
5. [ ] **Optional:** “LIVE” bug (red dot + LIVE text)

### CLIP scene sources

1. [ ] **Media Source** or **VLC Video Source** — one per clip slot OR one source you swap file/URL on  
2. [ ] **Browser Source** — alternative for YouTube/Twitch clip URLs (test autoplay/unmute rules)  
3. [ ] **Audio:** Clip audio routed to stream; **duck mic** optional when clip plays  
4. [ ] **Optional facecam:** Small HOST camera PIP (10–15% width, bottom-left)

**Clip playback rule:** Pre-load next clip while talking on HOST; switch scene when clip ready — avoids dead air.

---

## 5. Audio routing checklist

- [ ] **Mic** → OBS → Stream + Recording  
- [ ] **Clip media** → Desktop audio OR dedicated source → Stream + Recording  
- [ ] **Monitor clip** on headphones before switching to CLIP scene  
- [ ] **Twitch alerts / sound effects** — separate source; keep volume lower than voice  
- [ ] **No double audio:** If clip plays in browser, mute that browser when not on CLIP scene  

Advanced (optional):

- [ ] OBS **Audio Mixer:** Mic −0 dB, Desktop −5 to −10 dB, Music −15 dB  
- [ ] **Compressor** on mic (OBS filter or RTX Voice / etc.)

---

## 6. Graphics & overlays to prepare (files)

Store in e.g. `~/ClipzWorld/obs/`:

- [ ] `logo_cwn.png` (transparent PNG)  
- [ ] `lower_third_news.png` or text template  
- [ ] `lower_third_streaming.png`  
- [ ] `lower_third_sports.png`  
- [ ] `music/show_open.mp3`, `music/show_outro.mp3`, optional `music/montage_bed.mp3`  
- [ ] `montage.mp4` — end-of-show highlight reel (when ready)  
- [ ] `brb.png`  
- [ ] Browser stings (already in repo): `assets/broadcast/obs/open_sting.html`, `outro_sting.html`, `montage_end.html`  
- [ ] Optional: desk chapter stingers (5 sec) between blocks  

**Streamlabs / StreamElements:** Optional for alerts only — do not duplicate scene logic; keep **OBS as single program switcher**.

---

## 7. Rundown & clip prep (ClipzWorld side)

**Before every show:**

- [ ] Dashboard / cron: today’s **script + clip list** exported (news stories, sports packages, Twitch clips).  
- [ ] **5–6 news**, **3–5 sports**, **6–8 streaming** clips picked (over-pick; cut on air). Run desks **news → sports → streamers**.
- [ ] Each clip: **local MP4 path or URL** tested in OBS Media Source once.  
- [ ] **Rundown sheet** (Google Doc or print) with columns:

  | Time (target) | Scene | Segment | Clip file/URL | Notes |
  |---------------|-------|---------|---------------|-------|

- [ ] Mark **chapter timestamps** on rundown as you go (for YouTube + shorts).

**Server coordination (critical):**

- [ ] Confirm **ClipzWorld TV loop is STOPPED** before you start OBS stream — same stream key; two publishers = broken stream.  
  - Broadcast dashboard → Stop Twitch TV, **or** ensure live window is “host live” not loop in calendar.  
- [ ] After you end stream, loop can restart for off-hours (optional).

---

## 8. 3-hour show rundown template (180 min)

**Desk order (locked):** News → Sports → Streamers (Twitch Soup).

| Block | Min | OBS scenes |
|-------|-----|------------|
| Cold open | 10 | `OPEN_STING?desk=news` → HOST (intro teases **news first**) |
| **News desk** | 50 | `DESK_NEWS` ↔ CLIP |
| Buffer A | 10 | BUFFER_QA or BUFFER_GAME |
| **Sports desk** | 40 | `BUMPER_SPORTS` → `DESK_SPORTS` ↔ CLIP |
| Buffer B | 10 | BUFFER_QA / chat |
| **Streaming desk** | 50 | `BUMPER_STREAMING` → `DESK_STREAMING` ↔ CLIP |
| Outro | 10 | MONTAGE_END (optional) → OUTRO_STING |

**Pilot:** One block only — start with **News** (~45 min + open/outro).

YouTube chapters (post-show): `0:00 Intro` · `News` · `Sports` · `Twitch Soup` · `Outro`.

---

## 9. Pre-show checklist (T−60 to T−0)

### T−60

- [ ] Pickers/cron rundown ready; clips downloaded to `~/ClipzWorld/clips/YYYY-MM-DD/`.  
- [ ] OBS profile loaded (`ClipzWorld-Live`).  
- [ ] **Stop server-side Twitch TV loop** if running.  
- [ ] Test stream key: **Settings → Stream → Test** (optional Twitch test ingest).

### T−15

- [ ] Camera framed; mic levels checked (speak at show volume).  
- [ ] All scenes clicked through once; clips 1–3 test-play in CLIP scene.  
- [ ] Recording **armed** (Start Recording) — start recording **before** Go Live.  
- [ ] Phone on silent; notifications off on stream machine.

### T−5

- [ ] Scene: `OPEN_LEAD` or `OPEN_STING` (music armed, **camera not in scene yet**).  
- [ ] **Go Live** on Twitch when ready — no long looping slate.  
- [ ] Tweet/discord optional “live now”.

### T−0

- [ ] Run `OPEN_STING` (~10s) → switch to **`HOST`** — lights on, start cold open.  
- [ ] Note **start time** in rundown (wall clock) for YouTube chapters.

---

## 10. During show checklist

- [ ] **One desk at a time** — announce chapter (“News desk in 2 minutes”).  
- [ ] **HOST → CLIP → HOST** per item; do not talk over clip audio unless intentional.  
- [ ] Log **timestamp** at each desk start and each best clip (for shorts).  
- [ ] If clip fails: skip to backup clip from rundown — do not stall >30 sec.  
- [ ] **BRB** scene if bathroom/technical — never leave live on dead camera.  
- [ ] Chat: designate commands (`!clip`, `!news`) only if you have mods/tools.  
- [ ] **CPU/GPU watch** — close Chrome tabs; 3 hours is long.

---

## 11. End of show checklist

- [ ] Optional `MONTAGE_END` → `OUTRO_STING` (music + thank you).  
- [ ] **Stop Stream** (Twitch) after outro fade.  
- [ ] **Stop Recording** — wait for file finalize (MKV remux if needed).  
- [ ] Note **end timestamps** per desk on rundown.  
- [ ] Optional: restart **ClipzWorld TV loop** for remainder of 3–6 PM window or hand off to VOD playlist.

---

## 12. Post-show — YouTube & shorts

- [ ] **Upload master:** Local OBS file → YouTube (unlisted review first).  
- [ ] **Chapters** in description (News / Sports / Twitch Soup + buffer markers).  
- [ ] **Title/thumbnail:** Reuse publish copy from pipeline if same clips as VOD job, or write live-specific title.  
- [ ] **Shorts (3–5):** Vertical crop 9:16 — best clip+reaction moments (~30–60 s each).  
  - Tools: CapCut, Descript, or ffmpeg; later: pipeline `generate-clip-comp` from timestamps.  
- [ ] Calendar slots: 5 PM / 6 PM / 7 PM ET shorts — Upload-Post or native schedule.  
- [ ] Archive rundown + recording path in job notes (future: auto-ingest Twitch VOD).

---

## 13. OBS hotkeys (set these)

| Action | Suggested key |
|--------|----------------|
| OPEN_STING | F0 |
| Switch to HOST | F1 |
| Switch to CLIP | F2 |
| Switch to BRB | F3 |
| MONTAGE_END | F4 |
| OUTRO_STING | F5 |
| Mute mic | F6 |
| Start/Stop Recording | F9 (careful) |

Settings → Hotkeys → assign; avoid conflicts with games.

---

## 14. Backup & failure

- [ ] **Internet drop:** OBS auto-reconnect (Twitch) — keep recording locally regardless.  
- [ ] **OBS crash:** MKV segment may be recoverable; restart stream with “technical difficulties” slate.  
- [ ] **Clip bad URL:** Local MP4 fallback folder per desk.  
- [ ] **Second device:** Phone hotspot — emergency backup only, not for a 3 hr primary show on Wi‑Fi.  
- [ ] **Stream key leak:** Reset in Twitch dashboard immediately; update `.env` on server if loop uses same key.

---

## 15. Legal / platform (reminder)

- [ ] **Transformative host + clips** — you comment between clips; do not rebroadcast full games/raw ESPN.  
- [ ] **Do not** restream Live Grid (other Twitch channels) to Twitch — YouTube grid only.  
- [ ] **Music:** Use royalty-free bed in STARTING_SOON/BRB only; clip audio is from source (platform risk per clip — same as VOD policy).

---

## 16. First pilot — minimal shopping list

Full list with tiers: **`docs/broadcast/EQUIPMENT_SHOPPING_LIST.md`** · OBS build: **`docs/broadcast/OBS_TEMPLATE_NO_GREENSCREEN.md`**

If buying nothing else:

1. Decent webcam **or** phone as cam (EpocCam/NVIDIA)  
2. **USB mic** (MV7 or similar)  
3. **Ring light**  
4. **Second monitor** or tablet for rundown  
5. OBS + this checklist  

**Total pilot:** one desk, 45 minutes, 4 clips, record locally, upload YouTube next day, one Short manually.

---

## 17. Future wiring (ClipzWorld product)

Not required for pilot; track when ready:

- [ ] Calendar slot `twitch_host_live` — auto-stop VOD loop before your window  
- [ ] Dashboard **“Live rundown export”** → JSON/CSV for OBS clip list  
- [ ] Post-stream: Twitch VOD URL → YouTube upload helper  
- [ ] Timestamp log → auto-spawn `generate-clip-comp` shorts  

---

*Last updated: 2026-06-13 — open/outro/montage stings in `assets/broadcast/obs/`; aligns with `content_calendar.json` Twitch TV window 15:00–18:00 ET and 3-desk magazine format.*
