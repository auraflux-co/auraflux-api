# Clip Comp Creative Modes — Shorts + VOD Spec

**Created:** 2026-06-24  
**Status:** DRAFT — implementation plan (CPD ticket TBD)  
**Scope:** Dashboard Generate pillar (Twitch / News / Sports), `/generate-clip-comp`, assembly + publish  
**Competitor basis:** Gemini visual bench `logs/competitor_visual_bench.json` (Stream Serpent, DahBluh, core_fx, imgoochy, RickClipit)

---

## 1. Problem

Today every **Comp** / **Short** from Generate uses one locked template (`clip_comp_template.js` golden reference):

- Blur-pad 9:16, logo in top blur fold  
- Hook Machine burned hooks in sharp zone  
- Whisper phrase captions in bottom blur  
- Plain concat + crossfade (twitch); editorial timeline **only** sports/news  
- No ranked-list overlay, no music bed, no cut SFX on twitch comps  
- **VOD** from Twitch Generate = avatar script path (HeyGen), not edited comp VODs like DahBluh/RickClipit  

Operators cannot pick “Stream Serpent ranked list” vs “Classic ClipzWorld blur-pad” at click time. Features exist in repo but are env-gated or content-type-gated.

---

## 2. Goals

1. **One creative profile per job** — stored on `jobSpec.designSpec.compCreative`, visible in UI before Generate.  
2. **Presets** map to competitor patterns; **Advanced** exposes individual toggles.  
3. **Same clip lineup** can produce Short, Comp Short, or Comp VOD with different profiles.  
4. **VOD funnel:** Short discovery → Related Video → 8–20 min comp VOD (not raw multi-hour DVR as primary).

---

## 3. What Generate does today (baseline)

### Twitch pillar buttons

| Button | API / path | Output | Creative (fixed today) |
|--------|------------|--------|-------------------------|
| **Generate VOD** | `callFullScriptServer('twitch')` → HeyGen → long assembly | 16:9 avatar VOD (`twitch` long) | News chrome / split-screen clips + Bobby G |
| **Top 10** | Same + `scriptVariant: 'top10'` | Avatar VOD, countdown script | Scripted NUMBER ONE… ten structure |
| **Short** | `POST /generate-clip-comp` (1 clip) | `twitch-short` | Blur-pad comp template, 1 clip |
| **Comp** | `POST /generate-clip-comp` (4 clips) | `twitch-short` | Blur-pad, 4 hooks, whisper, concat |

### News / Sports pillar

| Button | Output | Extra vs twitch |
|--------|--------|-----------------|
| **Comp** | `news-short` / `sports-short` | Editorial timeline **if** `CLIP_COMP_EDITORIAL=on`: intro card, TTS bridges, stings, outro |

### Post-live pillar

| Button | Output | Notes |
|--------|--------|-------|
| **CLIPS COMP** | `twitch-short` from YouTube VOD segments | Same comp template; 1+ segments |

### Env-only toggles (no UI)

| Env | Effect |
|-----|--------|
| `CLIP_COMP_EXPERIMENT=1` | Grade/vignette/grain/@handle badge (`clip_comp_transform`) |
| `CLIP_COMP_EDITORIAL=on` | Sports/news editorial timeline (default on) |
| `CAPTIONS_SHORTS` | Whisper burn (default on) |
| `FINAL_LOUDNORM` | EBU loudnorm (default on) |

---

## 4. Creative profile schema (`designSpec.compCreative`)

Stored on job spec + job card; passed through `/generate-clip-comp` → `/assemble`.

```js
compCreative: {
  preset: 'classic_blur_pad' | 'full_bleed' | 'ranked_list' | 'dahbluh_clean' | 'serpent_ranked' | 'custom',
  presetVersion: 1,

  layout: {
    mode: 'blur_pad' | 'full_bleed_crop',  // full_bleed = scale+crop 1080x1920, no blur bands
    logo: 'top_blur_fold' | 'corner' | 'off',
  },

  hooks: {
    mode: 'hook_machine' | 'whisper_only' | 'both',  // both = default today
    rankedList: {
      enabled: false,
      streamer: '',           // e.g. "Lacy"
      theme: 'FUNNIEST',      // FUNNIEST | AURA | CORE | FAN_MAIL | custom string
      slotCount: 5,           // overlay shows 1..N; comp may use 4 clips → highlight active slot
      titlePattern: 'WAIT_FOR_NO_1',  // youtube title template id
    },
  },

  captions: {
    whisper: true,
    style: 'phrase_bottom_blur' | 'phrase_full_bleed' | 'word_karaoke',
    // phrase_* = today; word_karaoke = future ASS per-word highlight (DahBluh)
  },

  audio: {
    clipAudio: true,
    musicBed: 'off' | 'low_trap' | 'neutral_lofi',  // continuous under clip audio
    musicBedVolume: 0.18,
    cutSfx: 'off' | 'whoosh' | 'impact' | 'serpent_pack',
    duckSpeech: true,
  },

  editorial: {
    enabled: false,  // true → intro/bridge/outro timeline (sports/news today; extend to twitch VOD)
    introCard: false,
    ttsBridges: false,
  },

  effects: {
    transform: false,  // CLIP_COMP_EXPERIMENT grade/grain
    gagOverlays: false, // core_fx stickers — off by default; manual/asset pack later
  },

  delivery: {
    format: 'short' | 'vod_comp',     // NEW: same assembly, different target duration + publish
    vodTargetMin: 8,
    vodTargetMax: 20,
    relatedVideoParentId: null,       // Short → link to this VOD video id at publish
    playlistSeries: null,             // e.g. "Ranking Lacy Funniest Moments"
  },
}
```

**Preset defaults**

| Preset | layout | rankedList | captions | musicBed | cutSfx | editorial | delivery |
|--------|--------|------------|----------|----------|--------|-----------|----------|
| `classic_blur_pad` (today) | blur_pad + logo fold | off | phrase_bottom_blur + hooks | off | off | off | short |
| `full_bleed` | full_bleed_crop, logo corner | off | phrase_full_bleed + hooks | off | off | off | short |
| `serpent_ranked` | full_bleed | on (5 slots) | phrase + hooks | low_trap | serpent_pack | off | short |
| `dahbluh_clean` | full_bleed | off | phrase_full_bleed | off | off | off | short |
| `twitch_comp_vod` | blur_pad or full_bleed | optional | phrase + hooks | low_trap | whoosh | intro+bridges | vod_comp 8–20m |
| `classic_vod` (today Top10/VOD) | avatar longform | script only | avatar segments | show bed | stings in script | HeyGen path | avatar VOD |

---

## 5. UI — Generate pillar “Creative mode” panel

**Location:** Twitch / News / Sports generate column — collapsible **CREATIVE MODE** above action buttons (remember last choice in `localStorage` key `cwn.compCreative.v1`).

### 5.1 Preset dropdown (primary control)

```
CREATIVE MODE
┌─────────────────────────────────────────────┐
│ Preset: [ Classic ClipzWorld (blur-pad)  ▼] │
│                                             │
│ Preview chips (read-only):                  │
│  [blur-pad] [hooks] [whisper] [no bed]      │
└─────────────────────────────────────────────┘
```

Presets:

1. **Classic ClipzWorld** — today’s default  
2. **Full bleed (imgoochy / core_fx)** — crop, no blur bands  
3. **Ranked list Short (Stream Serpent)** — overlay + bed + cut SFX  
4. **Clean comp (DahBluh Short)** — full bleed, whisper, no bed  
5. **Comp VOD (8–20 min)** — extended timeline + optional ranked theme  
6. **Custom** — enables Advanced toggles  

### 5.2 Advanced (when Custom or “Edit preset…”)

| Toggle | Maps to |
|--------|---------|
| Layout: Blur-pad / Full bleed | `layout.mode` |
| Logo: Top fold / Corner / Off | `layout.logo` |
| Ranked list overlay | `hooks.rankedList.enabled` + streamer + theme fields |
| Hook captions (Hook Machine) | `hooks.mode` |
| Whisper dialogue captions | `captions.whisper` |
| Caption style: Phrase / Word karaoke | `captions.style` |
| Music bed | `audio.musicBed` |
| Cut SFX on clip changes | `audio.cutSfx` |
| Editorial intro/bridges (VOD) | `editorial.*` |
| Output: **Short** / **Comp VOD** | `delivery.format` |

### 5.3 Per-button behavior (what gets sent)

| Button | Uses lineup? | Default preset | Overrides |
|--------|--------------|----------------|-----------|
| **Short** | No (selected clips → 1 job each) | User preset; force `delivery.format=short`, 1 clip |
| **Comp** | Yes (COMP LINEUP 1–4) | User preset; 4 clips; short |
| **Generate VOD** | Yes (picker clips → script) | **Avatar VOD** preset (unchanged HeyGen path) OR if user chose **Comp VOD** preset → new `/generate-clip-comp-vod` |
| **Top 10** | Yes | Avatar Top10 script OR optional future **Ranked comp VOD** |

**Status line after pick:**  
`Comp · Serpent ranked · 4 clips · full bleed · bed+SFX · ~45s`

**Queue / job card badge:**  
`creative: serpent_ranked` + chip row matching preset.

### 5.4 Wire to API

Extend `POST /generate-clip-comp` body:

```json
{
  "clips": [...],
  "contentType": "twitch-short",
  "compCreative": { "...schema above..." },
  "platforms": ["youtube", "tiktok", "instagram"]
}
```

Server merges into `buildClipCompDesignSpec()` → `designSpec.compCreative`. Assembly reads profile; no silent env overrides unless `compCreative` absent (backward compat → `classic_blur_pad`).

---

## 6. Pipeline implementation map

### 6.1 Layout (`layout.mode`)

| Mode | FFmpeg (per clip segment) | Where |
|------|---------------------------|--------|
| `blur_pad` | Existing clip-comp scale decrease + blurred bg + logo fold | `assembly.js` clip-comp branch |
| `full_bleed_crop` | `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920` | Same branch; flag from `compCreative` |

Portrait-native Twitch clips: auto-detect `orientation=portrait` → prefer full_bleed even on classic preset (optional smart default).

### 6.2 Ranked list overlay (`hooks.rankedList`)

**New module:** `lib/clip_comp_ranked_overlay.js`

- PNG template or FFmpeg drawbox + drawtext layers  
- Header: `RANKING {STREAMER} {THEME} MOMENTS`  
- Left column 1–5; active slot highlighted per clip index  
- Burned for full comp duration OR per-clip segment (Serpent: whole short shows list while clips play)

**Title templates:** `lib/clip_comp_titles.js` — `WAIT_FOR_NO_1`, `NO_1_IS_THE_FUNNIEST`, etc.

### 6.3 Captions

| Style | Today | Work |
|-------|-------|------|
| `phrase_bottom_blur` | Whisper SRT → `_normalizeClipCompSrt` → libass bottom margin | Default |
| `phrase_full_bleed` | Same, larger margin / center-bottom | Config flag |
| `word_karaoke` | **New:** Whisper `verbose_json` word timestamps → ASS `\k` tags or drawtext sequence | Phase 2 |

**Whisper vs word-by-word (operator FAQ):**  
Whisper = **subtitle phrases** (1–2 lines per cue). Word-by-word = **animated one-word-at-a-time** (DahBluh). Same transcription; different render pass.

### 6.4 Audio bed + cut SFX

**New module:** `lib/clip_comp_audio_mix.js`

Assets (reuse editorial stings dir):

- `assets/audio/beds/low_trap_instrumental.mp3` (add licensed file)  
- Cut SFX: reuse `neutral_whoosh`, add `impact_short.mp3`

Assembly concat step:

1. Per-clip boundaries: mix in 0.3s SFX  
2. Full timeline: `amix` clip audio + bed at `musicBedVolume`, sidechain duck on speech  

Gate when `compCreative.audio.musicBed !== 'off'`.

**Today:** stings only on sports/news editorial bridges (`clip_comp_cards.js`) — extend same asset map to twitch concat.

### 6.5 Editorial timeline on twitch VOD comps

Enable `assembleClipCompEditorialTimeline` when:

- `compCreative.delivery.format === 'vod_comp'` OR  
- `compCreative.editorial.enabled === true`

Extend `isEditorialContentType()` to include `twitch` when editorial flag set.

VOD comp structure (DahBluh model):

```
[intro card 2.5s] → [clip 1 + hook] → [bridge sting] → … → [clip N] → [outro card]
Target 8–20 min: either more clips (up to 12) or longer clip trims — picker sends `clipCount` + `targetDurationMin`.

### 6.6 Publish funnel

When `delivery.format === 'short'` and job is part of a series:

- Publish step sets YouTube **Related Video** → parent VOD id (`delivery.relatedVideoParentId`)  
- Playlist: `delivery.playlistSeries`

**UI flow:** Generate **Comp VOD** first → copy video id → generate **Ranked Shorts** with “Link to VOD” prefilled.

---

## 7. VOD strategy (competitor-aligned)

### What works (from bench)

| Channel | Shorts role | VOD role |
|---------|-------------|----------|
| **Stream Serpent** | Ranked multi-clip Shorts only | None |
| **DahBluh** | Hashtag Shorts, single moments | **8–12m FaZe comp** — primary sub driver |
| **RickClipit** | Drama Shorts | **10–15m Cinna comps** — context binge |
| **imgoochy** | Full-bleed moment Shorts | Separate drama serial (different lane) |
| **ClipzWorld today** | Comps + raw clips | **Multi-hour live DVR** — wrong funnel |

### Recommended product split

| Product | Format | Creative preset | Generate entry |
|---------|--------|-----------------|----------------|
| **Discovery Short** | 15–60s | `serpent_ranked` or `full_bleed` | Comp (4 clips) or Short (1 clip) |
| **Comp VOD** | 8–20m edited | `twitch_comp_vod` + editorial | **New: Comp VOD** button (or VOD + preset) |
| **Avatar show VOD** | 20–45m | Existing HeyGen | Generate VOD / Top 10 (keep) |
| **Live DVR** | 2–7h | Unchanged | Broadcast / live grid only — **not** default YT upload |

### Weekly operator loop

1. Pick 8–12 clips on pillar → **Comp VOD** (edited, themed title e.g. “FaZe Boys Funniest This Week”).  
2. Pull best 4 → **Serpent ranked Short** with Related Video → step 1 VOD.  
3. Pull 4 more singles → **Full bleed Shorts** (1 clip each) same Related Video.  
4. Community tab poll → next theme (feeds `rankedList.theme`).

### Top 10 alignment

- **Today:** Top 10 = avatar script countdown (long VOD).  
- **Future option:** Top 10 **ranked Short series** (5 Shorts × #5–#1) + 1 comp VOD — matches Stream Serpent + DahBluh funnel without replacing avatar shows.

---

## 8. Phased delivery

### Phase 1 — Config + UI shell (no new FFmpeg)

- [ ] `compCreative` schema on `buildClipCompDesignSpec`  
- [ ] Dashboard preset dropdown + localStorage  
- [ ] Pass `compCreative` in `_dispatchClipCompFromPicker` / `_dispatchClipShort`  
- [ ] Job card shows active preset chips  
- [ ] Docs + Jira CPD ticket  

### Phase 2 — Layout + audio (highest ROI)

- [ ] `full_bleed_crop` layout flag  
- [ ] `clip_comp_audio_mix.js` — bed + cut SFX  
- [ ] Presets `full_bleed`, `serpent_ranked` (without overlay)  

### Phase 3 — Ranked list overlay

- [ ] `clip_comp_ranked_overlay.js` + title templates  
- [ ] Serpent preset complete  
- [ ] Gemini QA gate checks overlay readable  

### Phase 4 — Comp VOD + funnel

- [ ] `delivery.format: vod_comp` — extended clip count / duration  
- [ ] Editorial timeline for twitch VOD comps  
- [ ] `POST /generate-clip-comp-vod` or same endpoint with `contentType: twitch-vod-comp`  
- [ ] Publish: Related Video + playlist series fields  
- [ ] **Comp VOD** button on Twitch pillar  

### Phase 5 — Word karaoke + gag overlays (optional)

- [ ] Whisper word-level ASS  
- [ ] Sticker pack for core_fx-style FX (low priority)  

---

## 9. Testing

- Unit: preset → `designSpec.compCreative` merge (`test/clip_comp_creative.test.js`)  
- Snapshot: FFmpeg filter string per layout mode  
- Visual: Gate 3a prompts include ranked overlay when enabled  
- E2E: Comp with `serpent_ranked` → private YT upload → manual check Related Video  

---

## 10. Open decisions (Rob)

1. Default preset for **Comp** button: stay `classic_blur_pad` or switch to `serpent_ranked` after Phase 3?  
2. **Comp VOD** as separate button vs mode on **Generate VOD**? (Spec recommends separate button + keep avatar VOD.)  
3. Licensed music bed source: Epidemic paths already in `assets/audio/` — pick one default track.  
4. Ranked overlay: 5 slots always vs match clip count (4 clips + “#1 tease”)?  

---

## 11. References

- `lib/clip_comp.js` — designSpec contract  
- `lib/clip_comp_template.js` — golden blur-pad reference  
- `lib/assembly_postprocess.js` — Whisper captions  
- `lib/clip_comp_editorial.js` — sports/news timeline + stings  
- `logs/competitor_visual_bench.json` — Gemini visual analysis  
- `scripts/competitor_visual_bench.js` — re-run competitor review  
