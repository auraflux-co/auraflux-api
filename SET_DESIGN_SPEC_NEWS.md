# SET_DESIGN_SPEC_NEWS.md

**Author:** Claude Code, drafted 2026-04-14
**Status:** Forward spec — describes how the News set SHOULD operate. Not an audit of current state. Use this doc as the ground-truth marker; compare any rendered MP4 against it to identify gaps.
**Scope:** ClipzWorld News long-form 16:9 broadcast set. Tonight's reference video for first lock: `news_apr_14_*_1776145917760.mp4`.
**Reusability target:** This spec is the **prototype for a portable show-set architecture.** Once News is locked, NBA (`SET_DESIGN_SPEC_NBA.md`), Twitch (`SET_DESIGN_SPEC_TWITCH.md`), and any future show inherit the same element grammar with brand variables swapped. The chrome architecture, Puppeteer overlay engine, FFmpeg burn step, directive schema, and assembly loop are SHARED across all shows. Only the brand variables and per-element variants change.

---

## 1. Vision

### 1.1 What this set is

ClipzWorld News is an AI-generated newscast in the visual language of a CNN/Al Jazeera/BBC broadcast control room: dark navy primary, gold accent, anchor at the desk, lower-third headlines, story sidebar, TV monitor over the anchor's shoulder, news ticker at the bottom, episode badge, network logo. Every element belongs in a real broadcast. Nothing belongs in a YouTube tutorial.

### 1.2 Why it matters for the broader product

The News set is the prototype for the **AuraFlux Set Engine** — the rendering layer that converts a directive script + brand config into a finished broadcast video. Today it powers News only. After lock, the same engine powers NBA highlight shows, Twitch compilation shows, and every customer-tenant show in the eventual SaaS. The set engine is the productized layer beneath every show.

### 1.3 What "locked" means

A locked set is one where:
1. Every element appears at the spec coordinates on every scene where the spec says it should
2. Every element disappears on every scene where the spec says it shouldn't
3. Every element shows the right *content* (not placeholder fixture data, not last week's stories)
4. The same script + brand config produces the same output on every run (deterministic, no stochastic bugs)
5. The directive schema is the only source of variability — changing brand variables changes the visual output, changing nothing changes nothing

If any of those five conditions fails on any scene, the set is not locked.

### 1.4 Show-portability principle

The News set spec below uses concrete values for News-specific decisions (navy/gold palette, "ClipzWorld News" show name, Al Jazeera as the source attribution). When NBA's spec is written, those concrete values become brand variables: `BRAND.primaryHex`, `BRAND.accentHex`, `BRAND.showName`, `BRAND.tickerSource`, `BRAND.flagSource`, `BRAND.episodeNumberFormat`, `BRAND.logoImagePath`, etc. The element layouts, the per-scene visibility rules, the data schema, the burn pipeline — all stay identical across shows. **If a fix to the News set requires touching anything other than brand variables, that fix is a bug in the set engine, not a bug in News.** The whole point of locking News is to prove the set engine is portable.

---

## 2. Frame

| Property | Value |
|---|---|
| Resolution | 1920×1080 |
| Frame rate | 30 fps |
| Aspect | 16:9 |
| Container | MP4 (H.264 video, AAC audio) |
| Audio | 2-channel AAC, 44.1 kHz, loudnorm I=-14 TP=-1.5 LRA=11 |
| Color space | yuv420p |
| Encoder preset | libx264 -preset fast -crf 23 -g 30 -keyint_min 30 -sc_threshold 0 |
| Background | Transparent (composited on the avatar / source clip frame) |
| Coordinate origin | Top-left (0,0) |
| Broadcast safe zone | 60px from each edge |

The anchor (Bobby G) avatar is rendered in the bottom half of the frame, facing viewer's LEFT. Bobby G's head occupies roughly y=120 to y=720, and chrome elements must respect his head/body silhouette — no element overlaps his face.

---

## 3. Element-by-element spec

Each element has: **purpose, coordinates, when visible, data source, schema field, fallback behavior.** All coordinates are in pixels in the 1920×1080 frame.

### 3.1 Lower-third flag (top-left)

**Purpose:** Headline-style chyron banner identifying the active story. Operates like CNN's lower-third "BREAKING NEWS" / "DEVELOPING STORY" bars but positioned top-left rather than bottom-third because the bottom-third is reserved for the anchor.

**Coordinates:**
- Anchor: top-left of frame
- Position: x=0, y=0
- Width: ~620px (auto-sized to text + 40px padding)
- Height: ~88px (two text rows + padding)

**Visual style:**
- Background: navy primary `#22304b`
- Top accent stripe: gold `#c7af4f`, 4px tall, full width
- Top label row: small caps category text in gold (e.g. "WORLD NEWS"), 14px
- Bottom headline row: large white text, 28px, semi-bold

**When visible:**
| Scene type | flag.visible |
|---|---|
| COLD_OPEN (scene_01, intro) | `false` |
| STORY_INTRO (first avatar scene of each story) | `true` |
| STORY_BODY (setup / summary / reaction) | `true` (carries the same flag for the active story) |
| SOURCE_CLIP | `false` (clip plays full-frame, no overlay clutter) |
| OUTRO (final scene) | `false` |

**Data source:** `chrome.flag.text` from the directive (a 2-4 word UPPERCASE punchy summary, e.g. "TRUMP IRAN PEACE", "POPE FEUD ESCALATES"). NOT the full sentence-case headline — that goes in the TV card.

**Schema field:** `ChromeFlagSchema` in `lib/chromeDirectives.js`:
```javascript
{ visible: boolean, text?: string, source?: string, urgencyBadge?: string }
```

**Category label source:** `chrome.flag.source` — the publisher name (e.g. "AL JAZEERA"). Rendered in the top label row in gold.

**Fallback behavior:** None. If `chrome.flag.visible === true` and `flag.text` is missing or empty, that's a hard error. The validator (`validateScript()` in `lib/chromeDirectives.js`) must reject any script that omits `flag.text` on a scene where `flag.visible === true`. **No silent fallback to "Breaking News Story" or any other placeholder.** Empty flag = directive is broken = Gate 1 fails.

### 3.2 Story sidebar (right side)

**Purpose:** Vertical rail showing the full story list for this episode, with the active story highlighted "▶ ON AIR." Operates like a news control room rundown — viewer can see what's coming up next.

**Coordinates:**
- Anchor: right edge of frame
- Position: x=1560, y=400, width=320, height=600
- (Bottom of sidebar at y=1000 leaves room for the ticker which sits at y=1016+)

**Visual style:**
- Background: semi-transparent navy `rgba(34, 48, 75, 0.85)`
- Border: gold `#c7af4f` 2px on the left edge only
- Each story card: 320px wide, ~110px tall, 12px gap between
- Active story card: gold left border accent (4px), white background tint, "▶ ON AIR" badge
- Inactive story cards: navy background, gray text, category label only

**When visible:**
| Scene type | sidebar.visible |
|---|---|
| COLD_OPEN | `false` |
| STORY_INTRO | `true` |
| STORY_BODY (setup / summary / reaction) | `true` |
| SOURCE_CLIP | `false` |
| OUTRO | `false` |

**Data source:** Top-level `storyList[]` array in the directive script. Each entry: `{ index: number, title: string, source: string }`. Order in the array determines display order in the sidebar (top to bottom).

**Active story tracking:** `chrome.sidebar.activeIndex` per scene. The story at that index in `storyList` is the one rendered with the "▶ ON AIR" treatment. All other stories render as inactive.

**Schema field:** `ChromeSidebarSchema`:
```javascript
{ visible: boolean, activeIndex: integer (default 0), cap: integer (default 5) }
```

**`cap` field:** Max stories shown in the sidebar. If `storyList.length > cap`, the sidebar shows the first `cap` entries. Default 5 for News.

**Fallback behavior:** None. If `storyList` is missing, empty, or contains string entries instead of objects, the validator hard-fails Gate 1. **No fixture data in the rendered HTML.** `tools/clipzworld_newscast.html` should NOT contain any hardcoded `<div class="story-item">` placeholder content — the page.evaluate injection is the only source. If the page ships with placeholder stories baked in for design preview purposes, those placeholders must be cleared by the page.evaluate call BEFORE story injection runs (use `storyList.innerHTML = ''` first, then append).

### 3.3 TV card (top-right OVERLAY_ZONE)

**Purpose:** Article image + headline floating in the top-right area like a broadcast "screen over the anchor's shoulder." Visually anchors each story to its source material so the viewer sees the publisher's actual photo, not just hears about it.

**Coordinates:**
- Reference: `CONFIG.VISUAL_LAYOUTS.LONG_FORM.OVERLAY_ZONE` in `lib/config.js`
- Position: **x=1360, y=60, width=520, height=293**
- Aspect: 520÷293 = 1.7748 (exact 16:9)
- Right edge at x=1880 leaves 40px right margin from the 1920px frame edge
- Top edge at y=60 respects the broadcast safe zone

**Visual style:**
- Frame: 5px gold border `#c7af4f`
- Background: deep navy `#0d1424`
- Drop shadow: `0 8px 32px rgba(0,0,0,0.6)`
- Top 75% of card: article image, `object-fit: cover`
- Bottom 25%: headline (white, 18px, bold, max 2 lines, ellipsis overflow) + source label (gold, 12px, uppercase)

**When visible:**
| Scene type | tvCard.visible |
|---|---|
| COLD_OPEN | `false` |
| STORY_INTRO (first avatar scene of each story ONLY) | `true` |
| STORY_BODY (setup / summary / reaction) | `false` (TV card is a "we're starting this story" beat — it doesn't persist) |
| SOURCE_CLIP | `false` (the source clip itself replaces the card visually) |
| OUTRO | `false` |

**Data source:** `chrome.tvCard.imageUrl` from the directive — the og:image URL scraped from the article (existing flow uses `scrapeArticleOgImage()` in server.js). `chrome.tvCard.headline` — full sentence-case headline. `chrome.tvCard.sourceName` — publisher name in title case (e.g. "Al Jazeera").

**Schema field:** `ChromeTvCardSchema`:
```javascript
{ visible: boolean, imageUrl?: string, headline?: string, sourceName?: string }
```

**Fallback behavior:** If `tvCard.visible === true` and `imageUrl` is missing or 404s, the card hides itself entirely (do NOT render with a broken image icon or a placeholder photo). Render the lower-third flag and sidebar normally; just suppress the TV card. Acceptable degraded mode for the rare case where an article's og:image is removed between fetch and render. **Do not fall back to a generic stock image.**

### 3.4 Source clip framing

**Purpose:** Al Jazeera (or future News source) video clips inserted between Bobby G avatar segments. Each story has exactly one clip. Clips play full-frame for ~14-25 seconds with no overlay chrome (flag, sidebar, TV card all hidden).

**Frame target:** 1920×1080 fill. Source clips arrive at varying source dimensions — Al Jazeera publishes both landscape (1920×1080, 1280×720) and portrait (480×854, 720×1280) variants. The set engine must handle both without producing letterbox bars or pillarbox bars.

**Filter behavior:**

| Source dimensions | Behavior |
|---|---|
| Already 1920×1080 | No-op crop (pass through) |
| Landscape, smaller than 1920×1080 (e.g. 1280×720) | Upscale to 1920×1080, no crop needed |
| Landscape, wider than 16:9 (e.g. 2560×1080) | Scale to fill height, crop equal pixels from left/right |
| Landscape, narrower than 16:9 (e.g. 1440×1080) | Scale to fill width, crop equal pixels from top/bottom |
| Portrait (e.g. 480×854 or 720×1280) | Scale to fill width, crop equal pixels from top/bottom — accept that top/bottom of subject may be cropped; this is preferable to navy bars |
| Portrait extreme (e.g. 540×1920) | Same — fill width, crop top/bottom — but flag for review since extreme portrait is rare and may indicate the wrong source variant was downloaded |

**Filter spec:** zoom-to-fill crop. The filter must be **input-aware** so it never tries to crop a frame smaller than the target. Recommended FFmpeg filter chain:

```
scale=w='if(gt(a,16/9),-2,1920)':h='if(gt(a,16/9),1080,-2)',crop=1920:1080
```

This expression scales to fill the target while preserving aspect, then crops to exact 1920×1080. `gt(a,16/9)` checks if input aspect is wider than 16:9; if so scale by height (1080) and let width auto-compute, then crop the wider scaled frame to 1920. If aspect is taller than 16:9, scale by width (1920) and let height auto-compute, then crop the taller scaled frame to 1080. Equivalent to "object-fit: cover" in CSS.

**Frame rate normalization:** All source clips re-encoded to 30 fps (`fps=fps=30`) regardless of source frame rate.

**Watermark mask:** Al Jazeera logo at bottom-right of source clips is masked with a navy box. Coordinates: x=1780, y=960, width=120, height=80, color `#0d1424` (matches the deep navy frame background so the mask reads as intentional broadcast framing, not a redaction). This box is applied AFTER the crop so the coordinates are in the final 1920×1080 frame, not the source frame.

**Intro-branding skip:** Al Jazeera clips often start with 3-5 seconds of branded intro animation. Apply `-ss 5` fast-seek before `-i` in the FFmpeg invocation to skip the first 5 seconds of every News source clip. Effective clip window becomes 5s-30s of the source.

**Hard duration cap:** 25 seconds. If silence detection (`computeNewsClipTrimDuration()`) finds an earlier natural break, trim there instead. Otherwise hard cut at 25s.

**No chrome on source clips:** `flag.visible`, `tvCard.visible`, `sidebar.visible` all `false` for `type === "source_clip"` scenes. The clip plays full-frame. The ticker and logo MAY remain visible per the ticker/logo rules below — those persist across all scene types because they're brand-bug elements, not story-bug elements.

**Fallback behavior:** If the source clip fails to download, fails to normalize, or fails the filter chain, the assembly must **fail loud**: throw an error, mark the assembly as failed, write to `errors.jsonl`, surface in the dashboard with a red banner. **Never silently drop a clip from the concat list and continue.** A News episode without its clips is not a News episode.

### 3.5 Episode number badge

**Purpose:** Show identifier for branding consistency. "EPISODE 14" or similar in a small badge near the show logo.

**Coordinates:** TBD in spec — currently injected via the page.evaluate `episodeNumber` field into a `#show-info` element in `tools/clipzworld_newscast.html`. Recommended position: bottom of the lower-third flag area, x=20, y=110, font 16px gold.

**When visible:** Always (every scene, including COLD_OPEN, SOURCE_CLIP, OUTRO).

**Data source:** `data/episode_counters.json` `news` field, incremented on every successful Gate 6 publish. Read at chrome burn time and passed via context.episodeNumber in `directiveToOverlayParams()`.

**Format:** `Episode {n}` where `{n}` is the integer counter. Show name optional in the badge ("ClipzWorld News • Episode 14").

### 3.6 News ticker (bottom)

**Purpose:** Continuous scrolling headline ticker at the bottom of the frame, broadcast-news style. Pre-rendered separately by Puppeteer once per hour (cached) and burned in via FFmpeg overlay.

**Coordinates:**
- Reference: `CONFIG.TICKER` in `lib/config.js`
- Position: x=0, y=1016 (1080 - 64 = 1016)
- Width: 1920 (full frame width)
- Height: 64 px
- FPS: 30

**When visible:** Always (every scene, including SOURCE_CLIP). Ticker is a brand-bug element, not story-content.

**Data source:** Pre-rendered HTML in `tools/cwn_ticker.html` (or wherever ticker source lives), Puppeteer screenshots it at 1920×64 with 30 fps content scrolling, output cached for 1 hour TTL.

**Cache TTL:** `CONFIG.TICKER.CACHE_TTL_MS = 3600000` (1 hour). Re-rendered when stale.

**Fallback behavior:** If ticker generation fails, the assembly continues without a ticker. Log a warning. Ticker absence is not a hard fail (it's a brand-bug, not story content).

### 3.7 CWN logo (News-specific position)

**Purpose:** Show identity bug. Persistent across all scenes.

**Coordinates (News-specific):**
- Reference: `CONFIG.VISUAL_LAYOUTS.LONG_FORM.LOGO_POS_NEWS` in `lib/config.js`
- Position: x=1725, y=910, width=90, height=90
- Opacity: 0.85

**Why this position:** News logo sits on Bobby G's coffee mug in the bottom-right of the broadcast desk. Twitch and NBA use a different position (top-left, larger, no opacity reduction) — see the per-show spec when those are written.

**When visible:** Always.

**Data source:** Static asset at `assets/cwn_logo.png` (or wherever the logo PNG lives).

**Fallback behavior:** If logo PNG is missing, log a warning and continue without it. Not a hard fail.

---

## 4. Per-scene chrome state matrix

This table is the canonical source of truth for which elements appear on which scenes. Every scene in a News episode must resolve to exactly one row of this table. The directive script's `chrome` object on each scene must match the row exactly.

| Scene type | Flag (3.1) | Sidebar (3.2) | TV card (3.3) | Source clip (3.4) | Episode badge (3.5) | Ticker (3.6) | Logo (3.7) |
|---|---|---|---|---|---|---|---|
| **COLD_OPEN** (scene_01, intro) | ❌ off | ❌ off | ❌ off | n/a | ✅ on | ✅ on | ✅ on |
| **STORY_INTRO** (first avatar scene of each story) | ✅ on (story flag) | ✅ on (active=this story) | ✅ on (story og:image) | n/a | ✅ on | ✅ on | ✅ on |
| **STORY_SETUP** (avatar after intro) | ✅ on (same story flag) | ✅ on (active=this story) | ❌ off | n/a | ✅ on | ✅ on | ✅ on |
| **SOURCE_CLIP** (Al Jazeera clip) | ❌ off | ❌ off | ❌ off | ✅ on (full-frame) | ✅ on | ✅ on | ✅ on |
| **STORY_SUMMARY** (avatar after clip) | ✅ on (same story flag) | ✅ on (active=this story) | ❌ off | n/a | ✅ on | ✅ on | ✅ on |
| **STORY_REACTION** (avatar reaction) | ✅ on (same story flag) | ✅ on (active=this story) | ❌ off | n/a | ✅ on | ✅ on | ✅ on |
| **OUTRO** (final scene) | ❌ off | ❌ off | ❌ off | n/a | ✅ on | ✅ on | ✅ on |

**Active story progression:** stories are processed in order. Stories are 0-indexed in `storyList`. The 5-scene-per-story News structure means scenes map to story indices as follows for a 5-story episode (27 scenes total):

| Scene IDs | Scene type | activeStoryIndex |
|---|---|---|
| `scene_01` | COLD_OPEN | -1 (or 0, doesn't matter — sidebar is off) |
| `scene_02` | STORY_INTRO | 0 |
| `scene_03` | STORY_SETUP | 0 |
| `scene_04` | SOURCE_CLIP | 0 |
| `scene_05` | STORY_SUMMARY | 0 |
| `scene_06` | STORY_REACTION | 0 |
| `scene_07` | STORY_INTRO | 1 |
| `scene_08` | STORY_SETUP | 1 |
| `scene_09` | SOURCE_CLIP | 1 |
| `scene_10` | STORY_SUMMARY | 1 |
| `scene_11` | STORY_REACTION | 1 |
| `scene_12` | STORY_INTRO | 2 |
| `scene_13` | STORY_SETUP | 2 |
| `scene_14` | SOURCE_CLIP | 2 |
| `scene_15` | STORY_SUMMARY | 2 |
| `scene_16` | STORY_REACTION | 2 |
| `scene_17` | STORY_INTRO | 3 |
| `scene_18` | STORY_SETUP | 3 |
| `scene_19` | SOURCE_CLIP | 3 |
| `scene_20` | STORY_SUMMARY | 3 |
| `scene_21` | STORY_REACTION | 3 |
| `scene_22` | STORY_INTRO | 4 |
| `scene_23` | STORY_SETUP | 4 |
| `scene_24` | SOURCE_CLIP | 4 |
| `scene_25` | STORY_SUMMARY | 4 |
| `scene_26` | STORY_REACTION | 4 |
| `scene_27` | OUTRO | -1 |

This table is reproducible by the formula: `scene_count = 1 + (story_count × 5) + 1`. For 5 stories: `1 + 25 + 1 = 27`.

---

## 5. Directive schema (canonical reference)

The directive script that drives the set is defined by `lib/chromeDirectives.js` `ScriptSchema`. The canonical shape:

```javascript
{
  scriptVersion: 1,
  contentType: "news",
  clientId: "cwn",
  brandConfig: {
    primaryHex: "#22304b",
    accentHex: "#c7af4f",
    showName: "ClipzWorld News",
    episodeNumber: 14
  },
  estimatedTotalDurationSec: 660,
  storyList: [
    { index: 0, title: "Trump says Iran wants 'peace deal' but insists on 'no nukes'", source: "Al Jazeera" },
    { index: 1, title: "What are the pros and cons of Trump's Iranian naval blockade?", source: "Al Jazeera" },
    // ... one entry per story, in the order they appear in scenes ...
  ],
  scenes: [
    {
      id: "scene_02",
      type: "avatar",
      storyIndex: 0,
      spokenText: "Trump told reporters today that Iran wants a peace deal. Whether that's true or not depends on who you ask.",
      estimatedDurationSec: 14.5,
      chrome: {
        flag: {
          visible: true,
          text: "TRUMP IRAN PEACE DEAL",
          source: "Al Jazeera"
        },
        tvCard: {
          visible: true,
          imageUrl: "https://www.aljazeera.com/wp-content/uploads/2026/04/trump-iran-og.jpg",
          headline: "Trump says Iran wants 'peace deal' but insists on 'no nukes'",
          sourceName: "Al Jazeera"
        },
        sidebar: {
          visible: true,
          activeIndex: 0,
          cap: 5
        },
        ticker: { visible: true },
        logo:   { visible: true }
      }
    },
    {
      id: "scene_04",
      type: "source_clip",
      storyIndex: 0,
      clipUrl: "https://www.aljazeera.com/.../trump-iran-clip.mp4",
      clipMaxDurationSec: 25,
      chrome: {
        flag:    { visible: false },
        tvCard:  { visible: false },
        sidebar: { visible: false, activeIndex: 0, cap: 5 },
        ticker:  { visible: true },
        logo:    { visible: true }
      }
    }
    // ... 25 more scenes ...
  ]
}
```

**Validation:** every script must pass `validateScript()` from `lib/chromeDirectives.js` BEFORE Gate 1 returns. Schema mismatches hard-fail with the specific Zod error path. **No silent acceptance of malformed scripts.**

---

## 6. Brand variables (for show portability)

When NBA/Twitch/future shows are added, these brand variables are the only fields that change. Everything else in this spec is shared infrastructure.

| Variable | News value | Where used |
|---|---|---|
| `BRAND.primaryHex` | `#22304b` | Lower-third flag bg, sidebar bg, TV card bg |
| `BRAND.accentHex` | `#c7af4f` | All gold accents (borders, labels, active indicators) |
| `BRAND.deepNavy` | `#0d1424` | Watermark mask, drop shadows |
| `BRAND.showName` | `ClipzWorld News` | Episode badge, ticker brand, lower-third bottom |
| `BRAND.tickerSource` | `tools/cwn_ticker.html` | Puppeteer ticker render input |
| `BRAND.flagCategoryDefault` | `WORLD NEWS` | Lower-third top label when scene doesn't specify |
| `BRAND.episodeBadgeFormat` | `Episode {n}` | Episode badge text template |
| `BRAND.logoPath` | `assets/cwn_logo.png` | Logo overlay PNG |
| `BRAND.logoPos` | `LOGO_POS_NEWS` (1725, 910, 90px, 0.85 opacity) | Logo position (News uses coffee mug; other shows use top-left) |
| `BRAND.tvCardSourceLabelColor` | `#c7af4f` (gold) | TV card source attribution color |

For NBA, `BRAND.primaryHex` might become the team's primary color; `BRAND.showName` becomes "ClipzWorld NBA"; `BRAND.tickerSource` becomes the NBA scores ticker; etc. **No element layout changes between shows.** No element appears or disappears between shows. The chrome architecture is one engine; brand variables are the only knob.

---

## 7. Determinism requirement

The set engine must be deterministic: same input directive + same brand config + same source clips = same output MP4 bit-for-bit. No stochastic bugs. No "this works on the third run but not the first." No "browser cache cleared it." No "Puppeteer raced the page.evaluate."

If a bug appears in some runs and not others, that bug is by definition a determinism bug and must be fixed before any other set design issue. Stochastic bugs in the chrome layer are the highest-priority bug class because they undermine every other test.

**Common causes of non-determinism to audit:**
- Puppeteer `networkidle0` timing — the page may screenshot before all assets load
- Browser cache holding stale `tools/clipzworld_newscast.html` across renders
- Page.evaluate guards that fall through to fixture data when injection silently fails
- Async operations in the chrome burn function that aren't awaited
- Puppeteer instance reuse where state from a previous render bleeds into the next
- File system race conditions between PNG generation and FFmpeg overlay consumption
- Cached intermediate TS files from prior runs being reused without invalidation

The set engine must be auditable for all of these. The fix pattern: every state-bearing object must be fresh per render, every async op must be awaited, every cache must be keyed by content hash (not just timestamp), every fixture-data fallback must be removed (replace with hard error).

---

## 8. Acceptance criteria (set is "locked")

The set is locked when an auditor (Gemini watching the MP4, or Rob reviewing in YouTube Studio) can verify all of the following on a single end-to-end smoke test run:

1. **Lower-third flag (3.1)** — appears on every avatar scene in stories 1-5 with the correct UPPERCASE 2-4 word headline matching the active story. Disappears entirely on COLD_OPEN, SOURCE_CLIP, OUTRO. **Never shows "Breaking News Story" or any placeholder.**
2. **Story sidebar (3.2)** — appears on every avatar scene in stories 1-5 with all 5 stories listed in the order they appear in the script, the active story marked "▶ ON AIR" matching the scene's activeStoryIndex. Disappears entirely on COLD_OPEN, SOURCE_CLIP, OUTRO. **Never shows fixture data from a previous run or weeks-old stories.**
3. **TV card (3.3)** — appears at coordinates (1360, 60, 520×293) on every STORY_INTRO scene with the correct article og:image, sentence-case headline, and source label. Disappears on STORY_BODY, SOURCE_CLIP, COLD_OPEN, OUTRO.
4. **Source clip framing (3.4)** — every source_clip scene fills the 1920×1080 frame edge-to-edge with no navy bars, no portrait pillarbox, no oversized zoom. Watermark mask visible at bottom-right. First 5 seconds of source content skipped. Clips never silently dropped.
5. **Episode badge (3.5)** — visible on every scene with the correct integer episode number from `data/episode_counters.json`.
6. **Ticker (3.6)** — visible at bottom of every scene at exactly 1920×64.
7. **Logo (3.7)** — visible at News position (1725, 910, 90×90 at 0.85 opacity) on every scene.
8. **Per-scene matrix (4)** — every scene in the episode matches its row in the chrome state matrix exactly, no exceptions.
9. **Determinism (7)** — running the same script + brand config twice produces bit-identical MP4s (or at least visually identical at every frame).
10. **No silent failures** — every error path in the set engine surfaces in `errors.jsonl` server-side AND in the dashboard banner. No swallowed catch blocks. No fallback to fixture data. No segments silently dropped from concat.

A set that fails any of these 10 criteria is not locked. The fix loop continues until all 10 pass on two consecutive smoke tests with different scripts.

---

## 9. What this spec does NOT cover

- Bobby G's avatar (HeyGen render quality, lip sync, audio levels) — that's the avatar layer, not the set layer
- Script content (story selection, headline writing, fact accuracy) — that's the script layer
- Source clip selection (which Al Jazeera clip plays for which story) — that's the content selection layer
- Multi-platform publishing (YouTube/TikTok/Instagram delivery) — that's the publish layer
- Cost / metrics / runtime instrumentation — that's the observability layer
- Future shows' specs — those get their own SET_DESIGN_SPEC files referencing this one as the architectural prototype

This spec covers ONLY the set design and the visual chrome layer that wraps the avatar + source clips into a broadcast-grade newscast frame.

---

**Last updated:** 2026-04-14
**Next review trigger:** Set is locked per section 8. After lock, this spec becomes the template for SET_DESIGN_SPEC_NBA.md and the brand variables in section 6 become the differentiation surface for every future show in the AuraFlux Set Engine.
