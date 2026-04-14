# CLINE_HANDOFF_NEWS_CHROME_FIX.md

**Author:** Claude Code, 2026-04-14
**For:** Cline
**Scope:** Fix the News chrome overlay pipeline — TV card, lower-third flag, and story sidebar are all missing from every rendered News MP4. Two confirmed root causes, four secondary fixes for robustness.
**Priority:** BLOCKING — News long-form cannot lock until all chrome elements render.
**Do NOT touch:** Twitch/NBA chrome paths, Gate 1 scoring rubric, `lib/chromeDirectives.js` schema (approved by Gemini, do not change).
**Before commit:** Re-read `COMMIT_CHECKLIST.md`. Update `STATUS.md` Last Agent Action table.

---

## Root Cause Summary

Gemini reviewed 11 extracted frames from the last News run (Gates 2+3 auto-passed 96/100, 92/100) and confirmed: top bar, ticker, CWN logo all working. TV card, lower-third flag, and story sidebar are 100% absent across every frame. Two confirmed root causes:

**Root cause A — `assemblyJobId` is always `undefined` in the assembly endpoint.**

The assembly endpoint at `server.js:3466` reads `jobId: assemblyJobId` from `req.body`. The directive file check at `server.js:4197` is:

```js
if (USE_DIRECTIVE_CHROME && assemblyJobId && hasDirectiveForJob(assemblyJobId)) {
```

The dashboard's assembly payload (built at `cwn_production.html:1423-1432`) never includes `jobId`. So `assemblyJobId` is always `undefined`. `undefined && ...` short-circuits to `false`. The directive path is NEVER entered. Chrome always falls through to legacy (which also has no data). Result: blank chrome on every scene.

**Root cause B — directive sidecar write failure is silently swallowed.**

At `server.js:8127-8129`, the sidecar write catch block does `console.warn(...)`. If Zod rejects the Gemini-generated directive (e.g., missing required fields like `estimatedDurationSec`, `storyList` as objects), the error is a warning. The assembly runs, Gate 2+3 pass, and nobody notices chrome was never written. Upgrade to `console.error` so it's impossible to miss.

---

## Fix 1 — Dashboard: send `jobId` in assembly payload (CRITICAL)

**File:** `cwn_production.html`
**Location:** ~line 1423 — the `payload` object built before `xhr.send(JSON.stringify(payload))`

The server returns `metricsJobId` in the `/generate-full-script` response (line 8216). This is the script-generation jobId that the directive sidecar was keyed to. The dashboard must store this on the job and pass it in the assembly call.

**Step 1 — Store `metricsJobId` when script generation completes.**

In `callFullScriptServer()` at `cwn_production.html:2853`, find the `xhr.onload` block. After the existing `resp.orderedClipUrls` handling (around line 2896), add:

```js
// Store the script generation jobId so assembly can load the directive sidecar
if (resp.metricsJobId) {
  window.CURRENT_META = window.CURRENT_META || {};
  window.CURRENT_META.scriptJobId = resp.metricsJobId;
  console.log('[script] Stored scriptJobId for directive sidecar:', resp.metricsJobId);
}
```

Also store it on the JOBS entry. In the block around line 2872-2880 where `displayScriptQA` is called, find where the current News job is being tracked (the job being assembled is in the JOBS array with id matching the HeyGen video IDs). The simplest approach: store it on `window.CURRENT_META.scriptJobId` and reference that in the assembly call below.

**Step 2 — Include `jobId` in the assembly payload.**

In the `payload` object at `cwn_production.html:1423-1432`, add `jobId`:

```js
var payload = {
  segmentData: segmentData,
  segments: segmentData.map(function(s){ return s.url; }),
  labels:   segmentData.map(function(s){ return s.label; }),
  transition: CFG.transition,
  format: CFG.outputFmt,
  outputDir: CFG.outputDir,
  jobTitle: job.title,
  contentType: job.type || 'twitch',
  jobId: (window.CURRENT_META && window.CURRENT_META.scriptJobId) || job.scriptJobId || ''
};
```

Also store `scriptJobId` on the job object itself so it survives page reloads. When `CURRENT_META.scriptJobId` is set after script gen, update the matching JOBS entry:

```js
// In callFullScriptServer xhr.onload, after storing scriptJobId:
var currentJob = JOBS.find(function(j){ return j.status !== 'failed'; });
if (currentJob && resp.metricsJobId) {
  currentJob.scriptJobId = resp.metricsJobId;
  saveJobs();
}
```

This approach is resilient: `job.scriptJobId` persists in localStorage, so assembly after a page reload still has the right ID.

---

## Fix 2 — server.js: upgrade sidecar error to `console.error` (CRITICAL for visibility)

**File:** `server.js`
**Location:** `server.js:8127-8129`

Current code:
```js
} catch(sidecarErr) {
  console.warn(`[generate-full-script] ⚠️  Failed to write directive sidecar: ${sidecarErr.message} — continuing with extracted spoken text`);
}
```

Change to:
```js
} catch(sidecarErr) {
  console.error(`[generate-full-script] ❌ DIRECTIVE SIDECAR WRITE FAILED: ${sidecarErr.message}`);
  console.error('[generate-full-script] Chrome elements (TV card, flag, sidebar) will NOT render in assembly.');
  console.error('[generate-full-script] Fix: ensure Gemini News prompt emits all required Zod fields (scriptVersion, clientId, brandConfig.episodeNumber as integer, per-scene estimatedDurationSec as positive number, storyList as array of objects).');
}
```

After making Fix 1 and running a smoke test, check the server console. If this error fires, the Gemini News prompt is missing fields — see Fix 3.

---

## Fix 3 — Verify Gemini News prompt emits all required Zod fields

**File:** `server.js`
**Location:** Find the News Gemini prompt (search for `scriptVersion` or `Red 4: JSON CHROME DIRECTIVE FORMAT`)

The `lib/chromeDirectives.js` Zod schema (`ScriptSchema`) requires ALL of the following. Verify the prompt template includes examples with each:

| Field | Type | Common mistake |
|---|---|---|
| `scriptVersion` | `z.literal(1)` | Must be integer `1`, not string `"1"` |
| `contentType` | `z.literal("news")` | Must be exactly `"news"` |
| `clientId` | `z.literal("cwn")` | Must be exactly `"cwn"` |
| `brandConfig.episodeNumber` | `z.number().int().positive()` | Must be an integer, not a string |
| `estimatedTotalDurationSec` | `z.number().positive()` | Required at top level |
| `storyList` | array of `{index: number, title: string, source: string}` | Must be objects, not strings |
| Per avatar scene: `estimatedDurationSec` | `z.number().positive()` | Missing on avatar scenes is the most common Zod rejection |
| Per source_clip scene: `type: "source_clip"` | Must NOT have `spokenText` field | Zod discriminated union — `spokenText` is only on avatar scenes |

The prompt must include a JSON example that contains all required fields. After verifying (or fixing) the prompt, run a smoke test and look for the `✅ Directive sidecar written for job` log line in the server console.

---

## Fix 4 — `tools/clipzworld_newscast.html`: clear DOM default placeholder text (required before lock)

**File:** `tools/clipzworld_newscast.html`
**Location:** Find line with `Global Markets React to Federal Reserve Rate Decision` (approximately line 422)

This is fixture text baked into the HTML DOM. If the page.evaluate block ever fails silently (injection guard misses), this text appears in the lower-third of the rendered overlay — which would look worse than no overlay.

**Change:** Replace the content of `<div class="lt-headline">...</div>` with an empty string:

```html
<div class="lt-headline"></div>
```

Low risk, one line, eliminates any possibility of stale fixture text in production.

---

## Fix 5 — `server.js` Puppeteer: fix font loading race (required before lock)

**File:** `server.js`
**Location:** Find the `generateNewscastOverlay()` function. Inside it, find the `await new Promise(resolve => setTimeout(resolve, 500))` call before the screenshot.

The 500ms sleep is a band-aid for Google Fonts loading (Bebas Neue, Barlow Condensed). It's non-deterministic — if CDN is slow, fonts may not load in 500ms and the screenshot uses Arial fallback.

**Change:** Replace the raw setTimeout with a proper font-ready check:

```js
// Replace:
await new Promise(resolve => setTimeout(resolve, 500));

// With:
await page.evaluate(() => document.fonts.ready);
await new Promise(resolve => setTimeout(resolve, 100)); // minimal buffer
```

The `document.fonts.ready` Promise resolves only after all @font-face fonts are loaded. This makes the font render deterministic regardless of CDN latency.

---

## Fix 6 — `server.js` Puppeteer: fix TV card image loading race (required before lock)

**File:** `server.js`
**Location:** Inside `generateNewscastOverlay()`, find the `page.evaluate` block where `tvCardImg.src` is set to `opts.tvCard.imageUrl`. The screenshot is taken ~500ms after this line.

When `tvCardImg.src` is set inside `page.evaluate`, the image fetch starts AFTER `networkidle0` has already resolved. The 500ms sleep does not guarantee the Al Jazeera og:image has loaded. Result: TV card renders with a broken-image icon or navy background instead of the article photo.

**Change:** Make the `page.evaluate` callback `async` and await the image load:

First, change the `page.evaluate` callback signature from:
```js
await page.evaluate((data, activeIndex, opts) => {
```
to:
```js
await page.evaluate(async (data, activeIndex, opts) => {
```

Then, after setting `tvCardImg.src`, add:
```js
if (tvCardImg && opts && opts.tvCard && opts.tvCard.imageUrl) {
  tvCardImg.src = opts.tvCard.imageUrl;
  // Wait for image to load (with timeout). If 404 or timeout, card shows navy bg — acceptable.
  await new Promise(resolve => {
    if (tvCardImg.complete && tvCardImg.naturalWidth > 0) { resolve(); return; }
    tvCardImg.onload = resolve;
    tvCardImg.onerror = resolve; // accept failed load
    setTimeout(resolve, 3000);  // 3s hard timeout
  });
}
```

This ensures the TV card image is fully loaded before the screenshot fires.

---

## Coordinate Approval (Gemini-approved — DO NOT change these)

Gemini reviewed the frames and approved all coordinates as currently implemented in the HTML. The SET_DESIGN_SPEC_NEWS.md had minor spec/implementation mismatches — the HTML values are correct:

| Element | Approved position |
|---|---|
| Lower-third flag | x=0, y=48 (below top bar), 720×88px |
| Story sidebar | right: 32px, width: 420px, top: 120px |
| TV card | x=1240, y=40, 520×293px |
| Logo (News) | x=1725, y=910, 90×90px, 0.85 opacity |
| Ticker | x=0, y=1016, 1920×64px |

**DO NOT change the HTML coordinates** — they match the approved design. The spec doc needs updating (see below) but the code is correct.

---

## Smoke Test Checklist

After shipping all 6 fixes, run a News long-form smoke test and verify:

1. **Server console shows:** `[generate-full-script] ✅ Directive sidecar written for job script_news_XXXXXXXXXX`
2. **Server console shows:** `[assembly] ✅ Directive found for job script_news_XXXXXXXXXX — using directive chrome path`
3. **Frame at 3s (COLD_OPEN):** Top bar ✅, ticker ✅, logo ✅ — no flag, no sidebar, no TV card
4. **Frame at first STORY_INTRO (~30s):** Top bar ✅, ticker ✅, logo ✅, **TV card ✅ (article image)**, **lower-third flag ✅ (headline text)**, **sidebar ✅ (5 stories, story 1 "▶ ON AIR")**
5. **Frame at STORY_SETUP (~45s):** TV card ❌ (gone), flag ✅ (still same story), sidebar ✅ (still same story "▶ ON AIR")
6. **Frame at SOURCE_CLIP (~60s):** Clip full-bleed, flag ❌, sidebar ❌, TV card ❌, ticker ✅, logo ✅
7. **Story 2 INTRO:** Sidebar shows story 2 "▶ ON AIR", TV card has story 2's og:image
8. **No "Global Markets React" fixture text** appears anywhere in the video

If steps 1-2 show but chrome is still absent, the HTML page.evaluate injection has a bug — check the guard conditions in `generateNewscastOverlay()` that control `hideSidebar`, `ltHeadline.textContent`, and `tvCard` display.

---

## Files to change

| File | Fix |
|---|---|
| `cwn_production.html` | Fix 1: store `metricsJobId` on job, include `jobId` in assembly payload |
| `server.js` | Fix 2: upgrade sidecar catch to `console.error` |
| `server.js` | Fix 3: verify/fix Gemini News prompt for required Zod fields (read, don't assume) |
| `tools/clipzworld_newscast.html` | Fix 4: clear `lt-headline` DOM default text |
| `server.js` | Fix 5: font loading — replace 500ms setTimeout with `document.fonts.ready` |
| `server.js` | Fix 6: TV card image race — make page.evaluate `async`, await image load |

**Spec-only (no code change):**
- Update `SET_DESIGN_SPEC_NEWS.md` section 3.1 y-coordinate from `y=0` to `y=48`
- Update `SET_DESIGN_SPEC_NEWS.md` section 3.2 from `x=1560, y=400, 320×600` to `right: 32px, width: 420px, top: 120px`
- Update `SET_DESIGN_SPEC_NEWS.md` section 3.3 from `x=1360, y=60` to `x=1240, y=40`

---

**Commit message (suggested):**
```
fix(news): wire directive sidecar jobId to assembly, fix Puppeteer race conditions

- cwn_production.html: store metricsJobId from /generate-full-script response,
  include jobId in assembly payload so hasDirectiveForJob() finds the sidecar
- server.js: upgrade sidecar write failure from console.warn to console.error
- tools/clipzworld_newscast.html: clear lt-headline DOM default placeholder text
- server.js: replace 500ms setTimeout with document.fonts.ready for deterministic font render
- server.js: make page.evaluate async, await TV card image load with 3s timeout

Root cause: assemblyJobId was always undefined (dashboard never sent it), so
USE_DIRECTIVE_CHROME guard short-circuited and chrome always used legacy path.
```
