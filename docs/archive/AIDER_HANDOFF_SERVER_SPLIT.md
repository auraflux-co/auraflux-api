# AIDER HANDOFF: server.js Module Split — Phase 2

**Agent:** Aider (overnight batch — surgical extract-and-require)
**Priority:** CRITICAL — server.js is 12,429 lines. Cline crashes with RangeError reading it.
**Status:** READY — exact extract targets identified, no logic changes, pure file moves
**Lock:** ALL agents must pause commits until this handoff is complete and server boots clean.

---

## Why This Exists

Cline crashed today with `RangeError: Invalid string length` while working on server.js.
The file has grown to 12,429 lines despite Phase 1 extracting ~1,900 lines into `lib/`.
New features (assembly, chrome, QA gates, publish) were added faster than old code was extracted.

**Goal:** Get server.js under 5,000 lines so any agent can grep-then-read safely.
**Method:** Pure extract-and-require. Zero logic changes. Zero behavior changes.
**Risk level:** Low — each extracted function gets `module.exports`, server.js gets `require()`.

---

## What's Already in lib/

Do NOT re-extract these — they're already modules:

| Module | What it contains |
|---|---|
| `lib/config.js` | CONFIG constants |
| `lib/metrics.js` | StageTimer, jobMetrics, initJobMetrics, addStageMetrics, finalizeJobMetrics |
| `lib/validation.js` | validateContentType, validateRequiredFields, validateArrayLength |
| `lib/error_logger.js` | logError, errorMiddleware |
| `lib/logger.js` | log() helper |
| `lib/ffmpeg_utils.js` | ffmpegPath, ffprobePath, checkFFmpeg, ffmpegEncodeArgs |
| `lib/chromeDirectives.js` | buildChromeDirectives, chromeDirectivesForScript |
| `lib/directives.js` | DirectiveSchema, ChromeDirectiveSchema helpers |
| `lib/clients/gemini_client.js` | Gemini API client wrapper |
| `lib/clients/twitch_client.js` | Twitch GQL + REST client |
| `lib/clients/heygen_client.js` | HeyGen API client |

---

## Extract Targets — 5 New Modules

### Module 1: `lib/qa.js` — QA gate functions
**Lines to extract:** ~1,898–3,216 (approximately 1,318 lines)

Functions to move:
- `geminiQACheck(videoPath, opts)` — line 1898
- `claudeScriptQA(script, clipAnalyses, opts)` — line 2508
- `claudeScriptFix(script, clipAnalyses, opts)` — line 2880
- `geminiScriptQA(script, clipAnalyses, opts)` — line 2946
- `geminiSegmentQA(segmentPaths, opts)` — line 3217
- `parseScriptIntoScenes(script)` — line 2133
- `generateClipAvailabilityReport(items, allClips, streamerOrder, analysisClips)` — line 2429

**Dependencies these functions need (pass as imports or params):**
- `callClaudeAPI` — stays in server.js for now, pass as param OR extract to `lib/claude_client.js`
- `uploadToGeminiFiles`, `waitForGeminiFile`, `deleteGeminiFile` — extract to `lib/gemini_files.js` or include in `lib/qa.js`
- `CONFIG` from `lib/config.js` — already a module, just require it
- `logError` from `lib/error_logger.js` — already a module
- `path`, `fs` — standard Node, require at top of new file

**`lib/qa.js` template:**
```javascript
'use strict';
const path = require('path');
const fs = require('fs');
const { CONFIG } = require('./config');
const { logError } = require('./error_logger');
// callClaudeAPI injected via init() or passed as param — see note below

// ... paste functions here ...

module.exports = {
  geminiQACheck,
  claudeScriptQA,
  claudeScriptFix,
  geminiScriptQA,
  geminiSegmentQA,
  parseScriptIntoScenes,
  generateClipAvailabilityReport
};
```

**Note on callClaudeAPI dependency:** `claudeScriptQA` and `claudeScriptFix` call `callClaudeAPI`. Two options:
1. Extract `callClaudeAPI` to `lib/claude_client.js` and import it in `lib/qa.js` (preferred)
2. Pass `callClaudeAPI` as an options param to the functions that need it

Option 1 is cleaner. If `callClaudeAPI` has no other complex dependencies, extract it too (it's at line ~3439, ~30 lines).

---

### Module 2: `lib/script_gen.js` — Script generation pipeline
**Lines to extract:** ~7,329–8,619 (approximately 1,290 lines)

Functions to move:
- `geminiScriptGeneration(userPrompt, systemPrompt, opts)` — line 2314 (check — may be before the endpoint)
- The `/generate-full-script` endpoint handler body — line 7329 (this is the big one, ~1,300 lines)
- `geminiAnalyzeClip(videoUrl, thumbnailUrl, contentType, metadata)` — line 7163
- `geminiAnalyzeThumbnail(thumbnailUrl, contentType, metadata)` — line 7324
- `scrapeArticleVideo(articleUrl)` — line 7061
- `scrapeArticleOgImage(articleUrl)` — line 7137
- `uploadToGeminiFiles(filePath, maxRetries)` — line 6968
- `waitForGeminiFile(file)` — line 7017
- `deleteGeminiFile(fileName)` — line 7030
- `getVoiceGuide(type, tone)` — line 6550
- `prioritizeNewsStories(stories)` — line 9116

**The `/generate-full-script` endpoint** stays registered in server.js but its handler body moves to `lib/script_gen.js` as `handleGenerateFullScript(req, res)`. server.js becomes:
```javascript
const { handleGenerateFullScript } = require('./lib/script_gen');
app.post('/generate-full-script', validateMiddleware, handleGenerateFullScript);
```

**`lib/script_gen.js` template:**
```javascript
'use strict';
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { CONFIG } = require('./config');
const { logError } = require('./error_logger');
const { log } = require('./logger');

// ... paste functions here ...

module.exports = {
  geminiScriptGeneration,
  geminiAnalyzeClip,
  geminiAnalyzeThumbnail,
  scrapeArticleVideo,
  scrapeArticleOgImage,
  uploadToGeminiFiles,
  waitForGeminiFile,
  deleteGeminiFile,
  getVoiceGuide,
  prioritizeNewsStories,
  handleGenerateFullScript
};
```

---

### Module 3: `lib/assembly.js` — Assembly pipeline
**Lines to extract:** ~3,525–5,545 (approximately 2,020 lines — the biggest chunk)

Functions/handlers to move:
- The `/assemble` endpoint handler body — line 3525 (the core 2,000-line function)
- `generateIntroCardPNG(streamerData, outputPath, variant)` — line 663
- `generateGameStoryCardPNG(cardData, outputPath, contentType)` — line 837
- `generateNewsStoryCardPNG(storyData, outputPath)` — line 1085
- `detectTrailingSilence(clipPath)` — line 983
- `computeNewsClipTrimDuration(clipPath)` — line 1046
- `buildConcatCommand(inputFiles, outputPath, transition, format)` — line 1261
- `probeDuration(filePath)` — line 1338
- `checkDiskSpace(requiredMB)` — line 1235
- `captureTicker(contentType)` — line 5953

Same pattern: `/assemble` handler body becomes `handleAssemble(req, res)` in `lib/assembly.js`. server.js:
```javascript
const { handleAssemble } = require('./lib/assembly');
app.post('/assemble', validateMiddleware, handleAssemble);
```

**`lib/assembly.js` template:**
```javascript
'use strict';
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { createCanvas, loadImage } = require('canvas');
const { CONFIG } = require('./config');
const { logError } = require('./error_logger');
const { log } = require('./logger');
const { ffmpegPath, ffprobePath, ffmpegEncodeArgs } = require('./ffmpeg_utils');
const { StageTimer, addStageMetrics, finalizeJobMetrics } = require('./metrics');

// ... paste functions here ...

module.exports = {
  handleAssemble,
  generateIntroCardPNG,
  generateGameStoryCardPNG,
  generateNewsStoryCardPNG,
  detectTrailingSilence,
  computeNewsClipTrimDuration,
  buildConcatCommand,
  probeDuration,
  checkDiskSpace,
  captureTicker
};
```

---

### Module 4: `lib/publish.js` — Publish + upload pipeline
**Lines to extract:** ~8,849–9,895 (approximately 1,046 lines)

Functions/handlers to move:
- `readUploadStatus()` — line 8849
- `writeUploadStatus(db)` — line 8857
- `logUploadAttempt(entry)` — line 8861
- The `/publish` endpoint handler body — line 8905
- `generateShortFormCaption(script, contentType)` — line 9141
- The `/generate-publish-copy` endpoint handler body — line 9194
- `/publish/status`, `/publish/history`, `/publish/queue`, `/publish/youtube`, `/publish/tiktok`, `/publish/instagram` handler bodies — lines 9643–9895
- `uploadToDrive(filePath, fileName, title)` — line 3403
- `getDriveClient()` — line 1660
- `getDriveFolderId(drive)` — line 1691
- `importToCanva(videoUrl, title)` — line 3472

**`lib/publish.js` template:**
```javascript
'use strict';
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { CONFIG } = require('./config');
const { logError } = require('./error_logger');
const { log } = require('./logger');

// ... paste functions here ...

module.exports = {
  readUploadStatus,
  writeUploadStatus,
  logUploadAttempt,
  uploadToDrive,
  getDriveClient,
  getDriveFolderId,
  importToCanva,
  generateShortFormCaption,
  handlePublish,
  handleGeneratePublishCopy
};
```

---

### Module 5: `lib/chrome_overlay.js` — Newscast chrome + thumbnail generation
**Lines to extract:** ~11,237–11,960 (approximately 723 lines)

Functions to move:
- `generateTwitchLongformThumbnail(options)` — line 11237
- `generateNewsNbaThumbnail(options)` — line 11405
- `burnSceneChromeFromDirective(scene, inputTs, asmId, jobId)` — line 11743
- `generateChromeOverlayFromDirective(directive, context)` — line 11783
- `generateNewscastOverlay(storyData, outputPath, storyIndex, options)` — line 11801

**`lib/chrome_overlay.js` template:**
```javascript
'use strict';
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer');
const { execFile } = require('child_process');
const { CONFIG } = require('./config');
const { logError } = require('./error_logger');
const { ffmpegPath } = require('./ffmpeg_utils');

// ... paste functions here ...

module.exports = {
  generateTwitchLongformThumbnail,
  generateNewsNbaThumbnail,
  burnSceneChromeFromDirective,
  generateChromeOverlayFromDirective,
  generateNewscastOverlay
};
```

---

## How to Do This Safely

### Step-by-step per module

1. **Create the new file** with the template header above
2. **Cut** the functions from server.js, **paste** into the new file
3. **Add** `module.exports` at the bottom of the new file
4. **Add** `const { ... } = require('./lib/modulename');` near the top of server.js (after existing requires)
5. **Run** `node -c server.js` — must exit 0
6. **Run** `node server.js` in a subshell for 5 seconds — must not crash on startup
7. **Commit** that single module before starting the next one

### Order to do them (lowest risk first)

1. `lib/chrome_overlay.js` — self-contained, few cross-dependencies
2. `lib/publish.js` — mostly self-contained, Drive/Canva deps
3. `lib/qa.js` — needs callClaudeAPI decision (extract or pass)
4. `lib/script_gen.js` — largest, most deps, do after QA module
5. `lib/assembly.js` — most complex, do last

### One module per commit

```
refactor(server): extract chrome overlay functions to lib/chrome_overlay.js
refactor(server): extract publish pipeline to lib/publish.js
refactor(server): extract QA gate functions to lib/qa.js
refactor(server): extract script generation to lib/script_gen.js
refactor(server): extract assembly pipeline to lib/assembly.js
```

---

## Hard Rules

1. **ZERO logic changes.** Copy functions exactly as-is. If a function has a bug, that bug stays — fix it in a separate commit after the split.
2. **ZERO new features.** This is a pure file move.
3. **`node -c server.js` must pass after every module.** Don't proceed to the next module if the syntax check fails.
4. **Server must boot after every module.** `node server.js &; sleep 5; curl http://localhost:3000/health` must return 200.
5. **Do NOT split the `app.listen()` call or the startup block** — those stay in server.js.
6. **Do NOT split middleware registration** (`app.use(helmet...)`, `app.use(cors...)`) — stays in server.js.
7. **All other agents hold commits until this is done.** STATUS.md has a lock declared below.

---

## Expected Final State

| File | Lines (approx) |
|---|---|
| `server.js` | ~4,500 (endpoints wired, requires, startup) |
| `lib/chrome_overlay.js` | ~730 |
| `lib/assembly.js` | ~2,050 |
| `lib/publish.js` | ~1,050 |
| `lib/qa.js` | ~1,320 |
| `lib/script_gen.js` | ~1,300 |

Any agent can safely `grep -n + read 50 lines` in a 4,500-line server.js.

---

## Verify Complete

When done, run:
```bash
wc -l server.js
# Must be under 5,000

node -c server.js
# Must exit 0

curl http://localhost:3000/health
# Must return {"status":"ok",...}

grep -rn "require('./lib/" server.js | wc -l
# Should be significantly more than today (currently ~8 requires)
```

Post results in STATUS.md Last Agent Action before declaring done.
