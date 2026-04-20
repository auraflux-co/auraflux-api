# Universal Content Architecture Audit Report

**Date:** 2026-04-17
**Auditor:** Claude Code (read-only audit)
**Scope:** `lib/script_gen.js`, `lib/qa.js`, `lib/assembly.js`, `server.js`, `lib/publish.js`, `lib/validation.js`, `cwn_production.html`
**Status:** Read-only — no production code changed

---

## Executive Summary

The audit confirmed **32 contentType-specific branching violations** across the codebase, compared to the 25+ estimated in the handoff doc. Several listed violations were at shifted line numbers; all were confirmed present. Two additional violation clusters were found that were not in the prior audit list. No listed violations were already fixed.

**Severity breakdown:**

| Severity | Count |
|----------|-------|
| HIGH     | 8     |
| MEDIUM   | 17    |
| LOW      | 7     |
| **Total**| **32**|

---

## Section 1: Audit Results — Verified Violations (Current Line Numbers)

### HIGH Severity — Blocks Adding New Content Types

| # | File | Lines (current) | Description | Why It Blocks New Types |
|---|------|----------------|-------------|-------------------------|
| H1 | `lib/script_gen.js` | 1121–1475 | Three completely separate Gemini analysis blocks — one per content type (`twitch/twitch-short`, `nba/nba-short`, `news/news-short`). Each block has unique pre-processing, URL resolution, Gate 0 logic, and data attachment that is not shared. | A new type (e.g., `podcast`, `youtube`) gets no analysis path at all — falls off the if/else chain with empty `analyses = []`. Pipeline silently fails or Gemini hallucinates. |
| H2 | `lib/script_gen.js` | 2014–2025 | Scene count formula hardcoded per type: Twitch `1 + items.length * (1 + clips*2) + 1`, NBA `1 + items.length*4 + 1`, News `1 + items.length*5 + 1`. Shorts and unknown types leave `expectedScenes = 0` (no validation). | A new type has no scene count formula — Gate 1 skips scene validation entirely, silently accepting any output. Miscount errors pass undetected. |
| H3 | `lib/script_gen.js` | 2190–2276 | The `streamers` normalizer array is a triple ternary repeated **three times** (for `claudeScriptQA`, `claudeScriptFix` pre-fix call, and `claudeScriptFix` post-fix re-QA call). Each call maps Twitch/NBA/News items to a shared `{ displayName, twitchUsername }` shape using inline ternary chains. | A new type produces an empty `streamers: []` array — QA cannot validate names, scene counts reference no items, Gate 1 becomes a rubber stamp. The triple repetition also means any fix must be made in 3 places. |
| H4 | `lib/qa.js` | 640–644 | Clip marker detection branches: News uses `=== STORY#_CLIP ===` header regex; all other types use `[CLIP PLAYS HERE]` text string. These are fundamentally different structural conventions for the same semantic concept. | A new type must invent its own clip marker format and add a new branch here — or reuse one that may not fit its scene structure. |
| H5 | `lib/qa.js` | 673–691 | Array shape normalization for `clipAnalyses`: Twitch expects a 2D array (streamer × clip), NBA/News expect a flat array. Handled by a type-specific branch that flattens Twitch input differently. | A new type must declare whether it uses 2D or flat analysis arrays. No contract exists — a new type silently gets the flat path, which may produce garbled `streamer` attribution in QA. |
| H6 | `lib/qa.js` | 713–840 | Three fully separate QA checklists as ternary chains — one for Twitch (12 items), one for NBA (13 items), one for News (12 items), plus a generic fallback (5 items). Each checklist encodes the show's structural rules as hardcoded text strings. | A new type gets the 5-item generic fallback — which checks for `[CLIP PLAYS HERE]`, `Appreciate you!` outro, and basic structure. All show-specific rules (scene naming, locked intro text, word count, voice style) are silently skipped. |
| H7 | `lib/assembly.js` | 1698–2063 | Three fully separate chrome overlay burn blocks: Twitch (lines 1698–1851), News (lines 1852–2063), NBA (lines 2064–2231). Each block builds its sidebar data structure, determines the active card index, calls `generateNewscastOverlay()`, and executes a two-state or single-state FFmpeg burn — with different parameters for each type. | A new type hits no chrome burn block. The `else if (contentType === 'nba')` ends without an `else` fallback — the segment passes through with no chrome at all. Discovery: silent drop is a worse failure mode than an error. |
| H8 | `lib/assembly.js` | 2936–2969 | YouTube chapter generation has three separate label-parsing branches per type: News reads `STORY#` from scene label + `cardData.title`, NBA reads `GAME#` + team matchup from label or `cardData`, Twitch reads streamer name from `(INTRO)` or `_INTRO$` regex and title-cases it. | A new type produces no chapter markers — the final video has no chapter timestamps in its YouTube description, degrading discoverability. No error is thrown; the feature just silently fails. |

---

### MEDIUM Severity — Duplication / Maintenance Burden

| # | File | Lines (current) | Description | Impact |
|---|------|----------------|-------------|--------|
| M1 | `lib/script_gen.js` | 547–565 | Token limit for Gemini script generation branched per type: `isShort → 2000`, `isTwitch → 32000`, `else (NBA/News) → 16000`. Comment says "NBA/News need ~12k tokens." | A new type defaults to the NBA/News token budget, which may be too small or too large. No config entry to override without code change. |
| M2 | `lib/script_gen.js` | 648–743 | `CWN_VOICE_GUIDES` object is the only structure that correctly uses a `CONFIG`-like lookup by type (`CWN_VOICE_GUIDES[type]`). However it is only defined for `twitch`, `nba`, `news`. A new type gets `undefined`, falls back to `CWN_VOICE_GUIDES.news`. | New type silently uses News voice rules. No error, no log. The show's voice identity is wrong from the first script gen attempt. |
| M3 | `lib/script_gen.js` | 2327–2399 | News-only post-processing block to rebuild `orderedClipUrls` in editorial order (Gemini chose story order, not scrape order). Gated by `if (type === 'news' && scriptQA.outcome === 'pass')`. 70 lines of clip reorder logic that applies to one type only. | NBA has a similar need (highlight clip per game) but uses scrape-order assumption. A future type with non-linear ordering has no generic mechanism. |
| M4 | `lib/script_gen.js` | 2429–2431 | Metric counting: Twitch uses `analyses.flat().length` (2D flatten), others use `analyses.length`. Hardcoded type check inline in metric computation. | Metric inaccuracy for new types. Not a pipeline failure, but causes incorrect performance data in `run_metrics_*.json`. |
| M5 | `lib/script_gen.js` | 2475–2507 | Short-form caption styles (`CAPTION_STYLES`) defined as an inline object keyed by base type. Falls back to `CAPTION_STYLES.news` for unknown types. Affects font, color, position, emoji policy. | A new short-form type gets News caption styling — yellow bar, Georgia font, bottom position. Wrong for most contexts. Must modify this object to add a type. |
| M6 | `lib/script_gen.js` | 2567–2578 | Job card persistence (`saveJobCard`) separately serializes `streamers` (Twitch only) and `newsItems` (News only). NBA items are not persisted to the job card at all. | After server restart, an NBA job restored from `data/jobs.json` has no game item data attached. Chrome overlays that depend on `cardData` may degrade to fallback titles on resume. |
| M7 | `lib/qa.js` | 646–649 | Expected clip count formula: `news-short → 0`, `short → 1`, `twitch → streamers.length * clipsPerStreamer`, `else → clipAnalyses.length`. Each branch encodes structural knowledge about the type's clip economy. | New type gets `clipAnalyses.length` fallback — only correct if the type has one clip per item. Multi-clip-per-item types would pass with wrong counts. |
| M8 | `lib/qa.js` | 1091–1119 | `claudeScriptFix()` builds its clip reference block with three branches: News uses story title labels, NBA uses game matchup labels, Twitch uses 2D array flatten. | A new type gets the Twitch path (2D array assumed), which crashes with a flat array input. |
| M9 | `lib/qa.js` | 1195 | In `geminiScriptQA()` (the secondary QA function), `expectedClips` computed as `contentType === 'twitch' ? streamers.length * clipsPerStreamer : clipAnalyses.length`. This is a simpler and less accurate version of the formula in `claudeScriptQA()`. The two functions are diverged. | New types always get flat array clip count. QA consistency depends on which QA function is called; currently both are used in the pipeline at different points. |
| M10 | `lib/qa.js` | 1225–1229 | In `geminiScriptQA()`, scene count formula hardcoded: `twitch → 1 + streamers*scenesPerStreamer + 1`, `nba or news → 1 + streamers*4 + 1`. Note: this uses the old 4-scenes-per-story formula even though `claudeScriptQA()` now uses 5 for News. The two QA functions have **diverged scene count formulas** — this is an active bug for News in this code path. | News jobs routed through `geminiScriptQA()` would compute `expectedScenes` incorrectly (40 instead of the correct 52 for 10 stories). |
| M11 | `lib/assembly.js` | 1152 | Al Jazeera HLS URL re-scrape at download time gated on `contentType === 'news' && seg.pageUrl.includes('aljazeera')`. Brightcove CDN token refresh logic is News-specific and source-specific in one condition. | If News ever uses a non-Al Jazeera source (AP, Reuters video), re-scrape does not fire. If a new type has URL expiry issues, this pattern must be re-implemented from scratch. |
| M12 | `lib/assembly.js` | 2247–2253 | Source clip crop size: Twitch uses `crop=1880:1040` (trims 20px per edge to remove OBS border bars), all other types use `crop=1920:1080` (full zoom-to-fill). Watermark mask (Al Jazeera logo box) also gated `contentType === 'news'`. | A new type gets full-frame crop (correct for most cases). But if the new type has baked-in borders or watermarks, there is no generic mechanism to configure per-type crop trim or mask regions. |
| M13 | `lib/assembly.js` | 2272–2292 | News silence detection + 25s hard cap block gated `contentType === 'news' && !isAvatarSeg`. 20 lines of async trimming logic (Brightcove clips often have trailing silence). Entirely News-specific. | Other types' clips are never trimmed. NBA clips sometimes have ESPN outro content that runs past 25s — no cap applied. A new type with long clips gets no trim, regardless of need. |
| M14 | `lib/assembly.js` | 2318–2372 | NBA voiceover mixing block — 54 lines gated `contentType === 'nba'`. Finds avatar→clip transitions and replaces clip audio with avatar audio. Unique to NBA live-narration format. | Technically correct to be NBA-only given the NBA narrative format. But the mechanism (avatar audio over clip video) could apply to commentary-style content for other types — currently inextensible without code duplication. |
| M15 | `lib/assembly.js` | 2387 | Concat-vs-xfade decision: `tsFiles.length > 30 || clipCount > 0 || (contentType === 'news' && tsFiles.length > 10)`. The News special case forces concat for any News job with more than 10 segments, bypassing xfade entirely. | This hard rule was added to fix a specific News A/V sync issue. It may not apply to a new type with 15+ segments that could safely use xfade. |
| M16 | `lib/publish.js` | 477–482 | `channelConfig` object hard-codes show names per type. This is the best-structured violation in the codebase — it uses a lookup object rather than ternary chains, and falls back to `channelConfig.news`. Pattern is correct; content is hardcoded. | A new type uses the News show name and handle in published descriptions. Easy to extend but still requires code change. |
| M17 | `server.js` | 697 | Card routing in the assembly job builder: `if (card.contentType === 'news' && /STORY(\d+)_INTRO/i.test(vj.sceneName))` attaches `cardData` only for News intro segments. NBA gets its `cardData` elsewhere (from `allNbaIntros` in assembly.js). Twitch gets no `cardData`. | Chrome overlay for a new type cannot receive `cardData` unless a new branch is added here. Scene-to-cardData mapping is type-specific rather than driven by scene naming convention. |

---

### LOW Severity — Naming / Config / UI Hardcoding

| # | File | Lines (current) | Description |
|---|------|----------------|-------------|
| L1 | `lib/validation.js` | 38 | `validateContentType()` default parameter `['twitch', 'nba', 'news']` hardcodes the allowed type enum. Call sites in server.js override this with the full list including `-short` variants (line 3107, 1752), but the default would be wrong for any new type. |
| L2 | `server.js` | 3107, 1752 | Two call sites of `validateContentType()` hardcode the allowed types list inline: `['twitch', 'nba', 'news', 'twitch-short', 'nba-short', 'news-short']`. Adding a new type requires updating both call sites. |
| L3 | `server.js` | 3115 | `ajVideoPool` construction gated on `type === 'news' || type === 'news-short'`. The pre-built video pool from dashboard items is a News-only optimization. Not wrong, but adds a type-specific branch in the route handler. |
| L4 | `server.js` | 5091 | Remediation endpoint (`/remediate`) intro card logic gated on `contentType === 'twitch' && streamers.length > 0`. NBA and News remediation of intro cards is not supported in the post-hoc fix path. |
| L5 | `server.js` | 5171 | Logo position in remediation endpoint duplicates the `(contentType === 'news') ? LOGO_POS_NEWS : LOGO_POS` ternary from assembly.js rather than using a shared lookup. Two places must be updated when logo positions change. |
| L6 | `cwn_production.html` | ~180–249 | Dashboard generate section has three hardcoded panels (NBA, News, Twitch) with per-type IDs, button labels, and `onclick` handlers (`generateNBA()`, `generateNews()`, `generateTwitch()`, `generateShort('nba')`). UI is not data-driven. |
| L7 | `cwn_production.html` | ~662–664 | Thumbnail tab buttons hardcoded: `id="ttab-nba"`, `id="ttab-news"`, `id="ttab-twitch"` with type-specific `onclick` handlers. Adding a content type requires manual HTML authoring. |

---

## Section 2: New Violations Not in Prior Audit

The following violations were found during this audit and were not listed in the handoff document:

**N1 — `lib/script_gen.js` line 2429–2431:** Metric analysis-call counting uses `analyses.flat()` for Twitch vs `analyses.length` for others. This is a separate violation from H3 (the streamers normalizer). It causes inaccurate Gemini call counts in `run_metrics_*.json` for Twitch jobs. **Severity: MEDIUM** (M4 above).

**N2 — `lib/script_gen.js` line 2474–2507:** Short-form caption style is an inline keyed object (`CAPTION_STYLES`) — correctly CONFIG-like in structure but hardcoded at call site rather than in `lib/config.js`. A fourth type would need code changes here. **Severity: MEDIUM** (M5 above).

**N3 — `lib/script_gen.js` line 2567–2578:** Job card persistence serializes only Twitch `streamers` and News `newsItems`. NBA game items are never persisted to the job card. On server restart, an NBA job card has no game data — chrome overlay fallback behavior is degraded. **Severity: MEDIUM** (M6 above).

**N4 — `lib/qa.js` line 1225–1229:** `geminiScriptQA()` scene count formula is diverged from `claudeScriptQA()`. `geminiScriptQA()` uses 4 scenes/story for News; `claudeScriptQA()` uses 5. This is an active bug in the secondary QA path, not just a structural concern. **Severity: MEDIUM** (M10 above).

**N5 — `lib/assembly.js` line 2387:** Concat vs xfade decision includes a News-specific threshold `(contentType === 'news' && tsFiles.length > 10)` that was not in the prior audit list. **Severity: MEDIUM** (M15 above).

**N6 — `server.js` line 5091:** Remediation endpoint (`/remediate`) intro card block is Twitch-only. NBA and News jobs cannot use the post-assembly intro card remediation path. Not listed in prior audit. **Severity: LOW** (L4 above).

---

## Section 3: Proposed CONFIG Structures for HIGH Severity Items

### H1 — Gemini Analysis Dispatch

**Current pattern:** Three giant if/else blocks (Twitch, NBA/News) with 50–100 lines each.

**Proposed approach:** Extract a per-type `analyzeItems(type, items)` strategy function registered in a dispatch table. Each function handles its type's pre-processing, URL resolution, and Gate 0 logic. The main handler calls `CONTENT_TYPE_ANALYZERS[type](items)`.

```
CONFIG.CONTENT_TYPES = {
  twitch: { analyzer: 'analyzeTwitchItems',  minItemsRequired: 1 },
  nba:    { analyzer: 'analyzeNBAItems',     minItemsRequired: 1 },
  news:   { analyzer: 'analyzeNewsItems',    minItemsRequired: 1 },
}
```

**Key benefit:** A new type registers one function rather than being inserted into a branching chain.

---

### H2 — Scene Count Formula

**Current pattern:** Three hardcoded formulas as if/else blocks at line 2014.

**Proposed approach:** Centralize in CONFIG. The main handler reads from config, no branching required.

```
CONFIG.SCENE_STRUCTURE = {
  twitch:      { intro: 1, perItem: null, perClip: 2, clipOffset: 1, outro: 1 },
  //            perItem = null means: use 1 + clips*2 (calculated from item data)
  nba:         { intro: 1, perItem: 4,    outro: 1 },
  news:        { intro: 1, perItem: 5,    outro: 1 },
  'twitch-short': { intro: 0, perItem: 0, outro: 0 }, // no validation
  'nba-short':    { intro: 0, perItem: 0, outro: 0 },
  'news-short':   { intro: 0, perItem: 0, outro: 0 },
};

// Usage:
const sc = CONFIG.SCENE_STRUCTURE[type];
if (sc && sc.perItem !== null) {
  expectedScenes = sc.intro + items.length * sc.perItem + sc.outro;
} else if (sc && sc.perItem === null) {
  // Twitch: variable per-item scene count based on clip count
  const clipsPerStreamer = items[0]?.clips?.length || req.body.clipsPerStreamer || 2;
  expectedScenes = sc.intro + items.length * (1 + clipsPerStreamer * 2) + sc.outro;
}
```

---

### H3 — Streamers Normalizer (Triple Repetition)

**Current pattern:** Inline ternary chain repeated three times at lines 2190–2192, 2260–2262, 2273–2275.

**Proposed approach:** Extract a single `normalizeItemsToStreamers(type, items)` function called once, result stored in a variable, then passed to all three QA calls.

```
CONFIG.ITEM_NORMALIZERS = {
  twitch:       (items) => items.map(s => ({ displayName: s.displayName || s.name || s, twitchUsername: s.username || s })),
  'twitch-short': (items) => items.map(s => ({ displayName: s.displayName || s.name || s, twitchUsername: s.username || s })),
  nba:          (items) => items.map(g => ({ displayName: `${g.away} vs ${g.home}`, twitchUsername: g.gameId || '' })),
  'nba-short':  (items) => items.map(g => ({ displayName: `${g.away} vs ${g.home}`, twitchUsername: g.gameId || '' })),
  news:         (items) => items.map(s => ({ displayName: s.title || s.link || '', twitchUsername: '' })),
  'news-short': (items) => items.map(s => ({ displayName: s.title || s.link || '', twitchUsername: '' })),
};

// Usage (call once, use everywhere):
const normalizedStreamers = (CONFIG.ITEM_NORMALIZERS[type] || (() => []))(items);
```

---

### H4 — Clip Marker Detection

**Current pattern:** News uses `=== STORY#_CLIP ===` header regex; all others use `[CLIP PLAYS HERE]` text string.

**Proposed approach:** Unify the clip marker convention. News should also use `[CLIP PLAYS HERE]` — the `=== STORY#_CLIP ===` header is a scene boundary, not a clip marker. The two concepts should be decoupled. If kept separate, add a CONFIG lookup:

```
CONFIG.CLIP_MARKER = {
  twitch:  { type: 'text', pattern: /\[CLIP PLAYS HERE\]/g },
  nba:     { type: 'text', pattern: /\[CLIP PLAYS HERE\]/g },
  news:    { type: 'header', pattern: /===\s+STORY\d+_CLIP\s+===/g },
  // new type: choose 'text' or 'header' without touching QA logic
};
```

---

### H5 — clipAnalyses Array Shape

**Current pattern:** Twitch passes 2D array; NBA/News pass flat array. Handled by type branch in `claudeScriptQA`.

**Proposed approach:** Normalize at the source — Twitch analysis should be flattened before being passed into QA. The 2D shape is an implementation artifact of how Twitch clips are grouped, not a required input shape for QA.

```
// In handleGenerateFullScript, before calling claudeScriptQA:
const flatAnalysesForQA = (type === 'twitch' || type === 'twitch-short')
  ? analyses.flat()
  : analyses;
// Then always pass flatAnalysesForQA — QA never needs to know about 2D arrays.
```

This eliminates the branch entirely; QA always receives a flat array.

---

### H6 — QA Checklists

**Current pattern:** Three full checklists as ternary chains at lines 747–840.

**Proposed approach:** Move checklists to CONFIG as data. Each checklist item is a template string factory (or a plain string with token replacement). The QA function assembles the checklist from CONFIG rather than branching.

```
CONFIG.QA_CHECKLISTS = {
  twitch: [
    (ctx) => `1. SCENE COUNT: Expected exactly ${ctx.expectedScenes} markers...`,
    (ctx) => `2. CLIP COUNT: Are there exactly ${ctx.expectedClips} [CLIP PLAYS HERE] markers?`,
    // ... 12 items
  ],
  nba:  [ /* 13 items */ ],
  news: [ /* 12 items */ ],
  _short: [ /* 4 items, shared by all short types */ ],
};

// Usage:
const checklistFns = CONFIG.QA_CHECKLISTS[isShortForm ? '_short' : baseType] || CONFIG.QA_CHECKLISTS._fallback;
const checklist = checklistFns.map(fn => fn({ expectedScenes, expectedClips, streamers }));
```

---

### H7 — Chrome Overlay Burn Dispatch

**Current pattern:** Three `if/else if/else if` blocks in the TS conversion loop (lines 1698–2063).

**Proposed approach:** Extract a per-type `buildChromeOverlay(contentType, seg, segsToProcess, label, options)` strategy function. The main loop calls one function regardless of type.

```
CONFIG.CHROME_HANDLERS = {
  twitch: 'buildTwitchChrome',
  news:   'buildNewsChrome',
  nba:    'buildNBAChrome',
  // new type: register 'buildPodcastChrome' or null for no chrome
};
```

The loop becomes:
```javascript
const chromeHandler = CHROME_STRATEGIES[contentType];
if (chromeHandler && (segTypes[i] || 'avatar') === 'avatar') {
  inputForTS = await chromeHandler(seg, segsToProcess, label, config);
}
```

---

### H8 — YouTube Chapter Generation

**Current pattern:** Three label-parsing branches per type at lines 2936–2969.

**Proposed approach:** Chapter extraction should be data-driven. The scene naming convention already encodes the type (STORY#, GAME#, streamer name patterns). Extract a per-type `extractChapterTitle(label, cardData, timestamp)` function registered in CONFIG.

```
CONFIG.CHAPTER_EXTRACTORS = {
  news:   (label, cardData, ts) => { /* extract from STORY# + cardData.title */ },
  nba:    (label, cardData, ts) => { /* extract from GAME# + matchup */ },
  twitch: (label, cardData, ts) => { /* extract streamer name from INTRO label */ },
};

// Usage:
const extractor = CONFIG.CHAPTER_EXTRACTORS[contentType];
if (extractor) chapterTitle = extractor(label, seg.cardData, ts);
```

---

## Section 4: Universal Item Shape Proposal

The handoff doc proposed a normalized item schema. Below is the verification of whether this shape works across all three current types, and where the gaps are.

**Proposed shape:**
```javascript
{
  id:           string,   // clipId, gameId, storyUrl
  title:        string,
  description:  string,
  videoUrl:     string,   // primary clip URL
  thumbnailUrl: string,
  duration:     number,   // seconds
  metadata:     object    // type-specific extras
}
```

### Twitch items — shape fit

| Field | Twitch source | Fit |
|-------|--------------|-----|
| `id` | `clip.url` (Twitch clip page URL) | ✅ maps cleanly |
| `title` | `clip.title` | ✅ direct |
| `description` | Currently absent — game name only | ⚠️ Gap: no clip description in current schema |
| `videoUrl` | `clip.mp4Url` / resolved GQL URL | ✅ maps cleanly |
| `thumbnailUrl` | `clip.thumbnailUrl` | ✅ direct |
| `duration` | Not stored pre-analysis | ⚠️ Gap: populated only after Gemini analysis |
| `metadata` | `{ streamer, game, isBackup, targetClipsPerStreamer }` | ✅ fits in metadata object |

### NBA items — shape fit

| Field | NBA source | Fit |
|-------|-----------|-----|
| `id` | `item.gameId` | ✅ direct |
| `title` | Constructed as `away + ' vs ' + home` | ✅ maps cleanly |
| `description` | Not currently stored | ⚠️ Gap: game summary text is in Gemini analysis, not item |
| `videoUrl` | `item.clipUrl` (ESPN/HLS URL) | ✅ direct |
| `thumbnailUrl` | `item.thumbnailUrl` | ✅ direct |
| `duration` | Not stored | ⚠️ Gap |
| `metadata` | `{ away, home, gameId, localPath, pillarboxFilter }` | ✅ fits in metadata |

### News items — shape fit

| Field | News source | Fit |
|-------|------------|-----|
| `id` | `item.link` or `item.url` (article URL) | ✅ maps cleanly |
| `title` | `item.title` | ✅ direct |
| `description` | `item.source`, `item.category` | ⚠️ Partial: description would conflate multiple fields |
| `videoUrl` | `item.videoUrl` or `item.clipUrl` or scraped HLS | ✅ maps cleanly |
| `thumbnailUrl` | `item.thumbnailUrl` or `item.imageUrl` | ✅ direct |
| `duration` | Not stored | ⚠️ Gap |
| `metadata` | `{ source, category, heroImageUrl, link, hlsUrl, sourceOrientation, pillarboxFilter }` | ✅ fits in metadata |

### Gaps requiring resolution before adoption

1. **`duration` field:** Not populated at item construction time for any type. Would need to be set after Gemini analysis or ffprobe. This is a real gap — the universal shape assumes it but it cannot be filled at the current pipeline entry point.

2. **`description` field:** Means different things per type — game summary, clip description, article summary. Propose mapping the richest available text field per type into `description`, with `metadata` carrying the rest.

3. **Twitch multi-clip:** Each Twitch streamer item contains multiple clips (`item.clips[]`). The universal shape assumes one `videoUrl` per item. The correct normalization is: expand each clip into its own item, with `metadata.streamer` and `metadata.clipIndex` identifying the source. This is a deeper restructuring than the other two types require.

4. **Job card backwards compatibility:** `streamers[]` and `newsItems[]` in persisted job cards are type-specific arrays. Migration to universal shape would need a versioning strategy for in-flight jobs in `data/jobs.json`.

---

## Section 5: Migration Phases

### Phase 1 — Centralize CONFIG (Lowest Risk, No Logic Changes)

**Target:** Extract hardcoded per-type constants into `lib/config.js`. No logic changes — just move magic values.

**Files:** `lib/config.js`, `lib/script_gen.js`, `lib/qa.js`

**Specific moves:**
- Scene count formulas → `CONFIG.SCENE_STRUCTURE` (see H2 above)
- Token limits → `CONFIG.CONTENT_TYPES[type].maxOutputTokens`
- Caption styles → `CONFIG.CAPTION_STYLES[baseType]`
- QA clip count formulas → `CONFIG.CLIP_COUNT[type]`
- Valid type enum → `CONFIG.VALID_TYPES` array (replaces hardcoded lists in `validation.js` call sites)
- Channel config → already in `publish.js` as a local object; move to `lib/config.js`

**Risk:** Zero — pure constant extraction. Each constant can be moved one at a time with a test run between.

---

### Phase 2 — Normalize Item Shapes at Entry Points

**Target:** Add a `normalizeItem(type, rawItem)` function that converts each type's raw dashboard payload into the universal shape. Called in `handleGenerateFullScript` before the analysis block.

**Files:** `lib/script_gen.js`, new `lib/normalizers.js`

**Function targets:**
- `normalizeItems(type, items)` — returns `UniversalItem[]`
- `normalizeItemsToStreamers(type, items)` — replaces the triple ternary (H3 above)

**Dependency:** Phase 1 must be complete so normalizers can read from CONFIG.

**Risk:** Low — normalization is additive. The old type-specific fields can still be read from `metadata` during Phase 3 refactor.

---

### Phase 3 — Replace QA Checklists with Config-Driven Rules

**Target:** Move QA checklists from inline ternary chains to `CONFIG.QA_CHECKLISTS[type]`. Each checklist item becomes a factory function.

**Files:** `lib/qa.js`, `lib/config.js`

**Function targets:**
- `buildChecklist(type, ctx)` — replaces the three ternary chains in `claudeScriptQA()`
- `buildContextHeader(type, ctx)` — replaces the `contextHeader` ternary chain
- `computeExpectedClips(type, ctx)` — replaces the `expectedClips` branching logic

**Dependency:** Phase 1 must be complete (CONFIG.QA_CHECKLISTS must exist).

**Risk:** Medium — QA prompt changes affect Gate 1 scoring. Must run a test batch (3–5 full jobs per type) before shipping. The diverged `geminiScriptQA()` vs `claudeScriptQA()` scene count formulas (N4 / M10) should be consolidated in this phase.

---

### Phase 4 — Replace Assembly Branching with Strategy Functions

**Target:** Extract three chrome overlay handlers and the chapter extractor into registered strategy functions. Assembly loop calls dispatch table, not type branches.

**Files:** `lib/assembly.js`, new `lib/chrome_strategies.js`

**Function targets:**
- `buildTwitchChrome(seg, segsToProcess, label, opts)` — extracted from lines 1698–1851
- `buildNewsChrome(seg, segsToProcess, label, opts)` — extracted from lines 1852–2063
- `buildNBAChrome(seg, segsToProcess, label, opts)` — extracted from lines 2064–2231
- `CHROME_STRATEGIES[contentType]` dispatch table
- `extractChapterTitle(type, label, cardData, ts)` — extracted from lines 2936–2969

**Dependency:** Phases 1–2 must be complete so strategy functions receive normalized items.

**Risk:** High — assembly.js is the most complex and highest-stakes file. Each chrome strategy extraction should be independently tested with a real assembly run before proceeding to the next. Recommend doing Twitch → News → NBA in that order (Twitch is most-tested, NBA voiceover is most unique).

---

### Phase 5 — Frontend Universal Generate Flow

**Target:** Make the dashboard's generate panel data-driven. A `CONTENT_TYPES` config (fetched from `GET /content-types`) drives the panel render — no hardcoded Twitch/NBA/News HTML.

**Files:** `cwn_production.html`, `server.js` (new `GET /content-types` endpoint)

**Function targets:**
- `GET /content-types` — returns array of `{ id, label, form_types: ['long', 'short'], config_fields: [...] }`
- Dashboard `renderGeneratePanel(types)` — replaces three hardcoded panels

**Dependency:** All backend phases must be complete first (a universal dashboard requires a universal backend).

**Risk:** Low-medium — frontend changes do not affect pipeline correctness. The existing hardcoded panels can remain as fallback during migration. Dashboard bugs are recoverable without data loss.

---

## Appendix: Files Searched (Read-Only)

| File | Lines | Violations Found |
|------|-------|-----------------|
| `lib/script_gen.js` | 2,662 | H1, H2, H3, M1, M2, M3, M4, M5, M6 |
| `lib/qa.js` | 2,020 | H4, H5, H6, M7, M8, M9, M10 |
| `lib/assembly.js` | 3,116 | H7, H8, M11, M12, M13, M14, M15, M17 |
| `server.js` | 5,769 | L2, L3, L4, L5, M16 (also M17) |
| `lib/publish.js` | ~530 | M16 |
| `lib/validation.js` | 168 | L1 |
| `cwn_production.html` | ~4,000 est. | L6, L7 |
| `lib/config.js` | ~90 | Reviewed for existing CONFIG structures |

No production files were modified. This report is the only file created.
