# OBS browser stings — ClipzWorld live host

Served at `http://localhost:3000/assets/broadcast/obs/` when `auraflux` (cwn-c0) is running.

Jira: [CPD-1057](https://aurafluxco.atlassian.net/browse/CPD-1057) · Checklist: `docs/broadcast/OBS_LIVE_CHECKLIST.md`

**Setup guides:** [Equipment shopping list](../../docs/broadcast/EQUIPMENT_SHOPPING_LIST.md) · [OBS template — no green screen](../../docs/broadcast/OBS_TEMPLATE_NO_GREENSCREEN.md)

**Import scenes:** `bash tools/obs/install_clipzworld_obs.sh` (macOS) → OBS → Scene Collection **ClipzWorld-Live**

## Show flow (no “starting soon” loop)

**Desk order:** News → Sports → Streamers (Twitch Soup).

### Daily prep — comps + live + YouTube (one clip set, three outputs)

| Step | Action |
|------|--------|
| 1 | **Generate → News / Sports / Streamers** — pick 4 clips each → **Comp** (platform modal: YT + TikTok + IG — all checked by default) |
| 2 | Review job cards — **News/Sports:** comp + SEO OK for prep; **do not publish raw fetched clips** (ESPN/news → Content ID). **Streamers:** publish comp when Gate 5 ready (no hold). |
| 3 | **Broadcast → Operator live show** — confirms 3/3 desks; **Open rundown** for OBS MP4 URLs (same source clips, landscape in CLIP scene) |
| 4 | **Twitch live** — full recording with Succession open / Party 4 U outro (Twitch-only music) |
| 5 | **YouTube long-form** — `tools/yt_cut.sh` on local OBS file between `YT_START` and `YT_END` (music stripped) |
| 6 | **After live** — news/sports: cut **portrait segment from Twitch VOD** (host on camera reacting to clips — transformative, same role avatar played) → Drive URL → **🔓 RELEASE POST-LIVE PUBLISH** → **APPROVE & PUBLISH** (reuse SEO from comp card) |

### Why news/sports publish is held (streamers are not)

| Desk | Raw comp publish | Why |
|------|------------------|-----|
| **Streamers** | ✓ OK | Twitch creator clips — co-stream / reaction format; platform norms; no third-party broadcast feed. |
| **News / Sports** | ✗ Held | Clips pulled from news wires or game highlights get **copyright / Content ID** on YT, TikTok, IG if uploaded as-is. |
| **Fix** | After live | The **Twitch show** is you reacting on camera to those same clips in OBS — that recording is **your** show. Publish **that** cut (portrait crop from VOD), not the pre-live fetched-clip MP4. |

Comp job still matters: same clip URLs for OBS rundown, assembly QA, and **SEO metadata** — only the **video file at publish** swaps to the live-reaction cut.

Rundown page: `/assets/broadcast/live_show_rundown.html` · API: `GET /live-show/rundown`

| Order | OBS scene | Video | Audio |
|-------|-----------|-------|-------|
| 1 | `OPEN_LEAD` | Dark lead slate (optional, ~5s) | **Open theme** starts (Media Source) |
| 2 | `OPEN_STING` | Browser: `open_sting.html?desk=news` | Same theme continues |
| 3 | `HOST` | **Camera on** · mic hot | Theme **duck** or stop · cold open |
| 4 | `DESK_NEWS` ↔ `CLIP` | News block (~50 min) | — |
| 5 | `BUMPER_SPORTS` | `desk_bumper.html?desk=sports` | Short sting / bed |
| 6 | `DESK_SPORTS` ↔ `CLIP` | Sports block (~40 min) | — |
| 7 | `BUMPER_STREAMING` | `desk_bumper.html?desk=streaming` | Short sting / bed |
| 8 | `DESK_STREAMING` ↔ `CLIP` | Streamers block (~50 min) | — |
| 9 | `MONTAGE_END` | Optional MP4 + overlay | Bed music |
| 10 | `OUTRO_STING` | `outro_sting.html` | **Outro music** |

Advance scenes with hotkeys (F1–F5). Do **not** leave a looping slate on air before the show.

## Browser source URLs

| File | URL (localhost) |
|------|-------------------|
| **Host backdrop (no green screen)** | `/assets/broadcast/obs/host_backdrop.html?desk=news` |
| Host backdrop — sports | `…/host_backdrop.html?desk=sports` |
| Host backdrop — streamers | `…/host_backdrop.html?desk=streaming` |
| Lower third (segment title) | `…/host_lower_third.html?desk=news&title=Your+headline` |
| LIVE bug (top-right) | `…/live_bug.html` |
| BRB slate | `…/brb_slate.html` |
| Open lead (music only visual) | `/assets/broadcast/obs/open_lead.html` |
| Open sting (default = news first) | `/assets/broadcast/obs/open_sting.html?desk=news` |
| Open sting (streaming block) | `/assets/broadcast/obs/open_sting.html?desk=streaming` |
| Desk bumper (between blocks) | `/assets/broadcast/obs/desk_bumper.html?desk=sports` |
| Outro | `/assets/broadcast/obs/outro_sting.html?show=TWITCH%20SOUP` |
| Montage overlay | `/assets/broadcast/obs/montage_end.html` |

Browser source size: **1920×1080**. Check **Refresh browser when scene becomes active**.

## Music files

OBS does not load music from these HTML files. Add **Media Source** (or **VLC Video Source** audio-only) per scene:

1. Create folder `~/ClipzWorld/obs/music/`
2. Add **broadcast-licensed** tracks only (see below):
   - `show_open.mp3` — open + cold open (30–90s usable segment)
   - `show_outro.mp3` — 20–45s outro
   - `desk_sting.mp3` — optional 3–5s hit between News / Sports / Streamers
   - `montage_bed.mp3` — optional under end montage
3. In OBS **Edit → Advanced Audio Properties**: music on **Track 2**, mic on **Track 1**; duck or mute Track 2 on `HOST` / desk scenes when talking.

### ⚠️ Succession theme (SoundCloud link)

The [Succession main title](https://soundcloud.com/nicholasbritell/succession-main-title-theme-3) is **copyrighted** (Nicholas Britell / HBO). A SoundCloud upload is **not** a license to use it on **Twitch live** or **YouTube VOD** — expect Content ID claims, muted VOD, and DMCA risk on the exact recording.

**Do not** stream that track unless you have a **sync license** for online broadcast.

**Safe paths for the same vibe:**

| Option | How |
|--------|-----|
| **Epidemic Sound** (already in stack — `assets/audio/`) | Search: *dramatic orchestral*, *corporate tension*, *news theme*, *succession style* → download MP3 → rename `show_open.mp3` |
| **Artlist / Musicbed** | Same — filter orchestral / cinematic news openers |
| **Commission** | Short custom sting in that harmonic world (~30s) |

**Once you have a licensed MP3:**

1. Save as `~/ClipzWorld/obs/music/show_open.mp3`
2. OBS → `OPEN_LEAD` or `OPEN_STING` → Add Source → **Media Source** → browse file
3. Uncheck **Loop** · check **Restart playback when source becomes active**
4. Advanced Audio → set volume (~−8 to −12 dB under voice when ducked)
5. Use **only** the first 60–90s for open; fade out when switching to `HOST`

**Getting audio from SoundCloud in general:** only if the uploader enabled **Download** on an track **you are licensed to use**. For third-party TV themes, that is almost never true. Browser playback in OBS (Browser Source → SoundCloud URL) still sends the copyrighted audio to Twitch/YouTube and has the same claim risk — avoid.

**Technical extract (licensed files only):** if you own the file, drag MP3 into the folder above. Do not use `yt-dlp` on SoundCloud for copyrighted TV themes for broadcast.

## Scene build (quick)

### `OPEN_LEAD`
- Color Source `#060a12` **or** Browser → `open_lead.html`
- Media Source → `show_open.mp3`, restart on activate, **no loop**

### `OPEN_STING`
- Browser → `open_sting.html?desk=news` (1920×1080) — show opens on **news**; order is News → Sports → Streamers
- Same `show_open.mp3` if continuing — uncheck restart so music does not restart mid-sting

### `HOST`
- Video Capture Device (camera) — **not** in open scenes = “lights on” moment
- Logo + lower third
- Mic filters: noise suppression

### `MONTAGE_END`
- **Bottom:** Media Source → `montage.mp4` when you have one (loop once)
- **Top:** Browser → `montage_end.html` (vignette + title)
- Optional: `montage_bed.mp3` at −15 dB

### `OUTRO_STING`
- Browser → `outro_sting.html`
- Media Source → `show_outro.mp3`

## Timing cues

- **Open sting:** ~10s animation; switch to `HOST` at ~8–10s (when fade to black starts) or when music hits the drop.
- **Outro:** ~13s then black; stop stream after fade.

Replace `CW` logo mark in HTML with an Image source using `assets/cwn_logo.png` when you prefer the real logo on camera scenes only.
