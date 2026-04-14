# CWN Production — Code Review Report
**Date:** 2026-04-14  
**Reviewer:** Cline (automated multi-pass analysis)  
**Scope:** `server.js`, `services/`, `lib/`, `package.json`  
**Pipeline status at review time:** Gate 2 96/100 ✅ | Gate 3 92/100 ✅ | Drive upload ✅

---

## 🔴 CRITICAL — Fix Immediately

### [C-1] Hardcoded Google OAuth2 Client Secret in Source Code
**File:** `server.js` (two locations)  
**Severity:** CRITICAL — credential exposure  

Two separate Google OAuth2 secrets are hardcoded directly in source:

```js
// Location 1 (~line 1604) — has env fallback but secret is still in git history:
const CLIENT_SECRET = process.env.DRIVE_CLIENT_SECRET || 'GOCSPX-REDACTED-ROTATE-IN-GOOGLE-CONSOLE';

// Location 2 (~line 9377) — NO env fallback at all, always hardcoded:
const CLIENT_SECRET = 'YOUTUBE-CLIENT-SECRET-REDACTED';
```

**Risk:** Anyone with repo access (or git history access) can authenticate as your Google account and access/delete Drive files.

**Fix:**
1. **Rotate both secrets immediately** in Google Cloud Console
2. Move both to `.env` as `DRIVE_CLIENT_SECRET` and `DRIVE_CLIENT_SECRET_2` (or consolidate to one OAuth flow)
3. Remove all hardcoded fallback values — fail loudly if env var is missing
4. Add `DRIVE_CLIENT_SECRET` to `validateRequiredEnv()` startup check

---

### [C-2] Hardcoded Google OAuth2 Client ID in Source Code
**File:** `server.js` (~line 9376)  
**Severity:** HIGH — client ID exposure  

```js
const CLIENT_ID = '764086051850-6qr4p6gpi6hn506pt8ejuq83di341hur.apps.googleusercontent.com';
```

This is hardcoded with no env fallback. While Client IDs are less sensitive than secrets, they should still be in `.env`.

**Fix:** `const CLIENT_ID = process.env.DRIVE_CLIENT_ID;` — add to `.env.example`.

---

### [C-3] Puppeteer Called on Module Instead of Browser Instance
**File:** `server.js` (~line 6010)  
**Severity:** HIGH — runtime crash  

```js
const browser = await puppeteer.launch({ ... });
const page = await puppeteer.newPage();  // ❌ WRONG — should be browser.newPage()
```

`puppeteer.newPage()` does not exist on the module. This will throw `TypeError: puppeteer.newPage is not a function` at runtime whenever `/news/generate-intro-card` is called.

**Fix:**
```js
const page = await browser.newPage();  // ✅
```

---

## 🟠 HIGH — Fix Before Next Major Feature

### [H-1] Three Service Files Are Dead Code (Never Imported)
**Files:** `services/assembly.js`, `services/qa.js`, `services/script_generation.js`  
**Severity:** HIGH — maintenance hazard / drift risk  

None of these files are `require()`'d anywhere. `server.js` contains inline duplicate copies of every function they export. This creates a dangerous drift risk: bugs fixed in `server.js` won't be fixed in the service files, and vice versa.

| Service Function | Duplicate in server.js |
|---|---|
| `downloadFile` | ~line 1136 |
| `buildConcatCommand` | ~line 1234 |
| `probeDuration` | ~line 1311 |
| `geminiScriptGeneration` | ~line 2242 |
| `claudeScriptQA` | ~line 2436 |
| `geminiSegmentQA` | ~line 3142 |
| `uploadToGeminiFiles` | ~line 6673 |

**Fix options (pick one):**
- **Option A (recommended):** Delete the `services/` directory entirely since `server.js` is the source of truth
- **Option B:** Wire up the service files properly and remove the inline duplicates from `server.js`

---

### [H-2] Inline `require('child_process')` — 7 Redundant Re-Requires
**File:** `server.js`  
**Severity:** MEDIUM-HIGH — performance + code smell  

`child_process` is required at the top level (line 90), but then re-required inline 7 more times throughout the file:

```js
const { exec } = require('child_process');       // inline re-require
const { execFile } = require('child_process');   // inline re-require (×3)
const { execSync } = require('child_process');   // inline re-require
require('child_process').execFile(...)           // inline re-require (×2)
```

Node.js caches `require()` calls so this isn't a correctness bug, but it's wasteful and inconsistent.

**Fix:** Add `execSync` to the top-level destructure on line 90:
```js
const { execFile, exec, execSync } = require('child_process');
```
Then remove all inline re-requires.

---

### [H-3] Unused Imports at Top of `server.js`
**File:** `server.js` (lines 7, 94–95)  
**Severity:** MEDIUM — dead code / confusion  

| Import | Line | Status |
|--------|------|--------|
| `validateChromeScript` (aliased from `validateScript`) | 7 | **Never called** — validation delegated to `lib/directives.js` |
| `withRetry` | 94 | **Never used** — all retry logic is inside client classes |
| `getFallbackImage` | 94 | **Never called** anywhere in server.js |
| `validateUrl` | 95 | **Never used** as middleware in any route |

**Fix:** Remove unused destructured names from their respective imports.

---

### [H-4] `geminiScriptQA()` — Legacy Function Never Called
**File:** `server.js` (~lines 2871–3132)  
**Severity:** MEDIUM — ~260 lines of dead code  

This function is marked as legacy in comments and is never called. The active QA path uses `geminiSegmentQA()`. The legacy function also re-declares `HEYGEN_AVATAR_ID`, `HEYGEN_VOICE_ID`, `HEYGEN_SPEAK_SPEED` as local constants that are never used in its logic.

**Fix:** Delete `geminiScriptQA()` entirely. If needed for reference, it's in git history.

---

### [H-5] `if (false && ...)` — ~68 Lines of Permanently Dead Code
**File:** `server.js` (~line 4908)  
**Severity:** MEDIUM — dead code  

```js
if (false && headerPng && !isShort) {
  // ~68 lines of FFmpeg intro card logic — completely unreachable
}
```

The `false` literal short-circuits the entire block. Comment says "DISABLED until thumbnail/branding is finalized" with no timeline.

**Fix:** Either delete the block entirely (it's in git history) or convert to a proper feature flag:
```js
const ENABLE_INTRO_CARD = process.env.ENABLE_INTRO_CARD === 'true';
if (ENABLE_INTRO_CARD && headerPng && !isShort) { ... }
```

---

### [H-6] `isClipMatchOnly` Logic Inversion — Surgical Fix Path Is Dead Code
**File:** `server.js` (~lines 8068–8069)  
**Severity:** MEDIUM — silent logic bug  

```js
const hasStructuralFail = scriptQA.deductions.length > 0;
const isClipMatchOnly = !hasStructuralFail && ...;
```

Any Gate 1 failure that has deductions (which is every scored failure) will have `hasStructuralFail = true`, making `isClipMatchOnly` always `false`. The surgical Claude fix path is effectively never reached.

**Fix:** Review the intent. If `isClipMatchOnly` should detect failures where the *only* deduction is a clip-match issue, the condition needs to check deduction *types*, not just presence:
```js
const hasStructuralFail = scriptQA.deductions.some(d => d.type !== 'clip_match');
```

---

## 🟡 MEDIUM — Address in Next Cleanup Sprint

### [M-1] Inconsistent `yt-dlp` Path Resolution
**File:** `server.js` (~lines 6768, 6957)  
**Severity:** MEDIUM — environment inconsistency  

`scrapeArticleVideo()` uses hardcoded absolute path `/opt/homebrew/bin/yt-dlp`, while `geminiAnalyzeClip()` calls `execFile('yt-dlp', ...)` relying on `$PATH`. These will behave differently across environments (e.g., Linux servers, Docker).

**Fix:** Resolve once at startup:
```js
const YT_DLP_PATH = process.env.YT_DLP_PATH || 'yt-dlp';
```
Use `YT_DLP_PATH` everywhere.

---

### [M-2] `wrongAvatar` Dead Variable in `geminiSegmentQA`
**File:** `server.js` (~line 3161)  
**Severity:** LOW — dead variable  

```js
let lipSyncFail = false, audioMissing = false, wrongAvatar = false;
```

`wrongAvatar` is declared but never assigned or read anywhere in the function.

**Fix:** Remove `wrongAvatar` from the destructure.

---

### [M-3] `HEYGEN_AVATAR_ID` / `HEYGEN_VOICE_ID` Re-Declared Per Loop Iteration
**File:** `server.js` (~lines 2903–2905, 3169–3171)  
**Severity:** LOW — performance micro-waste  

These constants are re-declared inside a per-segment loop on every iteration. They should be read once from module-level constants.

**Fix:** Hoist to module level or read from the existing module-level constants.

---

### [M-4] Unused Import in `services/qa.js`
**File:** `services/qa.js` (~line 12)  
**Severity:** LOW  

```js
const { logError } = require('../lib/error_logger');
```

`logError` is imported but never called in the file.

**Fix:** Remove the import (or delete the file per [H-1]).

---

### [M-5] Unused `path` Import in `lib/ffmpeg_utils.js`
**File:** `lib/ffmpeg_utils.js` (~line 8)  
**Severity:** LOW  

```js
const path = require('path');
```

`path` is never referenced in the file — only `require('path').basename()` is used inline.

**Fix:** Either remove the top-level import and keep the inline call, or use the top-level import consistently.

---

### [M-6] `cheerio` Required Inline on Every Call
**File:** `server.js` (~line 6850)  
**Severity:** LOW — style inconsistency  

```js
const cheerio = require('cheerio');  // inside scrapeArticleOgImage()
```

`cheerio` is required inline inside a function that may be called many times. Should be a top-level require.

**Fix:** Move to top-level imports with other `require()` calls.

---

### [M-7] Gate 6 Auto-Publish Failing Silently
**File:** `server.js` (observed in logs)  
**Severity:** MEDIUM — operational  

```
⚠️  Gate 6 auto-publish failed: Request failed with status code 400
   Manual publish: use driveUrl above with /publish endpoint
```

Gate 6 auto-publish is failing with HTTP 400 on every run. The error is swallowed with a warning. The 400 response body (which would explain *why* it's failing) is not logged.

**Fix:** Log the full error response body:
```js
} catch (e) {
  const detail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
  log(asmId, `⚠️  Gate 6 auto-publish failed: ${detail}`);
}
```

---

## 🟢 LOW — Nice-to-Have Cleanup

### [L-1] TODO/FIXME Comments Without Tickets
**File:** `server.js` (multiple locations)  

Several `// TODO` and `// FIXME` comments exist without associated ticket numbers or owners. These should be converted to GitHub Issues or Jira tickets and removed from source.

---

### [L-2] JSDoc Misplacement
**File:** `server.js` (~line 6749)  

The JSDoc comment for `scrapeArticleOgImage` is placed before `scrapeArticleVideo`, not before `scrapeArticleOgImage` (which is defined at ~line 6842). This is confusing for IDE tooling.

**Fix:** Move the JSDoc to immediately precede `scrapeArticleOgImage`.

---

### [L-3] `services/assembly.js` — Unused `path` Import
**File:** `services/assembly.js` (~line 12)  

```js
const path = require('path');
```

`path` is never used in the file (only appears in JSDoc comments).

**Fix:** Remove (or delete the file per [H-1]).

---

## 📊 Summary Table

| ID | Severity | File | Issue | Action |
|----|----------|------|-------|--------|
| C-1 | 🔴 CRITICAL | server.js | Hardcoded Google OAuth2 client secret | Rotate + move to env |
| C-2 | 🔴 HIGH | server.js | Hardcoded Google OAuth2 client ID | Move to env |
| C-3 | 🔴 HIGH | server.js | `puppeteer.newPage()` called on module | Fix to `browser.newPage()` |
| H-1 | 🟠 HIGH | services/ | All 3 service files are dead code | Delete or wire up |
| H-2 | 🟠 MEDIUM | server.js | 7× inline `require('child_process')` | Hoist to top-level |
| H-3 | 🟠 MEDIUM | server.js | 4 unused imports | Remove |
| H-4 | 🟠 MEDIUM | server.js | `geminiScriptQA()` legacy dead function | Delete |
| H-5 | 🟠 MEDIUM | server.js | `if (false && ...)` ~68 lines dead code | Delete or feature-flag |
| H-6 | 🟠 MEDIUM | server.js | `isClipMatchOnly` logic inversion | Fix condition |
| M-1 | 🟡 MEDIUM | server.js | Inconsistent `yt-dlp` path | Centralize to env var |
| M-2 | 🟡 LOW | server.js | `wrongAvatar` dead variable | Remove |
| M-3 | 🟡 LOW | server.js | Constants re-declared per loop | Hoist |
| M-4 | 🟡 LOW | services/qa.js | Unused `logError` import | Remove |
| M-5 | 🟡 LOW | lib/ffmpeg_utils.js | Unused `path` import | Remove |
| M-6 | 🟡 LOW | server.js | `cheerio` inline require | Hoist |
| M-7 | 🟡 MEDIUM | server.js | Gate 6 400 error body not logged | Log response body |
| L-1 | 🟢 LOW | server.js | TODO/FIXME without tickets | Convert to issues |
| L-2 | 🟢 LOW | server.js | JSDoc misplacement | Move JSDoc |
| L-3 | 🟢 LOW | services/ | Unused `path` import | Remove |

---

## 🚀 Recommended Fix Order

1. **Immediately:** Rotate the exposed Google OAuth2 secrets (C-1) — they are in git history
2. **Today:** Fix `puppeteer.newPage()` → `browser.newPage()` (C-3) — runtime crash waiting to happen
3. **This week:** Move all hardcoded credentials to `.env` (C-1, C-2)
4. **Next sprint:** Remove dead service files or wire them up (H-1), remove unused imports (H-3), delete dead code (H-4, H-5)
5. **Cleanup sprint:** Address all MEDIUM/LOW items

---

*Generated by Cline automated code review — 2026-04-14*
