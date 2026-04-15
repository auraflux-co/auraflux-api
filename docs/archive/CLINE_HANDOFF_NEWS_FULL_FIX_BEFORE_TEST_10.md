# CLINE_HANDOFF_NEWS_FULL_FIX_BEFORE_TEST_10.md

**Author:** Claude Code, drafted 2026-04-13 evening after Rob's "ship everything before next test" directive
**For:** Cline
**Scope:** Ship ALL remaining Phase 1 News long-form fixes in a single multi-commit session BEFORE firing News smoke test #10. Rob's rule: stop testing while partial fixes remain — wasted HeyGen spend on unshippable outputs. Test #10 fires only when News is fully production-worthy.
**Ship order:** 4 commits, sequential, each independently revertable. Execute top-to-bottom.
**Do NOT touch:** NBA, Twitch, short-form code paths. Even though the directive architecture (Red 4) will eventually benefit those content types, Phase 1 scope is News-only.
**Before each commit:** Re-read `COMMIT_CHECKLIST.md`. Atomic staging. STATUS.md update. `LONGFORM_FIX_ROTATION.md` update.

---

## Context — why this handoff exists

Rob reviewed News smoke test #9 (`news_monday_april_13_2026_18_avatar_4_cl_4clips_1776114960751.mp4`) and flagged 4 categories of production-blocking issues. Track A (framing + clip cap) and Track C (pre-validation) already shipped as `4ba6de2` + `7b3f128`. This handoff addresses the 4 remaining issues before News can be called "locked":

- **Red 1:** Chrome sync issues — flag text / sidebar / TV card state machine doesn't stay in sync with the actual story moment
- **Red 2:** Al Jazeera watermark logo baked into every clip (bottom-right corner)
- **Red 3:** Al Jazeera clips may start with branding intro cards; first-25s cap shows branding instead of content
- **Red 4:** Chrome state machine is reactive (infers state from scene labels via string matching at assembly time) — Rob wants it rewritten to proactive (Gemini emits chrome directives per scene, assembly reads them literally)

Rob's direction 2026-04-13 PM:

> "i dont want to keep testing if its not going to pass the requirements of the set design, clips coming in at right time etc, we wouldnt produce a show live if had all of these issues, so i want to get everything in and then fix from there"

> "cline has never taken longer than 20mins just fyi -- just ship everything now that is for news getting past"

Recalibration: the full proactive architecture rewrite (Red 4) was originally scoped as 9-13 days of human-speed work. With Cline's 20-min-per-task velocity, the same subtask list completes in ~3 hours. Red 1+2+3 add another 2-4 hours. Total: ~5-7 hours of focused Cline work. Shippable tonight.

**Tonight's goal:** 4 commits land, Rob hard-refreshes dashboard, Rob fires News smoke test #10. Test #10 is the first News test run against the fully-fixed architecture — no more partial fixes, no more "it's 80% there."

---

## Ship order (strict, sequential)

1. **Commit 1 — Red 2 (watermark mask)** — simplest, fastest, no conflict with other tracks. 15-30 min.
2. **Commit 2 — Red 3 (intro card skip)** — verifies the "does AJ front-load content" assumption and adjusts clip offset. 30-45 min.
3. **Commit 3 — Red 4 (proactive directive architecture)** — the big one, rewrites the chrome state machine. 2-3 hours.
4. **Commit 4 — Red 1 (remaining surgical chrome bandaids)** — applied AFTER Red 4 lands because most of Red 1's bandaids become unnecessary once Red 4 is live. 30-60 min for whatever residual issues remain.

**Why Red 4 before Red 1:** if Red 4 works, the reactive state machine is gone — there's nothing for Red 1 to patch. The remaining Red 1 scope after Red 4 is "content-level chrome mistakes in Gemini's directives" which is a Gemini prompt tuning task, not a state machine patch.

---

## Commit 1 — Red 2: Al Jazeera watermark mask

**Effort:** 15-30 minutes
**Files:** `server.js` (News source_clip normalization pass), `STATUS.md`, `LONGFORM_FIX_ROTATION.md`
**Risk:** low — additive FFmpeg filter, doesn't touch other code paths

### The problem

Gemini Gate 3 report on News smoke test #8 noted: *"The Al Jazeera branding is consistently visible in the bottom right corner of the source clips."* This is a persistent watermark baked into Al Jazeera's source video — not something CWN adds. Fix 9's silencedetect trim handled only the trailing red outro CARD (branded end slate), not the always-on corner watermark during playback.

CWN already credits Al Jazeera in the video description. The corner watermark is redundant attribution that clutters the frame and dilutes CWN's brand consistency.

### The fix

Add an FFmpeg `boxblur` filter to the News source_clip normalization pass (same location where Track A's letterbox-fit filter landed at `server.js:4377` and the 25s cap at `~4379`). The boxblur region covers the bottom-right corner where Al Jazeera's logo lives.

**Approximate logo size:** 80×40 pixels in the bottom-right corner of a 1920×1080 frame. Add 20px padding around the detected logo region for safety: **120×80 pixels at `(1780, 960)`**.

### Implementation

In the current News source_clip filter chain at `server.js:4377` (after Track A's letterbox-fit swap):

```javascript
const vfFilter = isAvatarSeg
  ? 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,fps=fps=30'
  : 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x0d1424,fps=fps=30';
```

For News `source_clip` segments ONLY (not avatar, not other content types), append a `boxblur` region filter to the chain:

```javascript
// Red 2: mask the Al Jazeera bottom-right corner watermark with a blur region
// 120x80 box at (1780, 960) covers the logo + 20px safety padding
const watermarkMask = ",split=2[main][masked];[masked]crop=120:80:1780:960,boxblur=10:2[blurred];[main][blurred]overlay=1780:960";

const vfFilter = isAvatarSeg
  ? 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,fps=fps=30'
  : 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x0d1424,fps=fps=30' +
    (contentType === 'news' ? watermarkMask : '');
```

**WAIT — this is wrong.** You cannot append a split/overlay chain to a simple `-vf` filter string — that's a filter_complex pattern, not a filter pattern. The chain has to be restructured.

**Correct implementation:** switch the News source_clip branch to use `-filter_complex` instead of `-vf` for that specific case:

```javascript
// For News source_clip segments, use filter_complex to chain scale+pad+watermark-blur
if (contentType === 'news' && seg.type === 'source_clip') {
  const fcFilter = [
    // Scale + letterbox-fit (same as Track A)
    '[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x0d1424,fps=fps=30[scaled];',
    // Split into main + watermark region
    '[scaled]split=2[main][mask_region];',
    // Crop the watermark region, blur it, overlay back onto main
    '[mask_region]crop=120:80:1780:960,boxblur=10:2[blurred];',
    '[main][blurred]overlay=1780:960[out]'
  ].join('');

  // Replace -vf args with -filter_complex + -map
  // args currently has '-vf', vfFilter — find and replace
  const vfIdx = args.indexOf('-vf');
  if (vfIdx !== -1) {
    args.splice(vfIdx, 2); // remove '-vf' and its value
  }
  args.push('-filter_complex', fcFilter, '-map', '[out]', '-map', '0:a?');
}
```

**OR (simpler approach):** just use `drawbox` filter inline in the existing `-vf` chain. `drawbox` supports the simple `-vf` syntax:

```javascript
const vfFilter = isAvatarSeg
  ? 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,fps=fps=30'
  : 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x0d1424,fps=fps=30' +
    (contentType === 'news' ? ',drawbox=x=1780:y=960:w=120:h=80:color=0x0d1424@1.0:t=fill' : '');
```

**`drawbox` pros:** single filter, single chain, no filter_complex rewrite, keeps the existing `-vf` arg pattern clean.

**`drawbox` cons:** it's a solid color box (navy `#0d1424`), not a blur. Visually more obvious than a blur but simpler to ship tonight.

**My vote:** ship `drawbox` tonight. It's a solid CWN navy rectangle over the Al Jazeera logo. Matches the letterbox bar color from Track A so it reads as "intentional CWN masking" not "something broken." If Rob later wants the blur aesthetic, Red 2 v2 ships it as a filter_complex rewrite. For now, solid box is fast and correct.

### Verification

- Grep: `grep -n "drawbox=x=1780" server.js` should return one hit
- `node -c server.js` exit 0
- Extract frame from a resulting News `story*_clip.ts` file — bottom-right corner should be a solid `#0d1424` navy rectangle covering where the Al Jazeera logo was

### Commit message

```
feat(news): mask Al Jazeera corner watermark with CWN navy box (Red 2)

Al Jazeera's bottom-right corner logo is baked into the source video
pixels — not something CWN adds. Fix 9's silencedetect trim handled
only the trailing red outro CARD, not the always-on watermark during
playback. Gemini Gate 3 on test #8 flagged it: "The Al Jazeera
branding is consistently visible in the bottom right corner of the
source clips."

CWN credits Al Jazeera in the video description already. Corner
watermark is redundant attribution that clutters the frame.

Fix: drawbox filter in News source_clip normalization pass. Covers
bottom-right 120x80 region at (1780, 960) with a solid CWN dark navy
#0d1424 rectangle. Matches the letterbox bar color from Track A so
it reads as intentional framing, not a mask job.

Only applied to News source_clip segments (contentType === 'news').
Avatar segments and non-News content types untouched.

References: News smoke test #9 review 2026-04-13 PM, Rob directive
"ship everything now that is for news getting past"
```

---

## Commit 2 — Red 3: clip offset / intro card skip

**Effort:** 30-45 minutes
**Files:** `server.js` (News source_clip normalization pass + optional yt-dlp metadata probe), `STATUS.md`, `LONGFORM_FIX_ROTATION.md`
**Risk:** medium — requires probing the source clip to decide offset, could add latency per clip

### The problem

Al Jazeera's `/video/newsfeed/` clips may start with branding intro cards — 10-15 seconds of "Al Jazeera English presents" logo animation before the real content begins. Track A's hard 25s cap means those clips play 10-15 seconds of branding + 10-15 seconds of actual content, which is inverted from what we want.

### Verification step FIRST

Before implementing, Cline should verify the problem actually exists. Download a fresh Al Jazeera `/video/newsfeed/` clip and extract the first 5 seconds of frames:

```bash
# Pick one URL from the recent Al Jazeera us-canada scrape
yt-dlp -o "/tmp/aj_test_%(id)s.%(ext)s" "https://www.aljazeera.com/video/newsfeed/2026/4/13/trump-doubles-down-in-pope-feud-refuses-to-apologise"

# Extract frames at 0s, 2s, 4s, 6s, 8s, 10s
for ts in 00:00:00 00:00:02 00:00:04 00:00:06 00:00:08 00:00:10; do
  L=$(echo "$ts" | tr ':' '_')
  ffmpeg -ss $ts -i /tmp/aj_test_*.mp4 -frames:v 1 -q:v 3 /tmp/aj_intro_check_${L}.jpg -y 2>&1 | tail -1
done

ls -la /tmp/aj_intro_check_*.jpg
```

Open the frames in Preview or an image viewer. **If the first 5-10 seconds show an Al Jazeera branding card / logo animation / "presents" slate, the problem exists.** If the first frame shows real content (reporter, footage, subject), there's no intro card and Red 3 is a no-op.

### If intro cards exist — the fix

Two implementation options:

**Option A — Fixed 5-second offset on every clip:**

Prepend `-ss 5` to every News source_clip FFmpeg command. Skips the first 5 seconds universally. 25s cap still applies AFTER the offset, so effective clip window is from 5s to 30s of source.

```javascript
// In the News source_clip normalization args construction:
if (contentType === 'news' && seg.type === 'source_clip') {
  args.unshift('-ss', '5'); // Prepend — FFmpeg applies -ss before -i for seek
  // then existing args including '-t' 25 for hard cap
}
```

Simple. Doesn't need a probe. Assumes every clip has ≥5s of branding.

**Option B — yt-dlp metadata probe + conditional offset:**

Use `yt-dlp --dump-json` (Track C already does this for validation) to extract the clip's chapter markers or description. If the metadata indicates an intro section, use its end time as the offset. Otherwise, use offset 0.

More accurate but requires parsing Al Jazeera's chapter data, which may not exist in their metadata.

**My vote:** ship **Option A (fixed 5s offset)** tonight. It's the simplest fix that solves the common case. If some clips don't have intros, we lose 5 seconds of real content at the start — acceptable tradeoff because Al Jazeera journalism pattern puts the headline/hook in the first 30 seconds, and 5s-30s is still hook territory.

**If Cline's verification step shows NO intro cards exist, skip this commit entirely.** Don't ship Red 3 as a no-op fix. Document the verification result in the commit-skip note and move to Red 4.

### Implementation for Option A

Find the News source_clip FFmpeg args construction in `server.js` (same block as Track A's -t 25 logic, around line 4379). Add the `-ss` argument:

```javascript
if (contentType === 'news' && seg.type === 'source_clip') {
  // Red 3: skip first 5 seconds to avoid Al Jazeera intro branding cards
  const NEWS_CLIP_INTRO_SKIP_SECONDS = 5;

  // Must come BEFORE '-i' in args for seek-before-decode (faster + accurate)
  const iIdx = args.indexOf('-i');
  if (iIdx !== -1) {
    args.splice(iIdx, 0, '-ss', String(NEWS_CLIP_INTRO_SKIP_SECONDS));
  }

  log(asmId, `  ⏩ News clip ${path.basename(selectedClip)}: skipping first ${NEWS_CLIP_INTRO_SKIP_SECONDS}s (intro card)`);

  // Existing NEWS_CLIP_MAX_SECONDS=25 cap still applies via '-t' AFTER offset
  // Effective clip window: 5s to 30s of source
}
```

**Important:** place `-ss` BEFORE `-i <input>` in the args array. FFmpeg's fast seek mode applies `-ss` as an input option (seek before decode), which is accurate for known-keyframe sources. If `-ss` is placed AFTER `-i`, it becomes an output option (decode-then-seek) which is slower and less accurate.

### Verification

- Grep: `grep -n "NEWS_CLIP_INTRO_SKIP_SECONDS" server.js` returns the definition + usage
- `node -c server.js` exit 0
- After commit, next smoke test produces `_clip.ts` files whose first frame shows real content (not an Al Jazeera branding card)

### Commit message

```
feat(news): skip first 5 seconds of Al Jazeera clips to avoid intro branding (Red 3)

Al Jazeera's /video/newsfeed/ clips start with ~5-15 seconds of
branding intro cards ("Al Jazeera English presents" animation).
Track A's 25s hard cap counted from 0s, so clips played 10-15
seconds of branding + 10-15 seconds of real content. Inverted.

Fix: prepend -ss 5 to every News source_clip FFmpeg command. Skips
first 5 seconds universally. -t 25 cap still applies AFTER offset,
so effective window is 5s to 30s of source.

Placed BEFORE -i input flag for FFmpeg fast seek mode (seek before
decode). Accurate for keyframe-aligned sources.

Tradeoff: if a clip has no intro card, we lose the first 5 seconds
of real content. Acceptable because Al Jazeera front-loads hooks in
the first 30 seconds, and 5s-30s is still hook territory.

Only applied to News source_clip segments. NBA/Twitch untouched.

References: News smoke test #9 review, Rob directive "ship everything
now that is for news getting past"
```

---

## Commit 3 — Red 4: proactive chrome directive architecture

**Effort:** 2-3 hours of Cline work (per recalibrated velocity estimate)
**Files:** `server.js` (Gemini News prompt + Claude Gate 1 QA + assembly chrome burn), `lib/chromeDirectives.js` (new — schema + validator), `tools/clipzworld_newscast.html` (minor toggle updates), `STATUS.md`, `LONGFORM_FIX_ROTATION.md`, `GATED_PIPELINE_ARCHITECTURE.md` (documentation update)
**Risk:** high — rewrites the chrome state machine. Guarded by feature flag for emergency rollback.
**Reference:** `CHROME_DIRECTIVE_ARCHITECTURE.md` is the full design spec for this track. Read it first.

### The vision

Shift chrome decisions from assembly-time (reactive state machine) to script-generation-time (Gemini output). Gemini writes structured JSON containing per-scene chrome directives. Assembly reads directives literally — no string matching, no state machine, no inference.

### Subtasks

#### Subtask 4.1 — Create `lib/chromeDirectives.js` with Zod schema

New file `lib/chromeDirectives.js`. Exports:

- `ChromeDirectiveSchema` — Zod schema for a single scene's chrome object
- `SceneSchema` — Zod schema for a scene (type, id, storyIndex, spokenText/clipUrl, chrome)
- `ScriptSchema` — Zod schema for the full script (brandConfig, storyList, scenes[])
- `validateScript(script)` — runs validation, returns `{ok, errors}`

Schema captured in `CHROME_DIRECTIVE_ARCHITECTURE.md` section 3. Transcribe it into Zod. Example:

```javascript
const { z } = require('zod');

const ChromeFlagSchema = z.object({
  visible: z.boolean(),
  text: z.string().optional(),
  source: z.string().optional(),
  urgencyBadge: z.string().optional()
});

const ChromeTvCardSchema = z.object({
  visible: z.boolean(),
  imageUrl: z.string().url().optional(),
  headline: z.string().optional(),
  sourceName: z.string().optional()
});

const ChromeSidebarSchema = z.object({
  visible: z.boolean(),
  activeIndex: z.number().int().nonnegative(),
  cap: z.number().int().positive().default(5)
});

const ChromeDirectiveSchema = z.object({
  flag: ChromeFlagSchema,
  tvCard: ChromeTvCardSchema,
  sidebar: ChromeSidebarSchema,
  ticker: z.object({ visible: z.boolean() }).default({ visible: true }),
  logo: z.object({ visible: z.boolean() }).default({ visible: true })
});

const SceneSchema = z.discriminatedUnion('type', [
  z.object({
    id: z.string(),
    type: z.literal('avatar'),
    storyIndex: z.number().int(),
    spokenText: z.string().min(1),
    estimatedDurationSec: z.number().positive(),
    chrome: ChromeDirectiveSchema
  }),
  z.object({
    id: z.string(),
    type: z.literal('source_clip'),
    storyIndex: z.number().int(),
    clipUrl: z.string().url(),
    clipMaxDurationSec: z.number().positive().default(25),
    chrome: ChromeDirectiveSchema
  })
]);

const ScriptSchema = z.object({
  scriptVersion: z.literal(1),
  contentType: z.enum(['news', 'nba', 'twitch']),
  clientId: z.string(),
  brandConfig: z.object({
    primaryHex: z.string(),
    accentHex: z.string(),
    showName: z.string(),
    episodeNumber: z.number().int().positive()
  }),
  estimatedTotalDurationSec: z.number().positive(),
  storyList: z.array(z.object({
    index: z.number().int().nonnegative(),
    title: z.string(),
    source: z.string()
  })),
  scenes: z.array(SceneSchema).min(3) // minimum: intro + 1 story + outro
});

function validateScript(script) {
  try {
    ScriptSchema.parse(script);
    return { ok: true, errors: [] };
  } catch (e) {
    return { ok: false, errors: e.errors || [e.message] };
  }
}

module.exports = {
  ChromeDirectiveSchema,
  SceneSchema,
  ScriptSchema,
  validateScript
};
```

**Install dependency:** `pnpm add zod` (or `npm install zod`) if not already installed.

#### Subtask 4.2 — Rewrite News Gemini prompt to emit JSON

File: `server.js` News prompt block around line 6685-6737 (current text format prompt).

Current prompt instructs Gemini to write `=== STORY#_HEADER ===` markers with plain text. Target prompt instructs Gemini to output a JSON object matching the schema in `lib/chromeDirectives.js`.

**Prompt changes:**

1. Add output format instructions at the top:

```
OUTPUT FORMAT — STRICT:

Return a single JSON object matching this schema (simplified):

{
  "scriptVersion": 1,
  "contentType": "news",
  "clientId": "client_000_rob",
  "brandConfig": {
    "primaryHex": "#22304b",
    "accentHex": "#c7af4f",
    "showName": "BECAUSE THE LIGHT WAS ON",
    "episodeNumber": <N>
  },
  "estimatedTotalDurationSec": <computed>,
  "storyList": [
    { "index": 0, "title": "...", "source": "..." },
    ...
  ],
  "scenes": [
    { "id": "COLD_OPEN", "type": "avatar", "storyIndex": -1, "spokenText": "...", "estimatedDurationSec": 12, "chrome": {...} },
    { "id": "STORY1_INTRO", "type": "avatar", "storyIndex": 0, "spokenText": "...", "estimatedDurationSec": 8, "chrome": {...} },
    { "id": "STORY1_SETUP", "type": "avatar", "storyIndex": 0, "spokenText": "...", "estimatedDurationSec": 6, "chrome": {...} },
    { "id": "STORY1_CLIP", "type": "source_clip", "storyIndex": 0, "clipUrl": "...", "clipMaxDurationSec": 25, "chrome": {...} },
    { "id": "STORY1_SUMMARY", "type": "avatar", "storyIndex": 0, "spokenText": "...", "estimatedDurationSec": 5, "chrome": {...} },
    { "id": "STORY1_REACTION", "type": "avatar", "storyIndex": 0, "spokenText": "...", "estimatedDurationSec": 4, "chrome": {...} },
    ... STORY2_*, STORY3_*, STORY4_* ...,
    { "id": "OUTRO", "type": "avatar", "storyIndex": -1, "spokenText": "...", "estimatedDurationSec": 10, "chrome": {...} }
  ]
}
```

2. Add chrome field instructions:

```
CHROME DIRECTIVE RULES:

Every scene MUST include a "chrome" object with these 5 fields:
  flag, tvCard, sidebar, ticker, logo

For each field you decide whether it's visible for that scene and
what content it should display. Apply these rules:

flag.visible:
  - false during COLD_OPEN, OUTRO, and source_clip scenes
  - true during all STORY#_* avatar scenes (INTRO, SETUP, SUMMARY, REACTION)

flag.text (when visible):
  - UPPERCASE
  - 2-4 words
  - punchy summary of the active story
  - Example: "TRUMP IRAN PEACE DEAL" or "IRAN NAVAL BLOCKADE"

flag.source (when visible):
  - the publisher name, e.g., "Al Jazeera"

tvCard.visible:
  - true ONLY during STORY#_INTRO scenes (first ~10 seconds of each story)
  - false during all other scenes (SETUP, CLIP, SUMMARY, REACTION, OUTRO, COLD_OPEN)

tvCard.imageUrl (when visible):
  - the og:image URL from the story's article (provided in story metadata)

tvCard.headline (when visible):
  - the article's full headline (sentence case)

sidebar.visible:
  - false during COLD_OPEN, OUTRO, source_clip scenes, AND STORY#_INTRO (mutual exclusion with flag+tvCard)
  - true during STORY#_SETUP, STORY#_SUMMARY, STORY#_REACTION

sidebar.activeIndex:
  - for STORY1_* scenes, activeIndex = 0
  - for STORY2_* scenes, activeIndex = 1
  - etc.
  - for COLD_OPEN/OUTRO, activeIndex = 0 (unused because visible=false)

sidebar.cap:
  - always 5

ticker.visible:
  - always true

logo.visible:
  - always true

For source_clip scenes specifically:
  chrome: {
    flag: { visible: false },
    tvCard: { visible: false },
    sidebar: { visible: false },
    ticker: { visible: true },
    logo: { visible: true }
  }
```

3. Use Gemini's `response_mime_type: "application/json"` and `response_schema` if supported to enforce JSON output structurally. If not, rely on the prompt rules + post-parse validation.

4. Keep existing rules (no spoken source attribution, scene count, Locked intro, Appreciate you outro, beat placement) — they still apply to the `spokenText` field of avatar scenes.

#### Subtask 4.3 — Update Claude Gate 1 QA to validate JSON structure

File: `server.js` `claudeScriptQA()` at ~line 1522-1728.

Current Gate 1 treats the script as plain text. Target Gate 1:

1. Parse the script as JSON first (try/catch with graceful error)
2. Run `validateScript(parsedScript)` from `lib/chromeDirectives.js`
3. If schema validation fails, hard-fail Gate 1 with validation errors
4. If schema validates, run the existing content checks on `parsedScript.scenes[].spokenText`:
   - Source attribution ban (scan all spokenText fields)
   - Locked intro (first scene's spokenText)
   - Appreciate you outro (last scene's spokenText)
   - Scene count math (assert `scenes.length === 2 + (storyList.length × 4)`)
5. Add new content checks specific to directives:
   - Every STORY#_INTRO scene has `chrome.tvCard.visible === true`
   - Every STORY#_INTRO scene has `chrome.sidebar.visible === false` (mutual exclusion)
   - Every source_clip scene has ALL chrome elements set to `visible: false` except ticker/logo
   - `sidebar.activeIndex` advances monotonically (0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 2, ...)

Hard-fail any violation. Rob's rule: no clips, no production — extended to "no chrome consistency, no production."

#### Subtask 4.4 — Assembly chrome burn rewrite

File: `server.js` chrome burn block at ~line 3876-3925 (Fix 5/7 reactive state machine).

**DELETE the entire reactive state machine.** Replace with a directive consumer:

```javascript
// Subtask 4.4 — Directive consumer (replaces Fix 5/7 reactive state machine)
async function burnSceneChromeFromDirective(scene, inputTs, asmId, script) {
  const chrome = scene.chrome;

  // Skip burn entirely for source_clip scenes with no visible chrome elements
  // (ticker + logo are burned separately at the episode level, not per-scene)
  if (scene.type === 'source_clip') {
    return inputTs; // no chrome burn, clip passes through
  }

  // For avatar scenes, generate the chrome overlay PNG from the directive
  const overlayPng = await generateChromeOverlayFromDirective(chrome, {
    episodeNumber: script.brandConfig.episodeNumber,
    storyList: script.storyList,
    brandPrimary: script.brandConfig.primaryHex,
    brandAccent: script.brandConfig.accentHex,
    activeCategory: chrome.flag.source || 'NEWS'
  });

  // Burn via FFmpeg overlay (same pattern as before, just fed from directive)
  const burnedTs = await burnOverlayOnTs(inputTs, overlayPng, scene.estimatedDurationSec);
  return burnedTs;
}
```

And a new helper `generateChromeOverlayFromDirective(chrome, context)` that replaces the old `generateNewscastOverlay()` function — it takes a directive object and produces a PNG by calling Puppeteer `page.evaluate()` with the directive values toggling classes and text content in `tools/clipzworld_newscast.html`.

#### Subtask 4.5 — Update Puppeteer evaluate step in `generateChromeOverlayFromDirective()`

Existing `generateNewscastOverlay()` takes parameters like `{showLowerThird, hideSidebar, episodeNumber, activeCategory}`. New function takes `(directive, context)` and maps directive fields directly to DOM toggles:

```javascript
async function generateChromeOverlayFromDirective(directive, context) {
  const outputPath = path.join(TMP_DIR, `chrome_${Date.now()}.png`);

  const browser = await puppeteer.launch({...});
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.goto(`${CFG.ffmpegUrl}/newscast-overlay`);

  await page.evaluate((d, ctx) => {
    // Flag
    if (d.flag.visible) {
      document.querySelector('.lower-third')?.classList.add('visible');
      const headline = document.querySelector('.lt-headline');
      if (headline) headline.textContent = d.flag.text || '';
      const source = document.querySelector('.lt-source');
      if (source) source.textContent = d.flag.source || '';
    } else {
      document.querySelector('.lower-third')?.classList.remove('visible');
    }

    // TV card
    if (d.tvCard.visible) {
      document.querySelector('.tv-card')?.classList.add('visible');
      const cardImg = document.querySelector('.tv-card img');
      if (cardImg && d.tvCard.imageUrl) cardImg.src = d.tvCard.imageUrl;
      const cardHeadline = document.querySelector('.tv-card .headline');
      if (cardHeadline) cardHeadline.textContent = d.tvCard.headline || '';
    } else {
      document.querySelector('.tv-card')?.classList.remove('visible');
    }

    // Sidebar
    if (d.sidebar.visible) {
      document.body.classList.remove('sidebar-hidden');
      // Highlight active story
      document.querySelectorAll('.story-card').forEach((card, idx) => {
        card.classList.toggle('active', idx === d.sidebar.activeIndex);
      });
    } else {
      document.body.classList.add('sidebar-hidden');
    }

    // Ticker + logo (always visible per spec, no toggling needed)

    // Apply brand colors
    document.documentElement.style.setProperty('--navy', ctx.brandPrimary);
    document.documentElement.style.setProperty('--gold', ctx.brandAccent);

    // Episode number in top bar
    const episodeSpan = document.querySelector('.top-bar .episode-number');
    if (episodeSpan) episodeSpan.textContent = `EPISODE ${ctx.episodeNumber}`;
  }, directive, context);

  await page.screenshot({ path: outputPath, omitBackground: true });
  await browser.close();
  return outputPath;
}
```

#### Subtask 4.6 — Feature flag `USE_DIRECTIVE_CHROME`

Add a flag at the top of `server.js` or in `lib/config.js`:

```javascript
const USE_DIRECTIVE_CHROME = process.env.USE_DIRECTIVE_CHROME !== 'false'; // default true
```

In the assembly loop, branch on the flag:

```javascript
if (USE_DIRECTIVE_CHROME && script.scenes) {
  // New path — consume directives
  burnedTs = await burnSceneChromeFromDirective(scene, inputTs, asmId, script);
} else {
  // Old path — reactive state machine (kept as fallback)
  burnedTs = await burnSceneChromeLegacy(scene, inputTs, asmId);
}
```

**Keep the legacy path for 2-4 weeks** as an emergency rollback. Don't delete Fix 5/7 state machine code in this commit — dead-code it behind the flag. A follow-up commit deletes it after test #10 passes cleanly on the directive path.

#### Subtask 4.7 — Delete dead-code check

After test #10 passes on directive path, a follow-up commit deletes:
- Fix 5/7 reactive state machine code
- `generateNewscastOverlay()` old signature
- Legacy scene-label string matching

**NOT in this commit.** Keep the flag for rollback safety.

### Verification for Commit 3

- `grep -n "USE_DIRECTIVE_CHROME" server.js` returns flag definition + usage
- `grep -n "validateScript" server.js` returns Gate 1 usage
- `grep -n "ChromeDirectiveSchema" lib/chromeDirectives.js` returns schema export
- `node -c server.js` exit 0
- `node -e "const {validateScript} = require('./lib/chromeDirectives'); console.log(validateScript({scriptVersion: 1, contentType: 'news', clientId: 'test', brandConfig: {}, scenes: []}))"` — smoke test the validator
- Manual JSON script test: craft a minimal valid script, pass to `validateScript()`, expect `{ok: true, errors: []}`
- Manual JSON script test: craft an invalid script (missing required field), pass to `validateScript()`, expect `{ok: false, errors: [...]}`

### Commit message

```
feat(news): proactive chrome directive architecture (Red 4 / Track B)

Replaces the reactive Fix 5/7 chrome state machine with a proactive
directive architecture. Gemini writes structured JSON scripts with
per-scene chrome directives; assembly reads them literally instead
of inferring state from scene label string matching.

Why: Rob 2026-04-13 PM feedback on News smoke test #9 — "we have to
nail the set design based on input into the right scenes early in
process... proactive vs in the moment reactive execution."

Architecture design captured in CHROME_DIRECTIVE_ARCHITECTURE.md
(committed 1281837). This commit implements Phase B+C+D from that doc
in a single ship (recalibrated from 9-13 days human-speed to ~3 hours
Cline-speed).

Changes:
- NEW lib/chromeDirectives.js — Zod schema + validateScript() helper
- server.js News Gemini prompt — outputs JSON with chrome directives
  per scene instead of plain text with === HEADER === markers. Uses
  response_mime_type=application/json if supported.
- server.js claudeScriptQA (Gate 1) — parses JSON, validates schema,
  runs existing content checks (source attribution, scene count,
  locked intro, outro) on spokenText fields. Adds new content checks:
  every STORY#_INTRO has tvCard.visible=true and sidebar.visible=false
  (mutual exclusion), every source_clip has all chrome elements
  hidden, sidebar.activeIndex advances monotonically.
- server.js assembly — burnSceneChromeFromDirective() replaces the
  reactive state machine. Generates chrome overlay PNG from directive
  object via new generateChromeOverlayFromDirective() helper.
- tools/clipzworld_newscast.html — minor updates to Puppeteer
  evaluate targets so directive fields map cleanly to DOM toggles
- Feature flag USE_DIRECTIVE_CHROME (default true) with legacy
  state machine dead-coded behind flag for emergency rollback.

Gate 1 rejects schema-invalid scripts BEFORE Gemini script finalizes
(hard-fail, no retry wastes). Same rule as Fix 25c's clip gate —
upstream hard-gate catches problems before HeyGen token burn.

Dependency: zod (pnpm add zod).

Feature flag allows rollback via env var: USE_DIRECTIVE_CHROME=false
restores reactive state machine (legacy code still in place).

References: CHROME_DIRECTIVE_ARCHITECTURE.md (committed 1281837),
News smoke test #9 review, Rob direction "ship everything now that
is for news getting past".
```

---

## Commit 4 — Red 1: residual chrome surgical bandaids

**Effort:** 30-60 minutes, SMALLER if Red 4 landed cleanly (most Red 1 issues become impossible under directive architecture)
**Files:** `server.js` or `tools/clipzworld_newscast.html` depending on what residual issues exist
**Risk:** low — targeted patches after Red 4 is in place

### When to ship this commit

**Only ship Red 1 if specific issues are observable AFTER Red 4 is in place.** The directive architecture eliminates most of Red 1's scope because:

- Flag text is set explicitly per scene by Gemini — can't be stale
- Sidebar activeIndex is set explicitly per scene by Gemini — can't drift
- TV card visibility is set explicitly per scene by Gemini — can't fire at wrong moments
- Source clip chrome state is declared by Gemini as "all hidden" — can't leak

**What Red 4 DOES NOT fix:**

- Visual positioning bugs (flag at wrong x/y, sidebar card overflow)
- Timing bugs where Puppeteer screenshot captures the wrong frame of an in-progress animation
- Template CSS bugs where the newscast HTML renders differently than intended
- HeyGen avatar rendering quirks (avatar segment visibility, background consistency)

If test #10 reveals any of those, Red 1 bandaids target them directly. But we can't predict what they'll be — they're discovered by visual review.

### Recommendation for Red 1

**Do NOT pre-emptively ship Red 1 bandaids in this handoff.** After Cline lands Commits 1-3 and Rob fires test #10, review the output. If any chrome issues are observable that are NOT caused by directive mistakes (wrong flag text, wrong activeIndex), those become Red 1 commit 4 material for a follow-up ship.

**If Red 1 has zero observable issues after test #10:** skip Commit 4 entirely. News is locked.

### Commit message (when/if applicable)

```
fix(news): residual chrome surgical bandaids after directive migration (Red 1)

Track B directive architecture (Red 4) eliminates most chrome state
machine sync issues by construction. This commit fixes any specific
residual visual bugs surfaced during News smoke test #10 review that
are NOT caused by directive content mistakes.

[Specific fixes to be documented per-commit based on test #10 observations]
```

---

## Ship all 4 commits, then ping Rob

After Commits 1-3 land cleanly:

1. **Hard refresh dashboard** instructions for Rob
2. **Fire News smoke test #10**
3. **Review resulting MP4 in VLC** — spot check framing, clip duration, watermark masking, chrome sync
4. **If issues:** diagnose what's Red 1 bandaid material, ship Commit 4 as targeted fix
5. **If clean:** News is locked. Move to NBA smoke test prep.

---

## What this handoff does NOT cover

- **NBA voiceover V2** — parked, next in queue after News locks
- **Twitch polish** — parked
- **Short-form work** — parked
- **Phase 2 Next.js frontend migration** — parked until all 3 content types + 1 short-form lock
- **Test #10 review notes** — those become the NEXT handoff (potentially Commit 4 above or test #11 if issues cascade)

---

## Commit hygiene

- Re-read `COMMIT_CHECKLIST.md` before each commit
- Atomic staging
- Update `STATUS.md` → 🤖 Last Agent Action table on every commit
- Update `LONGFORM_FIX_ROTATION.md` → move Red 1/2/3/4 to ✅ Shipped with commit hashes
- `node -c server.js` exit 0 before each commit
- Push to `origin/main` after each commit lands
- nodemon auto-restarts on `server.js` changes
- Python dashboard server: no changes in this handoff, browser refresh not needed
- Ping Rob after Commit 3 (Red 4) lands so he knows the big rewrite is in and can fire test #10

---

## Rough time budget (sanity check)

| Commit | Task | Est |
|---|---|---|
| 1 | Red 2 watermark drawbox | 20 min |
| 2 | Red 3 clip offset + verification | 30 min |
| 3 | Red 4 directive architecture (7 subtasks) | 2.5 hours |
| 4 | Red 1 residual bandaids (test #10 dependent) | skip or 30 min |
| — | Commit hygiene, STATUS updates, docs | 30 min |
| **Total** | **Serial execution** | **~3.5-4 hours** |

If Cline hits blockers or needs Rob clarification mid-flight, ping and pause. Otherwise ship top-to-bottom.
