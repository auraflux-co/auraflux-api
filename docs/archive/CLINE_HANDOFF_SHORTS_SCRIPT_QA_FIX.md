# CLINE HANDOFF: Short-Form Script + QA Fixes

**Agent:** Cline-A
**Priority:** MEDIUM — blocks all 3 short-form smoke tests
**Status:** READY — root causes identified, exact fix locations documented
**Ship after:** `CLINE_HANDOFF_SHARED_CHROME_SKINS.md`

---

## Background

Short-form pipeline is mechanically wired end-to-end (buttons → script gen → HeyGen → assembly → output). The blocking issue is Gate 1 quality: last Twitch short scored 40/100 HARD FAIL with three specific failures:
1. Wrong outro — "Subscribe to ClipzWorld News" instead of "Subscribe. Appreciate you."
2. Hallucinated clip content — Gemini described what it imagined, not what it watched
3. Wrong streamer attribution — called a streamer by wrong name without evidence

Two of these are Gate 1 QA bugs, not prompt bugs. One is a clip selection bug in assembly.

---

## Fix 1 — Twitch short outro (prompt fix)

**File:** `server.js`
**Location:** Line ~6841 — `'twitch-short'` system prompt in the `SHORT_FORM_PROMPTS` object

**Current:**
```javascript
OUTRO (spoken): "Follow [streamer]. Link in description. Subscribe."
```

**Fix:**
```javascript
OUTRO (spoken): "Subscribe. Appreciate you."
```

The "Follow [streamer]. Link in description." CTA is long-form only. Short-form outro is always "Subscribe. Appreciate you." — matches the CLAUDE.md spec and the `nba-short` / `news-short` prompts which already have it correct.

---

## Fix 2 — Gate 1 QA: disable wrong-clip-count deduction for short-form

**File:** `server.js`
**Function:** `claudeScriptQA()` — line ~2457
**Location:** Line ~2504 — `expectedClips` calculation

**Current:**
```javascript
const expectedClips = contentType === 'twitch' ? streamers.length * clipsPerStreamer : clipAnalyses.length;
const wrongClipCount = Math.abs(clipMarkers - expectedClips) > 1;
```

**Problem:** Short-form always has 1 clip and 1 `[CLIP PLAYS HERE]` marker. But `expectedClips` for `twitch-short` calculates `1 streamer × 2 clipsPerStreamer = 2`, so Gate 1 always deducts for "wrong clip count" even when the script is correct.

**Fix:** Short-form expects exactly 1 clip:
```javascript
const isShortForm = contentType.includes('-short');
const expectedClips = isShortForm ? 1
  : contentType === 'twitch' ? streamers.length * clipsPerStreamer
  : clipAnalyses.length;
const wrongClipCount = Math.abs(clipMarkers - expectedClips) > 1;
```

---

## Fix 3 — Gate 1 QA: disable wrong-scene-count deduction for short-form

**File:** `server.js`
**Function:** `claudeScriptQA()` — line ~2523

**Current:**
```javascript
const wrongSceneCount = expectedScenes > 0 && sceneMarkers !== expectedScenes;
```

**Problem:** `expectedScenes` for long-form is `1 + (streamers × 7) + 1`. For short-form it's passed as the same long-form calculation, causing Gate 1 to deduct 25 points for "wrong scene count" when a short has only 1 scene header.

**Fix:** Short-form always has exactly 1 scene header (`=== NBA SHORT ===`, `=== TWITCH SHORT ===`, `=== NEWS SHORT ===`):
```javascript
const isShortForm = contentType.includes('-short');
const wrongSceneCount = !isShortForm && expectedScenes > 0 && sceneMarkers !== expectedScenes;
```

---

## Fix 4 — Gate 1 Claude prompt: short-form aware checklist

**File:** `server.js`
**Function:** `claudeScriptQA()` — find the `claudePrompt` string built inside the function (after the `clipSummaries` block, line ~2560+)

The Claude prompt that gets sent for QA review currently uses long-form rules. Add a short-form branch so Claude checks the right things.

Find the section that builds the Claude prompt text and add a conditional:

```javascript
const isShortForm = contentType.includes('-short');

const shortFormRules = isShortForm ? `
SHORT-FORM RULES (this is a ${contentType} short — apply these instead of long-form rules):
- Total spoken word count: 40-70 words TOTAL. This is the whole script, not per section.
- MUST have exactly 1 [CLIP PLAYS HERE] marker
- MUST have exactly 1 scene header (=== NBA SHORT ===, === TWITCH SHORT ===, or === NEWS SHORT ===)
- MUST end with "Subscribe. Appreciate you." — any other outro is a -25 deduction
- MUST NOT have multiple streamers or multiple clips
- DO NOT deduct for missing long-form sections (no intro card, no setup/reaction structure needed)
- DO NOT deduct for short total word count — 40-70 words is CORRECT for short-form
- DO check: does the script reference what actually happened in the clip analysis? (-15 if hallucinated)
- DO check: is the streamer name correct and matching the clip analysis? (-20 if wrong)
` : '';
```

Then prepend `shortFormRules` to the existing Claude prompt string before sending.

---

## Fix 5 — Assembly: use script-matched clip, not random clip

**File:** `server.js`
**Location:** Line ~3924 — inside the `isShortForm` assembly branch

**Current:**
```javascript
// Select ONE random source clip for top half
let selectedClip = null;
if (clipFiles.length > 0) {
  const randomIdx = Math.floor(Math.random() * clipFiles.length);
  selectedClip = clipFiles[randomIdx];
  log(asmId, `  🎲 Selected random clip ${randomIdx + 1}/${clipFiles.length}: ${path.basename(selectedClip)}`);
}
```

**Problem:** Short-form scripts reference a specific clip. Assembly picks a random one, so Bobby G's spoken reaction may not match what's playing.

**Fix:** Use the first source clip (index 0) — the clips are already ordered to match the script by the time they reach assembly. The random selection was a placeholder:

```javascript
// Use the first source clip — clips are script-ordered, index 0 matches the script
let selectedClip = clipFiles.length > 0 ? clipFiles[0] : null;
if (selectedClip) {
  log(asmId, `  🎯 Using script-matched clip: ${path.basename(selectedClip)}`);
} else {
  log(asmId, `  ⚠️  No source clip found — using black frame`);
}
```

---

## Priority Order

1. **Fix 1** (Twitch outro) — 1-line prompt change, ship immediately
2. **Fix 2 + Fix 3** (Gate 1 clip/scene count for short-form) — 2 conditional checks, removes the 50-point structural penalty that causes all short-form scripts to hard-fail regardless of quality
3. **Fix 4** (Claude QA checklist) — adds short-form awareness to the Claude review prompt
4. **Fix 5** (random clip → first clip) — prevents Bobby G's spoken reaction from mismatching the visible clip

---

## Test After Fix

Run a Twitch short (single streamer, single clip). Verify:
1. Gate 1 score is no longer hard-failing due to scene count / clip count mismatches
2. Gate 1 Claude report checks for "Subscribe. Appreciate you." not "Follow [streamer]"
3. Assembly log shows `🎯 Using script-matched clip` not `🎲 Selected random clip`
4. Output video: Bobby G reaction on top, source clip on bottom, 1080×1920, ~45-60 seconds
