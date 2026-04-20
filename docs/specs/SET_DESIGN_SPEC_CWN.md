# SET_DESIGN_SPEC_CWN.md

**Author:** Claude Code
**Last updated:** 2026-04-17
**Status:** Ground-truth spec. Compare any rendered MP4 against this doc to identify gaps.
**Scope:** All three CWN long-form 16:9 shows — News, Twitch, NBA. One chrome engine, three brand skins.

---

## 1. Vision

One broadcast set. Three shows. The chrome template (`tools/clipzworld_newscast.html`) is identical across all three content types. The only differences per show are brand colors, show name, and sidebar card content. Everything else — layout, positions, visibility rules, Puppeteer pipeline, FFmpeg burn — is shared.

**Shows:**
| Content Type | Show Name | Primary | Accent | Red |
|---|---|---|---|---|
| `news` | BECAUSE THE LIGHT WAS ON | `#22304b` | `#c7af4f` / `#f0d060` | `#C0392B` |
| `twitch` | TALK SOUP | `#6441A5` | `#7d5bbe` | `#6441A5` |
| `nba` | OTHER SIDE OF THE PILLOW | `#17408B` | `#1a4fa8` | `#C9082A` |

News is the default skin hardcoded in the HTML. Twitch and NBA colors are injected at render time via `page.evaluate()` in `generateNewscastOverlay()`.

---

## 2. Frame (all shows)

| Property | Value |
|---|---|
| Resolution | 1920×1080 |
| Frame rate | 30 fps |
| Aspect | 16:9 |
| Container | MP4 (H.264 video, AAC audio) |
| Audio | 2-channel AAC, 44.1 kHz, loudnorm I=-14 TP=-1.5 LRA=11 |
| Color space | yuv420p |
| Encoder preset | libx264 -preset fast -crf 23 -g 30 -keyint_min 30 -sc_threshold 0 |
| Chrome background | Transparent PNG composited over avatar/clip via FFmpeg overlay |
| Coordinate origin | Top-left (0,0) |
| Broadcast safe zone | 60px from each edge |

Bobby G avatar faces viewer's LEFT. His head occupies roughly y=120 to y=720. No chrome element may overlap his face.

---

## 3. Shared Chrome Elements (all shows, identical layout)

### 3.1 Flag (top-left)

**Purpose:** Identifies the active story/streamer/game. Category label top row, title/name bottom row.

**Coordinates:**
- Position: x=0, y=0
- Width: ~620px
- Height: ~88px (two text rows + padding)

**Visual style:**
- Top row: gold accent background, category text (e.g. "WORLD NEWS" / "ON STREAM" / "NBA GAME"), 14px
- Bottom row: navy background, white text 28px semi-bold, left gold border 4px

**When visible:**
| Scene type | flag.visible |
|---|---|
| COLD_OPEN | `false` |
| STORY/STREAMER/GAME INTRO | `true` |
| STORY/STREAMER/GAME BODY scenes | `true` |
| SOURCE_CLIP | `false` |
| OUTRO | `false` |

---

### 3.2 Sidebar (right side)

**Purpose:** Vertical list of all stories/streamers/games with the active one highlighted "▶ ON AIR."

**Coordinates:**
- Position: top=120px, right=32px
- Width: 420px

**Visual style:**
- Each card: navy background, gold left border 4px, min-height 90px
- Active card: red left border 5px, brighter background, "▶ ON AIR" badge

**When visible:**
| Scene type | sidebar.visible |
|---|---|
| COLD_OPEN | `false` |
| INTRO / BODY scenes | `true` |
| SOURCE_CLIP | `false` |
| OUTRO | `false` |

**Cap:** 5 cards maximum displayed.

---

### 3.3 Top bar (always on)

**Coordinates:** x=0, y=0, full width, height=48px
**Content:** Episode number left + show name center + LIVE badge + date right
**When visible:** Always (every scene).

---

### 3.4 Ticker (bottom, always on)

**Coordinates:** x=0, y=1016, width=1920, height=64px
**When visible:** Always (every scene including SOURCE_CLIP).
**Cache TTL:** 1 hour.

---

### 3.5 Logo (always on)

**When visible:** Always (every scene).
**Asset:** `assets/cwn_logo.png`
**Position:** Per-show — see show-specific sections below.

---

### 3.6 Source clip framing

**Target:** 1920×1080 fill, zoom-to-fill crop, no letterbox/pillarbox bars.
**Filter chain:**
```
scale=w='if(gt(a,16/9),-2,1920)':h='if(gt(a,16/9),1080,-2)',crop=1920:1080,fps=fps=30
```
**No chrome on source clips:** flag, sidebar all hidden. Ticker and logo persist.

---

## 4. News — Per-Show Spec

**Show name:** BECAUSE THE LIGHT WAS ON
**Colors:** Navy `#22304b` / Gold `#c7af4f` / Red `#C0392B` (default in HTML, no override needed)

### 4.1 Flag content
- Top label: "WORLD NEWS" (or source outlet e.g. "AL JAZEERA")
- Bottom text: story headline, sentence case, max 2 lines

### 4.2 Sidebar card content
- Category label: "WORLD NEWS" or "▶ ON AIR"
- Title: story headline
- Fact: source outlet (optional second line)

### 4.3 Logo position
- `LOGO_POS_NEWS`: x=1725, y=910, size=90px, opacity=0.85
- Sits on Bobby G's coffee mug, bottom-right of desk

### 4.4 Watermark mask (Al Jazeera source clips)
- Navy drawbox at x=1710, y=900, w=210, h=180 on source clips
- Masks Al Jazeera bottom-right logo; logo burn covers left edge of box

### 4.5 Source clip rules
- Skip first 5s of every clip (Al Jazeera intro branding)
- Hard cap: 25s
- Silence detection trims earlier if found

### 4.6 Scene structure
`1 COLD_OPEN + (N stories × 5 scenes) + 1 OUTRO`
Per story: INTRO → SETUP → SOURCE_CLIP → SUMMARY → REACTION

### 4.7 Chrome state matrix
| Scene type | Flag | Sidebar |
|---|---|---|
| COLD_OPEN | ❌ | ❌ |
| STORY_INTRO | ✅ | ✅ |
| STORY_SETUP | ✅ | ✅ |
| SOURCE_CLIP | ❌ | ❌ |
| STORY_SUMMARY | ✅ | ✅ |
| STORY_REACTION | ✅ | ✅ |
| OUTRO | ❌ | ❌ |

---

## 5. Twitch — Per-Show Spec

**Show name:** TALK SOUP
**Colors:** Purple `#6441A5` / `#7d5bbe` / `#6441A5` (injected via skin map in `generateNewscastOverlay()`)

### 5.1 Flag content
- Top label: "ON STREAM"
- Bottom text: streamer display name (e.g. "JAY CINCO"), all caps

### 5.2 Sidebar card content
- Category label: "ON STREAM" or "▶ ON AIR"
- Title: streamer display name
- Fact: origin (e.g. "Chicago, IL") + fun fact if fits on one line

### 5.3 Logo position
- `LOGO_POS`: x=80, y=10, size=100px (top-left, no opacity reduction)

### 5.4 Source clip rules
- Zoom-to-fill with `crop=1880:1040` (strips 20px each edge, removes baked-in OBS border bars)
- No intro skip, no hard duration cap beyond assembly defaults

### 5.5 Scene structure
`1 INTRO + (N streamers × 7 scenes) + 1 OUTRO`
Per streamer: INTRO → CLIP_1 → REACTION_1 → CLIP_2 → REACTION_2 → CLIP_3 → REACTION_3

### 5.6 Chrome state matrix
| Scene type | Flag | Sidebar |
|---|---|---|
| COLD_OPEN | ❌ | ❌ |
| STREAMER_INTRO | ✅ | ✅ |
| REACTION scenes | ✅ | ✅ |
| SOURCE_CLIP | ❌ | ❌ |
| OUTRO | ❌ | ❌ |

---

## 6. NBA — Per-Show Spec

**Show name:** OTHER SIDE OF THE PILLOW
**Colors:** Blue `#17408B` / `#1a4fa8` / Red `#C9082A` (injected via skin map)

### 6.1 Flag content
- Top label: "NBA GAME"
- Bottom text: matchup (e.g. "LAKERS VS CELTICS"), all caps

### 6.2 Sidebar card content
- Category label: "NBA GAME" or "▶ ON AIR"
- Title: matchup label (e.g. "Lakers vs Celtics")
- Fact: final score or "LIVE" if in progress

### 6.3 Logo position
- `LOGO_POS`: x=80, y=10, size=100px (top-left, no opacity reduction)

### 6.4 Voiceover pipeline (NBA only — key difference from News and Twitch)

NBA is live narration over highlights. Bobby G talks WHILE the ESPN clip plays — his audio is mixed over the muted clip video. This is fundamentally different from News/Twitch where avatar and source clip are separate sequential segments.

**Audio mix per game:**
- Clip native audio: muted (0.0 volume)
- Bobby G narration: full volume (1.0)
- Background music bed from `assets/audio/`: 0.20 volume

**Implementation:** `orchestrateNBAVoiceoverVectCut()` via VectCutAPI (port 9001). See `CLINE_HANDOFF_NBA_VECTCUT_VOICEOVER.md` for full spec.

**Fallback:** If VectCutAPI is down or music tracks missing, falls back gracefully — narration-only or original clip. Never hard fails assembly.

**Music tracks:** Rob drops `.mp3`/`.wav` files into `assets/audio/`. Selected randomly per episode.

### 6.5 Source clip rules
- Zoom-to-fill `crop=1920:1080` (ESPN clips are clean, no border trim needed)
- No intro skip
- Clip plays full duration — NOT truncated to narration length

### 6.6 Scene structure
`1 INTRO + (N games × 4 scenes) + 1 OUTRO`
Per game: INTRO → NARRATION → SOURCE_CLIP → REACTION

Note: NARRATION segment is avatar audio only — video is discarded. The NARRATION audio gets mixed onto the SOURCE_CLIP video by the voiceover pipeline.

### 6.7 Chrome state matrix
| Scene type | Flag | Sidebar |
|---|---|---|
| COLD_OPEN | ❌ | ❌ |
| GAME_INTRO | ✅ | ✅ |
| NARRATION | ✅ | ✅ |
| SOURCE_CLIP | ❌ | ❌ |
| REACTION | ✅ | ✅ |
| OUTRO | ❌ | ❌ |

---

## 7. Implementation files

| File | Purpose |
|---|---|
| `tools/clipzworld_newscast.html` | Single chrome HTML template for all three shows |
| `lib/chrome_overlay.js` → `generateNewscastOverlay()` | Puppeteer renderer — injects skin, story data, flag visibility |
| `lib/assembly.js` | Burns chrome PNGs onto avatar segments via FFmpeg overlay filter |
| `lib/config.js` → `LOGO_POS` / `LOGO_POS_NEWS` | Logo position constants per show |

---

## 8. Acceptance criteria (set locked)

A set is locked when all of the following pass on two consecutive smoke tests:

1. Flag appears on every INTRO/BODY avatar scene with correct content. Hidden on COLD_OPEN, SOURCE_CLIP, OUTRO.
2. Sidebar appears on every INTRO/BODY avatar scene with correct cards, active highlight matching current story/streamer/game. Hidden on COLD_OPEN, SOURCE_CLIP, OUTRO.
3. Source clips fill 1920×1080 edge-to-edge, no bars.
4. Ticker visible at bottom of every scene.
5. Logo visible at correct position for the show.
6. Top bar shows correct show name and episode number.
7. No chrome elements overlap Bobby G's face.
8. No fixture/placeholder data in any rendered frame.
