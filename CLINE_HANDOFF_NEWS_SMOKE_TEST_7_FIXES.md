# CLINE_HANDOFF_NEWS_SMOKE_TEST_7_FIXES.md

**Author:** Claude Code (dispatched 2026-04-13 mid-morning, post smoke test #7 visual review)
**For:** Cline
**Scope:** News long-form fixes from Rob's YouTube Studio review of smoke test #7 (`news_monday_april_13_2026_42_avatar_3_clips__1776081943778.mp4`, Gate 3 97/100 PASS). Plus one infrastructure fix Claude Code found during the same review (Gate 2 regex extraction bug masking real segment scores).
**Ship order:** Flexible within the news block; recommended order below. One commit per fix (or small groupings where files overlap). Re-test after all fixes land.
**Do NOT touch:** NBA, Twitch, short-form code paths. NBA voiceover FFmpeg V2 is explicitly parked until News set is locked per Rob's strategy. `CLINE_HANDOFF_NBA_VOICEOVER_FFMPEG_V2.md` stays in the queue but does not ship this cycle.
**Before each commit:** Re-read `COMMIT_CHECKLIST.md`. Atomic staging. STATUS.md update. `LONGFORM_FIX_ROTATION.md` update.

---

## Why this handoff exists

Smoke test #7 (`asm_1776081761513`) was the **first News long-form run in repo history** with non-zero clip count AND a clean Gate 3 pass (97/100). Gap #51 (stage direction leak, `d5c53ea`) and Fix 9B (Brightcove HLS download, `c0cd43b`) both verified end-to-end — zero `[3-second pause]` burned-in text, 3 Al Jazeera clips downloaded and played.

Rob's YouTube Studio review surfaced **7 gaps** that keep the News set from being production-ready. Three of the seven were specced in `CLINE_HANDOFF_NEWS_SMOKE_TEST_6_THREE_FIXES.md` but parked yesterday pending a clean test #7. That handoff is now unblocked — ship its contents as part of this bundle. Four of the seven are new from test #7.

Claude Code also found a Gate 2 regex extraction bug while reading the test #7 Gate 2 report. Not caused by News, not caused by yesterday's fixes — it's been masking real Gate 2 scores across every smoke test for weeks. Fixing it now as part of this handoff because it's a 1-line change and the smoke-test loop benefits from accurate Gate 2 data.

**Workflow contract (per Rob 2026-04-13):** each smoke test produces a single handoff doc of gaps; Cline ships all of them; Rob re-runs the same smoke test; repeat until clean; then move to the next content type. This doc is the test #7 handoff. Test #8 (5 stories) runs after everything here ships.

---

## The 7 gaps from test #7 review

Rob's exact feedback, verbatim:

> "video clips are present but they are the wrong ratio they are 9:16 for shorts not full, bobby g is pronouncing certain words twice sometimes and each news story is stating the source on video but just need to do that on video description, the top left flag is still too far to right and the story cards on far right are showing all story clips at once on a 10 story video we can only fit 7 stories on a screen so we either show 5 then when first 5 are done we clear screen as its supposed to clear when theres a tv card on the screen, also that top flag is supposed to stay on the screen during the intro setup, when set is back in view after clip and then through the setup and reaction, then come back with start of next story with video card. - it looks like on this we stopped pulling clips after the third story - lets try one more smoke test with 5"

Decomposed into 7 independent gaps:

| # | Gap | Root area | Parked handoff reference |
|---|-----|-----------|--------------------------|
| 1 | Video clips rendering at 9:16 aspect ratio (vertical) instead of being letterboxed/fit into 16:9 long-form frame | `server.js` assembly FFmpeg clip scaling | NEW |
| 2 | Bobby G pronouncing certain words twice sporadically | HeyGen SSML / script cleaning / speed artifact | NEW (needs diagnosis) |
| 3 | Source attribution (e.g. "According to Al Jazeera...") spoken by Bobby G | Gemini News prompt at `server.js:6685-6737` | NEW |
| 4 | Top-left flag (`.lower-third`) still offset ~8px from left edge | `tools/clipzworld_newscast.html` CSS | Was Fix 2a in parked handoff |
| 5 | Sidebar story list shows all 7+ cards at once, competing visually with TV card; flag + sidebar appear simultaneously during INTRO | Template CSS + server.js state machine | Was Fix 2b in parked handoff — superseded and expanded below |
| 6 | Clips only pulled for first 3 of 10 stories; stories 4-10 are avatar-only | `server.js` News scraping loop + `orderedClipUrls` build | Was Fix 3 in parked handoff |
| 7 | LIVE indicator + date still flush against right frame edge | `tools/clipzworld_newscast.html` CSS | Was Fix 1 in parked handoff |

**Additionally, 2 gaps from post-initial-review:**

| # | Gap | Root area | Source |
|---|-----|-----------|--------|
| 8 | Gate 2 regex extractor fails on Gemini's `OVERALL SCORE: [98]` bracket format, every segment defaults to 80/100, every smoke test stalls at MANUAL_REVIEW even when real scores are 95-98 | `server.js:2991` | Claude Code found during test #7 review |
| 9 | Al Jazeera branded red outro frame remains at tail of every News clip (~5s of AJ logo / "more at aljazeera.com" branding after real content ends). Credit is already in the video description — we don't need to show their brand card on every clip. | Clip TS conversion / FFmpeg trim | Rob added mid-handoff 2026-04-13 |

**Total: 9 fixes. Ship all before test #8.**

---

## Ship order (recommended)

Fix order is flexible but this sequence minimizes cross-file collisions and maximizes chance of clean atomic commits:

1. **Fix 8** — Gate 2 regex (1 line, pure infrastructure, independent)
2. **Fix 7** — LIVE indicator margin (1-line CSS, independent)
3. **Fix 4** — Flag left alignment (1-line CSS, independent)
4. **Fix 3** — Source attribution removal (Gemini prompt edit, independent)
5. **Fix 1 + Fix 9** — Clip aspect ratio force 16:9 + Al Jazeera outro trim (both live in the same FFmpeg clip normalization pass — ship as ONE commit)
6. **Fix 6** — Clips stopping after story 3 (`orderedClipUrls` alignment bug, assembly file)
7. **Fix 5** — Sidebar capacity cap + mutual exclusion + flag persistence (biggest — template + server.js state machine)
8. **Fix 2** — Bobby G double-pronunciation (diagnosis-first, Hungary story ~2:15 is the anchor timestamp)

Ship as ~8 atomic commits. Fix 1 and Fix 9 are explicitly bundled because they both modify the same FFmpeg clip normalization pass and would conflict if split.

---

## Fix 8 — Gate 2 regex extraction bug (infrastructure)

**File:** `server.js:2991`
**Effort:** ~5 minutes. Single-line regex change + optional prompt cleanup.
**Why first:** Independent, trivial, unblocks all future Gate 2 smoke-test signals. No reason to wait.

### Current state

At `server.js:2991` the segment score extractor is:

```javascript
const segScore = parseInt((segReport.match(/OVERALL SCORE:\s*(\d+)/i) || segReport.match(/SCORE:\s*(\d+)/i) || [])[1] || '80');
```

The Gate 2 prompt at `server.js:2970` instructs Gemini with `OVERALL SCORE: [number from 0-100]`. The `[number from 0-100]` is meant as a placeholder, but Gemini interprets the brackets as literal format and copies them into output:

```
OVERALL SCORE: [98]
```

The regex `/OVERALL SCORE:\s*(\d+)/i` expects digits immediately after the whitespace. It hits `[` instead, fails to match. Fallback `/SCORE:\s*(\d+)/i` has the same issue. Both fail, ternary falls through to `|| '80'`, and **every segment gets a hardcoded 80**.

**Evidence from test #7 Gate 2 report:**

```
Gemini wrote:    OVERALL SCORE: [98], [95], [98]  (avg 97)
Gate 2 extracted: 80, 80, 80 (avg: 80)
Outcome:         MANUAL_REVIEW (threshold 85 to auto-pass)
```

This is why test #4, #6, #7 all stalled at MANUAL_REVIEW — not because segments were borderline, but because the regex has been blind.

### Fix A — Regex (required)

Update the regex to accept optional brackets:

```javascript
const segScore = parseInt((segReport.match(/OVERALL SCORE:\s*\[?(\d+)\]?/i) || segReport.match(/SCORE:\s*\[?(\d+)\]?/i) || [])[1] || '80');
```

The `\[?` and `\]?` make brackets optional. Backward compatible with any prior unbracketed outputs.

### Fix B — Prompt cleanup (recommended, belt-and-suspenders)

At `server.js:2970` change:

```
OVERALL SCORE: [number from 0-100]
```

to:

```
OVERALL SCORE: <number from 0-100>
```

This discourages Gemini from literal-copying brackets in future outputs. Combined with Fix A, both old-format (with brackets) and new-format (without) outputs parse correctly.

### Verification

- Grep: `grep -n "OVERALL SCORE" server.js` — confirm both changes present
- `node -c server.js` exit 0
- After next smoke test, check the Gate 2 report — segment scores should match what Gemini wrote in the detailed sample report (e.g., 98, 95, 98 not 80, 80, 80)

### Commit message

```
fix(gate2): regex extractor handles OVERALL SCORE: [98] bracket format (server.js:2991)

Gemini's Gate 2 segment reports use OVERALL SCORE: [98] format because
the prompt instruction wraps the placeholder in brackets. The extraction
regex expected bare digits and silently fell through to the '80' default
for every segment. Result: every smoke test across News/NBA/Twitch has
been stalling at MANUAL_REVIEW with a fake 80/80/80 score even when real
Gemini scores were 95-98.

Fix A (server.js:2991): regex now accepts optional brackets
  /OVERALL SCORE:\s*\[?(\d+)\]?/i

Fix B (server.js:2970): prompt placeholder changed from [...] to <...>
to discourage future bracket copying.

Discovered while reviewing News smoke test #7 Gate 2 output:
  Gemini wrote:    [98], [95], [98]  (avg 97)
  Gate 2 extracted: 80, 80, 80        (avg 80 → MANUAL_REVIEW)

References: LONGFORM_FIX_ROTATION.md, News smoke test #7 review
```

---

## Fix 7 — LIVE indicator flush right (parked from 3-fix handoff)

**File:** `tools/clipzworld_newscast.html`
**Effort:** 2 minutes. Single CSS line.

### Current state

Rob's screenshot from test #7 confirms the red `● LIVE | APRIL 13, 2026` is still flush against the right frame edge. Fix 1 from the parked `CLINE_HANDOFF_NEWS_SMOKE_TEST_6_THREE_FIXES.md` was never shipped.

### The fix

Find `.top-right` CSS rule in `tools/clipzworld_newscast.html`. Add `margin-right: 80px`:

```css
.top-right {
  margin-left: auto;
  margin-right: 80px;  /* pull LIVE indicator + date inward from frame edge */
  display: flex;
  align-items: center;
  gap: 16px;
}
```

Target: ~80px from right edge. Tuneable if Rob wants more/less after test #8.

### Commit message

```
fix(news): move LIVE indicator + date inward from top-right frame edge (Fix 7 of 8)

Rob's smoke test #7 screenshot confirmed the red ● LIVE | APRIL 13, 2026
indicator still flush against the right frame edge. Fix 1 from the parked
3-fix handoff (CLINE_HANDOFF_NEWS_SMOKE_TEST_6_THREE_FIXES.md) was never
shipped. Adding margin-right:80px to .top-right pulls it inward.

References: News smoke test #7 review
```

---

## Fix 4 — Flag left alignment (parked from 3-fix handoff, refined)

**File:** `tools/clipzworld_newscast.html`
**Effort:** 5 minutes. CSS verification + fix.

### Current state

Rob's test #7 screenshot shows the `.lower-third` (blue-and-gold flag) leading edge ~8px inset from the left frame edge, not flush. Per Fix 2a in the parked 3-fix handoff, the CSS should be `top: 48px; left: 0;` but something (child element padding, clip-path, parent margin) is creating the 8px offset.

### The fix

1. Find `.lower-third` CSS rule. Confirm `left: 0` is set.
2. Check child elements `.lt-top` and `.lt-bottom` — they may have `padding-left` or `clip-path: polygon(...)` with non-zero x values that create the visible offset.
3. Check parent container — any `body { margin: 0 }` or `.newscast-container` with padding will push children inward.
4. Test-fit: when rendered via Puppeteer and burned into the MP4, the leading edge of the colored fill should touch x=0 of the frame.

The likely culprits:
- `.newscast-container { padding: ... }` on the body wrapper
- `.lt-top` or `.lt-bottom` inline padding
- `transform: translateX(-8px)` leftover from an earlier animation tuning

Pin it down with DevTools or a test screenshot, not by guessing.

### Commit message

```
fix(news): flag (.lower-third) flush against left frame edge (Fix 4 of 8)

Rob's smoke test #7 screenshot confirmed .lower-third still renders ~8px
inset from the left frame edge, not flush. Fix 2a from the parked 3-fix
handoff was never shipped and the CSS rule was unverified.

Root cause: [Cline to identify — .newscast-container padding, child element
padding on .lt-top/.lt-bottom, or leftover transform]. Fix is whichever
rule is creating the 8px offset.

References: News smoke test #7 review
```

---

## Fix 3 — Bobby G stops speaking source names (Gemini prompt edit)

**File:** `server.js:6685-6737` (News Gemini prompt block)
**Effort:** 10-15 minutes. Add one rule to the News prompt.

### Current state

In test #7 Bobby G audibly says things like "According to Al Jazeera..." or "Sources at Al Jazeera report..." at the start of each story. Sources belong in the video description (generated separately by `/generate-publish-copy`), NOT in the spoken narration.

### The fix

Add an explicit rule to the News Gemini prompt block at `server.js:6685-6737`. After the existing VALIDATION CHECKLIST or SCENE RULES section, add:

```
SOURCE ATTRIBUTION RULE (STRICT):
- NEVER speak the source name in any scene (INTRO, SETUP, SUMMARY, REACTION, OUTRO).
- Bobby G does not say "According to Al Jazeera", "Sources report", "Al Jazeera's coverage", or any variation.
- Source names are already tracked in the story metadata and will be published in the video description automatically.
- If a story is uniquely identifiable only by its source, rephrase to describe the event without the publication name. Example:
  WRONG: "According to Al Jazeera, Iran's army seized US plans..."
  RIGHT: "Iran's army reportedly seized US plans..."
  WRONG: "Al Jazeera reports that Israeli forces fired tear gas..."
  RIGHT: "Israeli forces fired tear gas into a Palestinian schoolchildren's crowd."
- This rule applies to ALL 10 stories, every scene type, no exceptions.
```

Place this immediately before the VALIDATION CHECKLIST section so it's applied during generation AND caught during Gate 1 Claude QA.

Also update the Gate 1 QA checklist at `server.js:1522-1728` (`claudeScriptQA`) to add a source-attribution check:

```
- No spoken source attribution: check every scene for phrases like "According to [source]",
  "Sources at [source]", "[source] reports". Fail hard (-25) if any found.
```

### Verification

After test #8, grep the generated script output for `Al Jazeera\|according to\|sources report\|reports that` — should be 0 matches in the spoken text.

### Commit message

```
fix(news): strip source attribution from Bobby G spoken script (Fix 3 of 8)

Rob's smoke test #7 review: Bobby G audibly said "According to Al Jazeera..."
at the start of multiple stories. Sources belong in the video description
(generated separately by /generate-publish-copy), not in the narration.

Changes:
- server.js:6685-6737 — add SOURCE ATTRIBUTION RULE block to News Gemini
  prompt. Explicit NEVER-speak rule with wrong/right examples.
- server.js:1522-1728 — add Gate 1 Claude QA check for source attribution
  phrases. -25 hard fail if any found.

Test: after next smoke test, grep generated script for "al jazeera|according to|
sources report" — should be 0 spoken matches.

References: News smoke test #7 review
```

---

## Fix 1 — Force clip aspect ratio to 16:9 on ingest

**File:** `server.js` assembly branch (FFmpeg clip scale/crop pre-pass)
**Effort:** 30-45 minutes. FFmpeg filter graph change.

### Current state

Test #7 rendered 3 Al Jazeera clips via the Fix 9B Brightcove HLS path. All 3 appeared in the final MP4 at 9:16 vertical aspect ratio — pillarboxed narrow in the middle of the 16:9 frame, looking like a short-form clip awkwardly pasted into a long-form video.

Root cause: Al Jazeera publishes some video content shot vertically (mobile journalism, field footage, social-first clips). The Brightcove HLS manifest returns the native vertical resolution. Fix 9B's download step (`ffmpeg -i <manifest> -c copy`) preserves the source dimensions without transforming them. When the assembly concat demuxer then slots the vertical clip into the 1920×1080 timeline, FFmpeg centers it with black pillarbox bars.

### The fix

Add a post-download scale+crop pass to every Fix 9B HLS download that forces output to 1920×1080 with zoom-to-fill cropping (consistent with how Twitch clips are handled for baked-in letterbox per CLAUDE.md § Source Clip Zoom-to-Fill Crop, commit `45f8980`).

**Option A — Do it inside `downloadFile()` HLS branch (Fix 9B):**

Change the HLS download FFmpeg args from:

```
['-i', url, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart', '-y', destPath]
```

To:

```
[
  '-i', url,
  '-vf', 'scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080',
  '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
  '-c:a', 'aac', '-b:a', '192k',
  '-movflags', '+faststart',
  '-y', destPath
]
```

Pros: single place, consistent for all News clips downloaded via Fix 9B.
Cons: re-encodes video (slower than `-c copy`), breaks if the source is already 16:9 at a different resolution (upscales to 1080p when original may be lower).

**Option B — Do it during assembly TS conversion:**

Apply the same scale+crop filter at the per-clip `.mp4 → .ts` conversion step where the clip is prepped for the concat demuxer. This is where Twitch's existing zoom-to-fill crop lives (commit `45f8980`). News should reuse the same code path, not reinvent it.

Find where Twitch source clips are converted to TS in `server.js` (grep for `force_original_aspect_ratio` or `zoom` — commit `45f8980`), confirm the same filter applies to News clips.

If News clips are bypassing that path, wire them through it.

**Recommended: Option B** — reuses existing tested logic, doesn't re-encode twice, keeps Fix 9B's HLS download pure.

### Verification

- After test #8, open the resulting MP4, scrub to a clip segment. Clip should fill the full 1920×1080 frame without pillarbox bars, even if the Al Jazeera source was vertical.
- If zoom-to-fill crops off critical content (e.g., a subject's face is at the frame edge), the alternative is letterbox fit (`force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black`). Default to crop; switch to pad only if Rob flags specific examples where crop loses critical content.

### Commit message

```
fix(news): force 16:9 aspect ratio on clip ingest via zoom-to-fill crop (Fix 1 of 8)

Rob's smoke test #7 review: the 3 Al Jazeera clips that downloaded via Fix 9B
rendered at 9:16 vertical aspect ratio, pillarboxed in the middle of the
1920×1080 frame. Al Jazeera publishes some clips from vertical mobile video.

Fix: wire News source clips through the same zoom-to-fill crop path that
Twitch uses (commit 45f8980). Scale source to cover 1920×1080, crop overflow.
Slight content loss at edges is acceptable; vertical pillarbox is not.

File: server.js — [specific line range where News clips convert to TS]

Test: after next smoke test, clip segments in final MP4 should fill the
full frame with no black pillarbox bars.

References: News smoke test #7 review, CLAUDE.md § Source Clip Zoom-to-Fill Crop
```

---

## Fix 9 — Al Jazeera red outro branding frame removal

**File:** `server.js` assembly branch (same FFmpeg clip normalization pass as Fix 1 — ship together)
**Effort:** 30-45 minutes. Silence detection + trim logic.
**Dependency:** ship in the same commit as Fix 1 to avoid FFmpeg pass conflicts.

### Current state

Every Al Jazeera clip downloaded via Fix 9B ends with ~5 seconds of branded red outro: "AL JAZEERA" logo, "More at aljazeera.com" tagline, bumper music, fade. This is Al Jazeera's on-brand video signoff baked into every source clip.

Rob: *"can we cut the aljazeera last frame in red in their branding of every clip so looks like last 5 secs or when theres no more dialogue... we are already giving them credit in our description of video"*

Attribution: the News publish-copy generator already includes source names in the YouTube description. Visual branding in the clip itself is redundant and dilutes the CWN brand consistency.

### The fix — audio silence detection, fallback to fixed 5s trim

**Strategy:** use FFmpeg's `silencedetect` filter to find the last moment of actual speech in each clip. Trim the clip from the start of the trailing silence onward. If silence detection finds no trailing silence (clip ends on speech), fall back to trimming the last 5.0 seconds.

This works because Al Jazeera's red outro card has either bumper music OR silence under the branding — either way it's a clear audio signature break from the speech-heavy content that preceded it.

### Implementation

Inside the News clip TS normalization pass (same location as Fix 1), add a pre-pass that measures trailing silence and computes the trim duration.

**Step 1 — Probe clip duration and detect trailing silence:**

```javascript
/**
 * Detect the timestamp where trailing silence begins in a clip.
 * Uses FFmpeg silencedetect filter. Returns the silence-start timestamp
 * if trailing silence is found, or null if the clip ends on speech.
 *
 * @param {string} clipPath - absolute path to input clip (mp4/ts/mkv)
 * @returns {Promise<{totalDuration: number, silenceStart: number|null}>}
 */
async function detectTrailingSilence(clipPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-i', clipPath,
      '-af', 'silencedetect=noise=-30dB:duration=1.0',
      '-f', 'null',
      '-'
    ];
    const proc = execFile(ffmpegPath(), args, { maxBuffer: 10 * 1024 * 1024 });
    let stderr = '';
    proc.stderr && proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      if (code !== 0 && code !== 1) {  // ffmpeg returns 1 on null muxer, that's fine
        return reject(new Error(`silencedetect exit ${code}`));
      }
      // Parse silencedetect output. Format:
      //   [silencedetect @ 0x...] silence_start: 23.456
      //   [silencedetect @ 0x...] silence_end: 28.123 | silence_duration: 4.667
      const silenceStarts = [...stderr.matchAll(/silence_start:\s*([\d.]+)/g)].map(m => parseFloat(m[1]));
      const silenceEnds = [...stderr.matchAll(/silence_end:\s*([\d.]+)/g)].map(m => parseFloat(m[1]));
      const durationMatch = stderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
      let totalDuration = 0;
      if (durationMatch) {
        totalDuration = parseInt(durationMatch[1]) * 3600 +
                       parseInt(durationMatch[2]) * 60 +
                       parseFloat(durationMatch[3]);
      }
      // A "trailing silence" is a silence_start with NO corresponding silence_end
      // (or a silence_end that extends to the clip's total duration).
      // If the last silence_start > last silence_end, that's trailing silence.
      let trailingSilenceStart = null;
      if (silenceStarts.length > 0) {
        const lastStart = silenceStarts[silenceStarts.length - 1];
        const lastEnd = silenceEnds.length > 0 ? silenceEnds[silenceEnds.length - 1] : -1;
        if (lastStart > lastEnd) {
          trailingSilenceStart = lastStart;
        }
      }
      resolve({ totalDuration, silenceStart: trailingSilenceStart });
    });
    proc.on('error', reject);
  });
}
```

**Step 2 — Compute trim duration:**

```javascript
/**
 * Compute the output duration for a News source clip, stripping the
 * Al Jazeera red outro branding card.
 *
 * Priority:
 *   1. If silencedetect finds trailing silence starting before clip end,
 *      trim to silence_start (that's where speech ended + branding began).
 *   2. If no trailing silence detected (clip ends on speech), fall back
 *      to trimming the last 5.0 seconds on the assumption the branding
 *      frame is at the tail regardless.
 *   3. Sanity guards:
 *      - Never trim more than 30% of the clip duration (prevents aggressive
 *        cuts on short clips where silencedetect is unreliable)
 *      - Never return a duration less than 5 seconds (floor — below that,
 *        the clip is too short to be useful regardless)
 *
 * @param {string} clipPath
 * @returns {Promise<number>} - output duration in seconds
 */
async function computeNewsClipTrimDuration(clipPath) {
  const { totalDuration, silenceStart } = await detectTrailingSilence(clipPath);

  if (!totalDuration || totalDuration <= 0) {
    throw new Error(`Invalid clip duration: ${totalDuration}`);
  }

  let trimTo;
  if (silenceStart !== null && silenceStart > 0 && silenceStart < totalDuration) {
    // Detected trailing silence — trim to silence start
    trimTo = silenceStart;
    console.log(`[news-clip-trim] ${path.basename(clipPath)}: silence detected at ${silenceStart.toFixed(2)}s of ${totalDuration.toFixed(2)}s → trim`);
  } else {
    // No trailing silence — fallback: trim last 5 seconds
    trimTo = Math.max(totalDuration - 5.0, 5.0);
    console.log(`[news-clip-trim] ${path.basename(clipPath)}: no silence detected → fallback trim last 5s (${totalDuration.toFixed(2)}s → ${trimTo.toFixed(2)}s)`);
  }

  // Sanity: never trim more than 30% of total duration
  const minKeep = totalDuration * 0.7;
  if (trimTo < minKeep) {
    console.warn(`[news-clip-trim] ${path.basename(clipPath)}: computed trim ${trimTo.toFixed(2)}s < 70% floor ${minKeep.toFixed(2)}s — using 70% floor`);
    trimTo = minKeep;
  }

  // Sanity: floor at 5s
  if (trimTo < 5.0) {
    console.warn(`[news-clip-trim] ${path.basename(clipPath)}: computed trim ${trimTo.toFixed(2)}s < 5s floor — keeping full clip`);
    trimTo = totalDuration;
  }

  return trimTo;
}
```

**Step 3 — Apply trim in the same FFmpeg pass as Fix 1's aspect ratio crop:**

This is where Fix 1 and Fix 9 must ship together. The clip TS conversion pass now does three things in one FFmpeg invocation:

1. Trim to `computeNewsClipTrimDuration()` output via `-t <duration>`
2. Scale + crop to 1920×1080 via `-vf scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080`
3. Convert to TS for concat

Example wiring (exact location depends on where Twitch's existing zoom-to-fill crop lives):

```javascript
if (contentType === 'news' && segTypes[i] === 'source_clip') {
  // Compute News-specific trim duration (silence-detect + fallback)
  const trimDuration = await computeNewsClipTrimDuration(inputClipPath);

  const args = [
    '-i', inputClipPath,
    '-t', trimDuration.toFixed(3),  // NEW — Fix 9 trim
    '-vf', 'scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080',  // Fix 1 aspect ratio
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
    '-c:a', 'aac', '-b:a', '192k',
    '-bsf:v', 'h264_mp4toannexb',
    '-f', 'mpegts',
    '-y', outputTsPath
  ];
  // ... exec ...
}
```

**Non-News clips (Twitch) are untouched.** The trim only applies when `contentType === 'news'`.

### Verification

1. After test #8, scrub to the end of each News clip segment. Should end on real content, not the red Al Jazeera branding frame.
2. Check nodemon log for `[news-clip-trim]` markers per clip showing the detected silence start timestamp or the fallback 5s trim.
3. Clip duration in the final MP4 should be ~5 seconds shorter than the raw downloaded manifest for clips that had trailing silence detected, or ~5 seconds shorter regardless for clips that fell back.
4. **Negative test:** grab one of the downloaded raw clips from the tmp cache before TS conversion and play it — you should SEE the red outro in the raw clip. Play the same clip's TS version — red outro should be GONE.

### Commit message (bundled with Fix 1)

```
fix(news): force 16:9 aspect ratio + strip Al Jazeera red outro branding (Fix 1 + Fix 9 of 9)

Rob's smoke test #7 review surfaced two News clip normalization issues
that both live in the same FFmpeg TS conversion pass:

Fix 1 — aspect ratio: 3 Al Jazeera clips rendered at 9:16 vertical,
pillarboxed in the middle of the 1920×1080 frame. Al Jazeera publishes
some clips from vertical mobile video. Fix: zoom-to-fill crop via
scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,
reusing the same pattern Twitch already uses (commit 45f8980).

Fix 9 — outro branding removal: every Al Jazeera clip ends with ~5s of
branded red outro ("AL JAZEERA" logo, "more at aljazeera.com", fade).
CWN already credits sources in the video description — the visual
branding is redundant and dilutes CWN brand consistency. Fix: new
helpers detectTrailingSilence() + computeNewsClipTrimDuration() that
use FFmpeg silencedetect filter to find the last moment of speech in
each clip, trim to that timestamp, fall back to "last 5 seconds" if
no trailing silence detected. Sanity guards: never trim more than 30%
of clip duration, floor at 5s minimum.

Both fixes ship together because they modify the same FFmpeg clip
normalization pass. Splitting them would produce conflicting staged
changes to the same 10-line FFmpeg arg block.

Changes:
- server.js — new detectTrailingSilence() helper (silencedetect parser)
- server.js — new computeNewsClipTrimDuration() helper (trim logic + fallback + sanity guards)
- server.js — News source_clip TS conversion pass adds -t <duration>
  AND -vf scale/crop filter, in one FFmpeg invocation

Non-News clips (Twitch) untouched. Trim and aspect ratio changes
only fire when contentType === 'news'.

Test: after next smoke test, News clip segments should (a) fill full
1920×1080 frame with no pillarbox bars, and (b) end on real content,
not the red Al Jazeera branding card.

References: News smoke test #7 review, Rob attribution note ("we are
already giving them credit in our description of video")
```

---

## Fix 6 — Clips stopping after story 3 (orderedClipUrls alignment bug)

**File:** `server.js:6879-6886` (News `orderedClipUrls` build) + `server.js:4211-4237` (silence placeholder path)
**Effort:** 30-45 minutes. Logic-only fix, overlaps with Fix 3 from the parked 3-fix handoff.

### Current state

Test #7 filename: `42_avatar_3_clips`. 3 clips out of 10 stories. Rob: "it looks like on this we stopped pulling clips after the third story."

**Two possible root causes, both need investigation:**

**Cause A — `.filter(c => c.url)` breaks story-index alignment (from parked Fix 3).**

Fix 9's `orderedClipUrls` build at `server.js:6879-6886` uses `.filter(c => c.url)` to drop entries with empty URLs (failed scrapes). This destroys story-index alignment.

Example: stories 1, 2, 4 scraped successfully; stories 3, 5, 6, 7, 8, 9, 10 failed. Filtered array = `[clip1, clip2, clip4]`. The heygen-poller's clip insertion logic then assigns:
- `STORY1_CLIP_SLOT → clip1` ✅
- `STORY2_CLIP_SLOT → clip2` ✅
- `STORY3_CLIP_SLOT → clip4` ❌ (wrong story — story 3 was a failed scrape, story 4's clip is now mis-paired with story 3)
- `STORY4_CLIP_SLOT → undefined` (array exhausted)
- Stories 5-10: no clips at all.

**Cause B — Al Jazeera RSS feed hit rate is just 30%.**

The scraper's 30% hit rate means only 3 stories out of 10 actually had video to download, regardless of alignment bugs. If Cause A is fixed but Al Jazeera legitimately only publishes video on 3/10 stories, the result is the same.

**Diagnose first, then fix.**

### Diagnosis steps

1. Read the test #7 nodemon log (`logs/overnight_2026-04-13.log` equivalent — look for `[news-scrape]` or equivalent markers). Count how many stories triggered a successful `scrapeArticleVideo()` return vs how many returned null.
2. If >3 stories scraped successfully but only 3 made it to assembly, **Cause A is confirmed** (filter alignment bug). Ship the fix below.
3. If exactly 3 stories scraped successfully, **Cause B is confirmed** (scraper hit rate limitation). Fix 1A is a no-op here; the real fix is broader News source diversification (tracked separately, out of scope for this handoff — add to `LONGFORM_FIX_ROTATION.md` as a future item).

### Fix for Cause A

At `server.js:6879-6886`, change the `orderedClipUrls` build to preserve story indices with null placeholders:

```javascript
// BEFORE (drops failed scrapes, breaks index alignment):
const orderedClipUrls = items
  .map(item => ({ url: item.videoUrl, label: item.title, ... }))
  .filter(c => c.url);

// AFTER (preserves index, null means "no clip for this story"):
const orderedClipUrls = items.map(item => ({
  url: item.videoUrl || null,
  label: item.title,
  streamer: item.source,
  title: item.title,
  storyIndex: items.indexOf(item)  // explicit index tag
}));
```

Then update the heygen-poller clip insertion logic to SKIP null entries instead of consuming them:

```javascript
// In the heygen-poller interleaving loop, check for null:
if (orderedClipUrls[storyIndex] && orderedClipUrls[storyIndex].url) {
  // insert clip into segment list
} else {
  // skip — no clip available for this story, silence placeholder or tight avatar concat
}
```

### Fix for silence placeholder side effect (parked Fix 3 sub-bug)

The silence placeholder insertion at `server.js:4211-4237` fires whenever the NEXT planned segment is a source_clip, regardless of whether that source_clip actually downloaded. Failed downloads produce 0.25s black-frame + silent audio placeholders that appear as "video jumps" in the final MP4.

Add a pre-check: before inserting a silence placeholder, verify the corresponding source_clip file exists and is >100KB (min valid video size per `CONFIG.VIDEO.MIN_SEGMENT_SIZE`). If the clip file is missing or truncated, skip both the silence placeholder AND the broken source_clip segment — let the avatar segments concat directly without a gap.

### Verification

After test #8 (5 stories), filename should show `N_avatar_M_clips` where M matches the actual scraper success count. Log output should show clip assignments per story index with no off-by-one mispairings.

### Commit message

```
fix(news): preserve story-index alignment in orderedClipUrls, skip null entries cleanly (Fix 6 of 8)

Rob's smoke test #7 review: filename 42_avatar_3_clips showed only 3 of 10
stories had clips. Diagnosis: Fix 9's orderedClipUrls build at server.js:6879
used .filter(c => c.url) which drops failed scrapes. This destroys story-
index alignment — a scenario where stories 1/2/4 scraped successfully but
3/5/6/7/8/9/10 failed produces a 3-entry filtered array that the heygen-
poller then mispairs against story indices 1/2/3.

Changes:
- server.js:6879-6886 — orderedClipUrls maps items[] preserving nulls
  for failed scrapes, tagging each entry with storyIndex.
- server.js heygen-poller — clip insertion checks for null, skips
  cleanly when a story has no clip.
- server.js:4211-4237 — silence placeholder insertion pre-checks the
  corresponding source_clip file exists and is >100KB. Skip both the
  placeholder and the broken clip if file is missing.

Secondary root cause (Cause B from handoff diagnosis): Al Jazeera scrape
hit rate is ~30% on current RSS feed regardless of alignment. Broader
News source diversification tracked separately in LONGFORM_FIX_ROTATION.md.

References: News smoke test #7 review, Fix 3 from parked 3-fix handoff
```

---

## Fix 5 — Sidebar capacity cap + mutual exclusion + flag persistence

**Files:** `tools/clipzworld_newscast.html` (CSS + HTML) + `server.js:3876-3925` (Fix 7 state machine) + `generateNewscastOverlay()` at ~`server.js:10396`
**Effort:** 90-120 minutes. Biggest fix in the handoff. Multi-part rework.

### Current state from Rob's review

Three distinct sub-issues, all related to the chrome state machine:

**5a — Sidebar shows all 7+ stories at once, visually competing with TV card**

Rob: *"the story cards on far right are showing all story clips at once on a 10 story video we can only fit 7 stories on a screen"*

Rob clarified 2026-04-13 mid-handoff: **hard cap at 5 cards, no pagination/rotation logic.** If a 10-story episode runs, cards 6-10 simply don't appear in the sidebar. Dynamic swap (stories 1-5 → stories 6-10 mid-episode) is explicitly parked until post-test-cases.

Current: `tools/clipzworld_newscast.html` story-list renders all 10 cards in the right sidebar, regardless of active story. Overflow clips off-screen or crams cards too tight.

Target: static hard cap at 5 cards. One CSS rule, nothing else. No `cardRange` logic, no body attributes, no mid-episode swaps.

**5b — Sidebar + flag + TV card all visible simultaneously during STORY_INTRO (lack of mutual exclusion)**

Rob's test #7 screenshot shows the top-left flag (`.lower-third`), the top-right TV card, AND the right-side sidebar (7+ cards) all visible at the same time during a story intro. The flag + TV card should be mutually exclusive with the sidebar per the parked 3-fix handoff Fix 2b ("story cards need to not be on the screen when the other two pieces are on the screen").

Current Fix 7 two-state burn (`server.js:3876-3925`) generates:
- PNG A (flag + TV card visible, sidebar ALSO visible) for `t=0..introDur`
- PNG B (flag + TV card hidden, sidebar still visible) for `t>introDur`

Both states show the sidebar. Fix needed: during PNG A (flag+TVcard state), sidebar is hidden.

**5c — Flag should PERSIST across full story arc, not just during INTRO**

Rob: *"that top flag is supposed to stay on the screen during the intro setup, when set is back in view after clip and then through the setup and reaction, then come back with start of next story with video card"*

Current: flag (lower-third) visible only during `STORY#_INTRO` first `DURATION_NEWS` seconds. Hidden for SETUP, SUMMARY, REACTION, source_clip, and during the transition back to the next INTRO.

Target flag visibility timeline per story:
```
STORY#_INTRO (0s → introDur)    — flag VISIBLE, TV card VISIBLE, sidebar HIDDEN
STORY#_INTRO (introDur → end)    — flag VISIBLE, TV card HIDDEN, sidebar HIDDEN
source_clip segment              — flag HIDDEN (full-frame clip takes over)
STORY#_SETUP / SUMMARY / REACTION — flag VISIBLE, TV card HIDDEN, sidebar VISIBLE
(transition to next STORY#_INTRO) — flag stays VISIBLE up until 0.5s before next INTRO starts
Next STORY#_INTRO starts         — flag re-anchored with new story's text, TV card reappears, sidebar hides
```

### The rework

This supersedes parked Fix 2 entirely and adds the new 5-cap logic.

#### Piece A — Template CSS: static 5-card cap + sidebar-hidden state

In `tools/clipzworld_newscast.html`:

1. Add a CSS rule to statically limit visible story cards to 5. This is a one-line fix, no body attributes, no Puppeteer toggles, no rotation logic:
   ```css
   .story-list .story-card:nth-child(n+6) {
     display: none;
   }
   ```

2. Add a body-level class to hide the whole sidebar when flag+TVcard are active:
   ```css
   body.sidebar-hidden .story-list {
     opacity: 0;
     visibility: hidden;
     transition: opacity 0.5s ease, visibility 0.5s ease;
   }
   ```

3. Verify `.lower-third` already has its own `.visible` class and animation. Leave the animation alone; this fix just changes WHEN the class is toggled.

**Parked for post-test-cases (do NOT build now):** dynamic card rotation where stories 1-5 show during stories 1-5, then cards flip to 6-10 when story 6 begins. Rob explicitly deferred this — the infrastructure (state machine per-segment cardRange, Puppeteer body-attribute toggles) is not being built in this handoff. Static cap only.

#### Piece B — `generateNewscastOverlay()` options: add hideSidebar param

At ~`server.js:10396` update the function signature with just `hideSidebar`:

```javascript
async function generateNewscastOverlay(storyData, outputPath, storyIndex = 0, options = {}) {
  const {
    showLowerThird = false,
    hideSidebar = false,          // NEW — adds body.sidebar-hidden class
    episodeNumber = 1,
    activeCategory = 'WORLD NEWS'
  } = options;

  // ... existing Puppeteer setup ...

  await page.evaluate((data, activeIndex, showLowerThird, hideSidebar, episodeNumber, activeCategory) => {
    // existing toggle logic ...

    // NEW: sidebar hide toggle
    if (hideSidebar) {
      document.body.classList.add('sidebar-hidden');
    } else {
      document.body.classList.remove('sidebar-hidden');
    }

    // NEW: update .lower-third text for the CURRENT story (so it reflects the persistent flag content during SETUP/SUMMARY/REACTION)
    const activeStory = data.stories[activeIndex];
    if (activeStory) {
      const lowerThirdHeadline = document.querySelector('.lower-third .lt-headline');
      if (lowerThirdHeadline) lowerThirdHeadline.textContent = activeStory.title;
      const lowerThirdSource = document.querySelector('.lower-third .lt-source');
      if (lowerThirdSource) lowerThirdSource.textContent = activeStory.source;
    }

    // ... rest of existing logic ...
  }, storyData, storyIndex, showLowerThird, hideSidebar, episodeNumber, activeCategory);
}
```

No `cardRange` param. No `data-card-range` body attribute. The static CSS rule from Piece A handles the 5-card cap without any server-side involvement.

#### Piece C — Server state machine: per-scene-type overlay burns

Replace the current Fix 7 two-state burn at `server.js:3876-3925` with a per-scene-type burn selector.

For each avatar segment, determine its scene type from the segment label and burn the appropriate overlay PNG:

| Scene type | showLowerThird | hideSidebar |
|------------|----------------|-------------|
| COLD_OPEN | false | false |
| `STORY#_INTRO` (first `introDur` seconds) | true | true |
| `STORY#_INTRO` (after `introDur`) | true | true |
| `STORY#_SETUP` / `SUMMARY` / `REACTION` | true | false |
| `source_clip` segment | N/A (clip takes full frame, overlay may not burn at all) | — |
| `OUTRO` | false | false |

For each segment that needs a chrome burn:
1. Determine `showLowerThird` and `hideSidebar` from scene type (table above).
2. Call `generateNewscastOverlay(storyData, pngPath, storyIndex, {showLowerThird, hideSidebar, ...})`.
3. Burn the PNG over the avatar segment via FFmpeg `overlay=0:0:enable='between(t,0,segDuration)'`.

Source clips (`source_clip` segments) take the full frame — skip the chrome burn entirely for those. Flag disappears during clips per Rob's spec.

**No cardRange logic** — the static CSS cap from Piece A handles the 5-card limit without per-segment state tracking.

#### Piece D — Flag persistence with text updates

Because the flag now stays visible across SETUP/SUMMARY/REACTION, its content must update per scene (not just per story) or Rob will see story 1's headline on story 1's SETUP even if the scene content is about story 1's body. Since the flag reflects "current story being discussed," update `.lower-third` text to match the story the avatar is currently discussing, which changes per-scene-group (all 5 scenes of story 1 share the same flag text, then all 5 scenes of story 2 update together, etc.).

The `storyIndex` parameter already tells `generateNewscastOverlay()` which story is active. Piece B's Puppeteer evaluate step already pulls `data.stories[activeIndex]` and sets the headline text. This "just works" if `storyIndex` is passed correctly from the server state machine for every segment (not just INTROs).

### Verification

After test #8 (5 stories):

1. Every story INTRO segment: flag visible top-left, TV card visible top-right, sidebar HIDDEN.
2. Every story SETUP/SUMMARY/REACTION: flag visible top-left (persistent), TV card HIDDEN, sidebar VISIBLE showing all 5 stories.
3. Source clip segments: no chrome, full-frame clip.
4. Transition from story N to story N+1: flag content updates to story N+1's headline as the new INTRO begins.

For a future 10-story test: sidebar just shows stories 1-5; stories 6-10 are invisible in the sidebar the entire episode. Dynamic swap is parked per Rob 2026-04-13.

### Commit message

```
fix(news): chrome state machine rework — sidebar 5-card cap, mutual exclusion,
           flag persistence across story arc (Fix 5 of 8)

Supersedes parked Fix 2 from CLINE_HANDOFF_NEWS_SMOKE_TEST_6_THREE_FIXES.md
with an expanded rework based on Rob's smoke test #7 review.

Three sub-issues resolved:
1. Sidebar showed 10 cards at once (visual overflow) → now capped to 5 via
   static CSS nth-child rule. Dynamic rotation (swap stories 1-5 → 6-10
   mid-episode) is PARKED until post-test-cases per Rob 2026-04-13.
2. Sidebar + flag + TV card visible simultaneously during STORY_INTRO
   (visual clutter) → sidebar now hides when flag+TV card are active
   (body.sidebar-hidden class).
3. Flag (.lower-third) only visible during STORY_INTRO → now persists
   across INTRO/SETUP/SUMMARY/REACTION, hides during source_clip segments,
   updates text content per active story.

Changes:
- tools/clipzworld_newscast.html — CSS: static .story-list 5-card cap
  via :nth-child(n+6){display:none}, body.sidebar-hidden state.
- server.js generateNewscastOverlay() — one new options param:
  hideSidebar, with Puppeteer evaluate-step toggle and per-story flag
  text updates.
- server.js Fix 7 state machine (~3876-3925) — rewritten as per-scene-type
  burn selector: scene type → {showLowerThird, hideSidebar} mapping
  applied per avatar segment.

Test plan: News smoke test #8 (5 stories). Expected: flag visible throughout
all avatar segments, TV card only during STORY_INTRO first introDur seconds,
sidebar visible except during STORY_INTRO state, source clip segments have
no chrome burn.

References: News smoke test #7 review, parked Fix 2 from 3-fix handoff
(superseded)
```

---

## Fix 2 — Bobby G double-pronunciation (diagnosis-first)

**Files:** TBD based on diagnosis
**Effort:** 30-60 minutes diagnosis + fix.

### Current state

Rob: *"bobby g is pronouncing certain words twice sometimes"*

Rob flagged one specific timestamp window during handoff draft (2026-04-13): **2:15–2:25 in the Hungary story**, plus 2 other instances he heard but didn't timestamp. Start diagnosis there.

### Diagnosis checklist

1. **Start with Rob's 2:15–2:25 Hungary window.** Open `output/news_monday_april_13_2026_42_avatar_3_clips__1776081943778.mp4` and scrub to 2:15. Note every exact word Bobby G repeats between 2:15 and 2:25. Then continue watching the rest of the MP4 end-to-end and collect 2-4 more examples (Rob heard at least 2 more but didn't timestamp them).

2. **For each example, find the corresponding script text.** Grep the Gemini-generated script (persisted on the job card or in `output/qa_failures/gate1_script_pass_1776081199254.txt`) for the surrounding sentence. The Hungary story should be `STORY#_INTRO` / `STORY#_SETUP` / `STORY#_SUMMARY` / `STORY#_REACTION` for whichever story index Hungary is — likely story 3-6 based on timestamp 2:15 in a ~14-min episode.

3. **Classify each example:**

   **Class A — Gemini script duplication.** The word appears twice in a row in the generated script text (e.g., "military military"). Root cause: Gemini prompt artifact or SSML cleanup bug. Fix: check `cleanAvatarText()` at `cwn_production.html:3241` for any regex that might duplicate words; check News prompt for any instruction that could cause Gemini to literal-repeat words.

   **Class B — SSML cleanup artifact.** The script has a `<break>` or `<emphasis>` tag around a word and HeyGen's TTS engine is rendering the word, then the tag is being interpreted as a cue to repeat. Fix: check every SSML tag inserted into the input_text. Only `<break time="..."/>` should be used per `cleanAvatarText()`. Any `<say-as>`, `<emphasis>`, `<phoneme>` tags could cause re-reads.

   **Class C — HeyGen speed artifact.** At 0.85x speed, HeyGen's Bobby G voice occasionally stutters on certain phonemes (hard consonants, sibilants). This is a known HeyGen voice clone behavior. Fix: if Class C is the root cause, the only options are (a) slightly increase speed to 0.90, (b) report the issue to HeyGen, (c) add a post-processing audio pass to clean stutters (hard, not worth it). Rob already said "we can keep same speed" so option (a) is off the table unless Class A/B are ruled out.

4. **Default action if diagnosis is inconclusive:** ship the handoff without a code fix for Fix 2, add a note to `LONGFORM_FIX_ROTATION.md` that it's parked pending more examples, and re-assess after test #8. The issue may self-resolve if it's Class A and Fix 3 (source attribution removal) also cleans other prompt artifacts.

### Commit message (only if a fix ships)

```
fix(news): Bobby G double-pronunciation [root cause] (Fix 2 of 8)

Rob's smoke test #7 review: Bobby G pronounced certain words twice in
several scenes. Diagnosis: [Class A/B/C based on examples collected].

Root cause: [specific]
Fix: [specific]

Test: [verification]

References: News smoke test #7 review
```

If no fix ships this cycle, add a note to `LONGFORM_FIX_ROTATION.md`:

```
### Bobby G double-pronunciation (parked)

Observed in News smoke test #7 but no specific timestamps collected.
Diagnosis deferred to next smoke test — collect 3-5 timestamped examples
during test #8 review before touching code. Possible root causes:
Gemini script duplication, SSML cleanup artifact, HeyGen speed stutter.
```

---

## Workflow reminder — after this handoff ships

Per Rob's new smoke-test contract (2026-04-13):

1. Rob runs News smoke test #8 with **5 stories** (not 10)
2. Rob reviews test #8 MP4 + Gate reports
3. Rob + Claude Code collect all new gaps into `CLINE_HANDOFF_NEWS_SMOKE_TEST_8_FIXES.md`
4. Cline ships that handoff
5. Repeat until News long-form is locked (clean pass, no new gaps)
6. Only then does NBA work (`CLINE_HANDOFF_NBA_VOICEOVER_FFMPEG_V2.md` etc.) unblock
7. NBA adopts the News chrome set (same layout, NBA hex colors + brand text)
8. Twitch adopts the News chrome set (same layout, Twitch hex + brand text)
9. Short-form rework happens last, across all 3 content types simultaneously

**Do NOT touch NBA or Twitch code in this handoff.** All 8 fixes above are News-only, except Fix 8 (Gate 2 regex) which is cross-cutting infrastructure and benefits every content type.

---

## Commit hygiene

- Re-read `COMMIT_CHECKLIST.md` before each commit
- Atomic staging (`git add <files> && git commit -m "..."`, never split)
- Update `STATUS.md` → 🤖 Last Agent Action table (pre-commit hook blocks skips)
- Update `LONGFORM_FIX_ROTATION.md` → move Fix N from 🔴 To Fix / 📤 Dispatched to ✅ Shipped with commit hash
- `node -c server.js` exit 0 before each commit
- Conventional commit format with `file:line` references where applicable
- Push to `origin/main` after each commit
- nodemon auto-restarts server on `server.js` changes; Python dashboard server needs manual restart on `cwn_production.html` / `tools/clipzworld_newscast.html` changes (but chrome rebuild is server-side Puppeteer so the HTML changes take effect next burn cycle, no restart needed)

## Not in scope

- NBA long-form (voiceover handoff stays parked)
- Twitch long-form (no active gaps)
- Short-form anything
- Module split Phase 2 (Aider overnight)
- Atlassian integration (Aider overnight, separate track)
- News source diversification beyond Al Jazeera (tracked separately in LONGFORM_FIX_ROTATION.md if scraper hit rate turns out to be the Cause B root of Fix 6)

## Open questions for Rob to answer in-thread

1. ~~**Fix 5a — sidebar capacity cap:** exactly 5 cards on screen, or different number?~~ **RESOLVED 2026-04-13:** hard cap at 5, no rotation. Dynamic swap (stories 1-5 → 6-10) parked until post-test-cases.
2. **Fix 2 — Bobby G double-pronunciation:** any specific timestamp + word from test #7 MP4 Rob can flag? Without it, fix may ship without a code change this cycle.
