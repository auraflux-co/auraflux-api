# OBS Template — No Green Screen (ClipzWorld Live)

**You do not need chroma key.** Build a branded “studio” with Browser Sources + your webcam on top.

Assets: `assets/broadcast/obs/` · Checklist: `OBS_LIVE_CHECKLIST.md` · Gear: `EQUIPMENT_SHOPPING_LIST.md`

---

## One-command install (macOS)

From `cwn-c0`:

```bash
bash tools/obs/install_clipzworld_obs.sh
```

This installs:

- **Scene collection** `ClipzWorld-Live` → 11 scenes, browser backdrops, camera layout, clip slot
- **Profile** `ClipzWorld-Live` → 1920×1080 · 30 fps · MKV → `~/ClipzWorld/recordings/`

Then in **OBS Studio** (restart if it was open):

1. **Scene Collection → ClipzWorld-Live**
2. **Profile → ClipzWorld-Live**
3. **Settings → Stream** → Twitch stream key
4. **`pm2`** / auraflux running on `:3000` (browser sources)
5. **Sources → Host Camera** → confirm webcam device
6. **Sources → Clip Media** → tonight’s first clip MP4 from rundown

Regenerate JSON only: `node tools/obs/generate_clipzworld_collection.js`

### Scenes included

| Scene | Contents |
|-------|----------|
| `OPEN_LEAD` | Dark open slate |
| `OPEN_STING` | Branded open (`desk=news`) + open music slot |
| `HOST` / `DESK_NEWS` | News backdrop + camera + LIVE + lower third |
| `DESK_SPORTS` | Sports backdrop + camera + overlays |
| `DESK_STREAMING` | Purple streamer backdrop + camera + overlays |
| `CLIP` | Full-screen clip + small facecam PIP |
| `BUMPER_SPORTS` / `BUMPER_STREAMING` | Desk chapter stings |
| `BRB` | Be right back slate |
| `OUTRO_STING` | Outro card + outro music slot |

---

## How it works (30-second version)

```
┌─────────────────────────────────────────┐
│  Layer 3: LIVE bug (small, top-right)   │
│  Layer 2: Your webcam (no green screen) │
│  Layer 1: host_backdrop.html (full screen)│
└─────────────────────────────────────────┘
```

The backdrop is a **picture** — your camera is simply **placed on top**, cropped to the left “host window.” Twitch sees a news-desk look without cutting out your background in software.

---

## Step 1 — OBS global settings (once)

1. **Settings → Video:** Base 1920×1080, Output 1920×1080, **30 FPS**
2. **Settings → Output → Streaming:** Twitch, CBR **6000 Kbps**, keyframe 2s
3. **Settings → Output → Recording:** Format **MKV**, path `~/ClipzWorld/recordings/%Y-%m-%d/%H-%M-%S`
4. **Settings → Audio:** 48 kHz stereo
5. **Profile → New:** name `ClipzWorld-Live`

**Stream key:** Twitch Dashboard → Settings → Stream (same as `TWITCH_STREAM_KEY` in `.env` — never commit to git).

---

## Step 2 — Create scenes (minimum)

| Scene | What’s on air |
|-------|----------------|
| `OPEN_STING` | Browser sting only (+ open music) |
| `HOST` | Backdrop + camera + LIVE bug |
| `DESK_NEWS` | Same as HOST, backdrop `desk=news` |
| `DESK_SPORTS` | Same, `desk=sports` |
| `DESK_STREAMING` | Same, `desk=streaming` |
| `CLIP` | Full-screen clip (+ optional small facecam) |
| `BRB` | `brb_slate.html` |
| `OUTRO_STING` | `outro_sting.html` (+ outro music) |

Duplicate `HOST` three times and rename for desk scenes — only change the backdrop URL `desk=` param.

---

## Step 3 — Build `HOST` scene (copy these numbers)

**Start auraflux** so browser URLs load: `http://localhost:3000`

### Layer 1 — Backdrop (bottom)

| Property | Value |
|----------|--------|
| Source type | **Browser** |
| URL | `http://localhost:3000/assets/broadcast/obs/host_backdrop.html?desk=news` |
| Width | 1920 |
| Height | 1080 |
| ✓ | Refresh browser when scene becomes active |

### Layer 2 — Camera (your face)

| Property | Value |
|----------|--------|
| Source type | **Video Capture Device** |
| Device | Your webcam / Cam Link |
| **Filters** | Noise suppression ON · **NO Chroma Key** |
| Transform → Position | X **80**, Y **120** |
| Transform → Size | Width **920**, Height **690** (adjust until you fill the left panel) |

**Tip:** Right-click camera → **Transform → Edit Transform Mode** — drag corners until your shoulders fit the rounded frame on the backdrop. Save as default for all DESK_* scenes (right-click → **Copy Source** → paste into other scenes).

**Mic filters (on audio device, not video):** Noise suppression, optionally Compressor (ratio 3:1, threshold −18 dB).

### Layer 3 — LIVE bug (top)

| Property | Value |
|----------|--------|
| Source type | **Browser** |
| URL | `http://localhost:3000/assets/broadcast/obs/live_bug.html` |
| Size | 1920×1080 |

### Layer 4 — Lower third (optional dynamic title)

| Property | Value |
|----------|--------|
| Source type | **Browser** |
| URL | `http://localhost:3000/assets/broadcast/obs/host_lower_third.html?desk=news&title=TOP+STORY` |
| Size | 1920×1080 |

Change `title=` between segments (or leave generic desk name for pilot).

---

## Step 4 — Build `CLIP` scene

1. **Media Source** (bottom) — 1920×1080, local MP4 or URL from rundown page  
2. **Optional:** Copy your camera source → scale to **~320×240**, position bottom-left — PIP while clip plays  
3. **Advanced Audio:** Clip audio on Track 1 with mic; duck mic −6 dB when clip has dialogue if needed  

Switch **HOST ↔ CLIP** with hotkeys F1 / F2.

---

## Step 5 — Hotkeys

| Key | Action |
|-----|--------|
| F0 | `OPEN_STING` |
| F1 | `HOST` or active desk |
| F2 | `CLIP` |
| F3 | `BRB` |
| F5 | `OUTRO_STING` |
| F6 | Mute mic |

---

## Step 6 — Test before live (10 min)

1. Each desk backdrop URL loads (news gold / sports blue / streaming purple).  
2. Camera fills left panel — **no green edges**, no fuzzy hair.  
3. Speak at show volume — mixer peaks **−12 to −6 dB** (yellow, not red).  
4. Play one clip from rundown in `CLIP` — audio on stream + recording.  
5. **Start Recording** → switch scenes 30s → stop → open MKV locally.  

If the room behind you is messy, **move camera closer** or **zoom in** — the backdrop covers the rest of the frame.

---

## Troubleshooting (why OBS “didn’t work” before)

| Problem | Fix |
|---------|-----|
| Green screen looked fake | **Don’t use green screen** — use this backdrop method |
| Browser source blank | Is `auraflux` running? URL must be `localhost:3000` |
| Camera wrong size | Edit transform on camera only — don’t resize backdrop |
| Echo / double audio | One clip source; mute browser when not on CLIP |
| Stream key conflict | Stop ClipzWorld TV loop before Go Live (same Twitch key) |
| Recording lost | Use MKV; path with free disk space |

---

## File reference

| File | URL param |
|------|-----------|
| `host_backdrop.html` | `?desk=news\|sports\|streaming` |
| `host_lower_third.html` | `?desk=…&title=Your+headline` |
| `live_bug.html` | — |
| `brb_slate.html` | — |
| `open_sting.html` | `?desk=news` (show opens on news) |
| `outro_sting.html` | `?show=TWITCH%20SOUP` |

---

## Pilot show (first night)

1. Tier 1 gear only  
2. Scenes: `OPEN_STING` → `DESK_NEWS` ↔ `CLIP` × 4 → `OUTRO_STING`  
3. 45 minutes max  
4. Record locally; YouTube upload next day  

*Last updated: 2026-06-13*
