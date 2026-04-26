# server.js Split Plan — Refactor to Modules

**Created:** 2026-04-09
**Why:** server.js is 9,938 lines / 435KB. Aider hits the 200K token context limit when loading it.
**Status:** IN PROGRESS — first 3 modules extracted and verified ✅

---

## The Problem

When Aider loads server.js for editing, it consumes ~172K tokens just for the file.
Add cursor.md + STATUS.md + QA_GATES.md and you exceed the 200K limit before Aider can write a single line.

**Error seen:**
```
litellm.BadRequestError: input length and `max_tokens` exceed context limit: 172167 + 64000 > 200000
```

---

## Proposed Module Split

Split server.js into focused modules under `lib/routes/` and `lib/services/`.
server.js becomes a thin orchestrator (~300 lines) that just imports and mounts everything.

### New File Structure

```
lib/
  services/
    gemini.js          ← All Gemini API calls (analyze, QA, script gen, style library)
    heygen.js          ← HeyGen API integration (send script, parse scenes, status)
    ffmpeg.js          ← FFmpeg utilities (concat, normalize, thumbnail, intro cards)
    drive.js           ← Google Drive upload
    publish.js         ← Upload-Post multi-platform publish
    canvas_cards.js    ← Node Canvas intro card generation (Twitch + NBA/News)
    twitch.js          ← Twitch clip resolution (GQL + thumbnail-derived)
    capcut.js          ← CapCut/VectCut API proxy routes
  routes/
    assemble.js        ← POST /assemble (lines 2639–4238)
    script.js          ← POST /generate-full-script (lines 5821–6680)
    thumbnails.js      ← POST /generate-thumbnail, /generate-twitch-longform-thumbnail (lines 9040–9770)
    publishing.js      ← POST /publish, /generate-publish-copy, /log-heygen-metrics (lines 6890–7160)
    nba_news.js        ← POST /nba/*, /news/* (lines 4529–4974)
    shorts.js          ← POST /shorts/*, /capcut/*, /thumbnail-short, /safety-zone-check (lines 7706–8700)
    maintenance.js     ← GET /health, /disk-usage, /errors, POST /cleanup (lines 908–1003, 9771–9938)
```

### What Stays in server.js (~300 lines)

```javascript
// server.js — Orchestrator only
require('./lib/services/gemini');    // init Gemini client
require('./lib/services/heygen');    // init HeyGen
// ... other service inits

const assembleRoutes = require('./lib/routes/assemble');
const scriptRoutes   = require('./lib/routes/script');
// ... etc

app.use(assembleRoutes);
app.use(scriptRoutes);
// ... etc

app.listen(PORT);
```

---

## Line-by-Line Split Map

| Module | Lines in server.js | Est. Size |
|--------|-------------------|-----------|
| `lib/services/gemini.js` | 1264–1483, 5017–5820, 6681–6889 | ~1,800 lines |
| `lib/services/heygen.js` | 1483–1656 | ~175 lines |
| `lib/services/ffmpeg.js` | 769–904, 2054–2200 (normalize) | ~400 lines |
| `lib/services/drive.js` | 1021–1091, 2517–2552 | ~120 lines |
| `lib/services/publish.js` | 6890–7160 | ~270 lines |
| `lib/services/canvas_cards.js` | 431–740 | ~310 lines |
| `lib/services/twitch.js` | 4975–5016 | ~40 lines |
| `lib/routes/assemble.js` | 2639–4238 | ~1,600 lines |
| `lib/routes/script.js` | 5307–6680 | ~1,375 lines |
| `lib/routes/thumbnails.js` | 9040–9770 | ~730 lines |
| `lib/routes/publishing.js` | 6890–7530 | ~640 lines |
| `lib/routes/nba_news.js` | 4529–4974 | ~445 lines |
| `lib/routes/shorts.js` | 7706–8700 | ~995 lines |
| `lib/routes/maintenance.js` | 908–1003, 9771–9938 | ~265 lines |
| **server.js (orchestrator)** | ~300 lines | ~300 lines |

**Result:** No single file exceeds ~1,800 lines. Aider can load any one module + context docs without hitting the limit.

---

## How Agents Navigate After the Split

### The MAP Comment System

Every extracted function gets a one-line comment at the top of its new file AND a redirect comment left in server.js:

**In the new module file** (`lib/services/gemini.js`):
```javascript
// MOVED FROM: server.js:1268 (geminiQACheck)
// MOVED FROM: server.js:1662 (geminiScriptGeneration)
// MOVED FROM: server.js:5655 (geminiAnalyzeClip)
```

**In server.js** (where the function used to be):
```javascript
// ── MOVED TO lib/services/gemini.js ──────────────────────────────────
// geminiQACheck()         → lib/services/gemini.js:geminiQACheck
// geminiScriptGeneration() → lib/services/gemini.js:geminiScriptGeneration
// geminiAnalyzeClip()     → lib/services/gemini.js:geminiAnalyzeClip
```

### SERVER_MAP.md (auto-generated after split)

A `SERVER_MAP.md` file will be generated listing every function and its new location:

```
Function                    | Old Location      | New Location
----------------------------|-------------------|---------------------------
geminiQACheck()             | server.js:1268    | lib/services/gemini.js:45
geminiScriptGeneration()    | server.js:1662    | lib/services/gemini.js:180
geminiAnalyzeClip()         | server.js:5655    | lib/services/gemini.js:320
sendScriptToHeyGen()        | server.js:1526    | lib/services/heygen.js:12
parseScriptIntoScenes()     | server.js:1485    | lib/services/heygen.js:8
POST /assemble              | server.js:2639    | lib/routes/assemble.js:1
POST /generate-full-script  | server.js:5821    | lib/routes/script.js:1
...
```

This file is the single reference for "where did that code go?"

---

## Shared State Problem (Critical)

Several variables are used across multiple route handlers and must be handled carefully:

| Variable | Used By | Solution |
|----------|---------|----------|
| `CONFIG` | Everything | Export from `lib/config.js`, require everywhere |
| `STREAMER_DISPLAY_NAMES` / `getDisplayName()` | script, assemble, thumbnails | Export from `lib/streamers.js` |
| `TICKER_CACHE` | assemble, ticker routes | Export from `lib/services/ticker.js` |
| `assemblyProgress` (Map) | assemble, assemble-progress | Export from `lib/state.js` |
| `jobMetrics` (Map) | StageTimer, all routes | Export from `lib/metrics.js` |
| `log()` function | Everything | Export from `lib/logger.js` |
| `app` (Express instance) | All routes | Pass as param or use Router |

---

## Implementation Rules (When We Do This)

1. **One module at a time** — extract one file, test server starts, commit, then next
2. **Never delete from server.js first** — copy to new file, verify it works, then remove
3. **Run `node --check server.js` after every step** — syntax check before commit
4. **Update SERVER_MAP.md after every extraction** — keep it current
5. **Aider works on ONE module at a time** — never load multiple modules in same session
6. **All agents pause feature work during split** — no new features until split is complete and verified

---

## Recommended Split Order (Safest First)

1. ✅ `lib/config.js` — CONFIG object (no dependencies, pure data) — **DONE 2026-04-09**
2. ✅ `lib/logger.js` — log() function (no dependencies) — **DONE 2026-04-09**
3. ✅ `lib/metrics.js` — StageTimer, initJobMetrics, addStageMetrics, finalizeJobMetrics — **DONE 2026-04-09**
4. `lib/streamers.js` — STREAMER_DISPLAY_NAMES, getDisplayName() — **NEXT UP**
5. `lib/services/ffmpeg.js` — ffmpegPath, ffprobePath, buildConcatCommand, probeDuration
6. `lib/services/drive.js` — getDriveClient, getDriveFolderId, uploadToDrive
7. `lib/services/heygen.js` — parseScriptIntoScenes, sendScriptToHeyGen
8. `lib/services/gemini.js` — all Gemini functions (largest, do last of services)
9. `lib/routes/maintenance.js` — /health, /disk-usage, /errors, /cleanup
10. `lib/routes/nba_news.js` — /nba/*, /news/*
11. `lib/routes/thumbnails.js` — /generate-thumbnail, /generate-twitch-longform-thumbnail
12. `lib/routes/shorts.js` — /capcut/*, /shorts/*, /thumbnail-short
13. `lib/routes/publishing.js` — /publish, /generate-publish-copy
14. `lib/routes/script.js` — /generate-full-script (most complex, do second-to-last)
15. `lib/routes/assemble.js` — /assemble (most complex, do last)

---

## Estimated Time

- Each simple service module: ~30 min
- Each complex route module: ~1-2 hours
- Total: ~12-15 hours of Aider work
- **Recommended:** Run during overnight windows (1am-7am ET), 2-3 modules per night

---

## Phase 1 Complete ✅

Items 1-3 extracted and verified:
- `lib/config.js` — CONFIG object
- `lib/logger.js` — log() function
- `lib/metrics.js` — StageTimer + metrics functions
- `node --check server.js` passes ✅
- Server starts cleanly, `/health` returns `"ok": true` ✅

## DO NOT START (original checklist — now resolved):
- [x] Rob approves this plan
- [x] Claude Code is notified and agrees
- [x] All agents pause feature work
- [x] A test run of the current server passes (baseline)
- [ ] SERVER_MAP.md template is created — **still pending**
