# CLINE_HANDOFF_NEWS_SMOKE_TEST_6_THREE_FIXES.md

**Author:** Claude Code (dispatched 2026-04-13 early morning, post smoke test #6 diagnosis)
**For:** Cline (three targeted fixes from Rob's YouTube Studio review + diagnostic trace of smoke test #6)
**Scope:** Three News long-form fixes surfaced during smoke test #6 visual review. Each is a self-contained section below. Ship as 3 atomic commits (or bundle into 1-2 if the files overlap cleanly). Non-blocking to each other — can ship in any order but the chrome fixes (Fix 1 + Fix 2) benefit from visual verification against a working clip pipeline, so ideally run a News smoke test #7 AFTER the previously-dispatched Fix 9b (`CLINE_HANDOFF_NEWS_FIX_9B_HLS_DOWNLOAD.md`) ships and BEFORE this handoff starts so Cline has a clean reference frame.
**Ship order:** Flexible. My suggested order: Fix 3 → Fix 1 → Fix 2. Fix 3 is pure server logic with no visual dependency; Fix 1 is a trivial CSS tweak; Fix 2 is the biggest rework and benefits from having Fix 1 shipped first.
**Do NOT touch:** NBA, Twitch, short-form code paths. Fix 6 (News Gemini prompt), Fix 7 (Fix 7 state machine at `server.js:3876-3925`), Fix 8B (`generateNewsStoryCardPNG` at `server.js:888`), Fix 9 (`scrapeArticleVideo` at `server.js:6222`). Only touch the specific lines listed in each fix section.
**Before each commit:** Re-read `COMMIT_CHECKLIST.md`. Atomic staging. STATUS.md update. LONGFORM_FIX_ROTATION.md update per commit.

---

## Dispatch context

This handoff stacks on top of two others that should be dispatched FIRST:

1. **`CLINE_HANDOFF_GAP_51_STAGE_DIRECTION_LEAK.md`** — defensive cleanAvatarText wrapper at `cwn_production.html:1261`. Fixes the "video freeze + audio fail" Gate 3 caught on smoke test #6 (stage-direction text like `[3-second pause — hold on source clip]` being rendered by HeyGen as on-screen text + silence). Ship first.

2. **`CLINE_HANDOFF_NEWS_FIX_9B_HLS_DOWNLOAD.md`** — Brightcove CDN whitelist + HLS `.m3u8` detection in `downloadFile()` at `server.js:966`. Fixes the "zero clips actually play" issue (Fix 9 scraped real Brightcove HLS URLs but downloadFile blocked them at the SSRF whitelist). Ship second.

**After those two land**, Rob runs News smoke test #7. Review the output visually. THEN start this handoff.

**Why the order matters:** Fix 1 + Fix 2 in this handoff are visual chrome changes that need to be verified against a frame where clips are actually playing. If you ship them before smoke test #7 demonstrates working clips, you can't visually confirm whether the chrome state machine behaves correctly during clip playback vs. avatar playback. Fix 3 is a logic-only fix that doesn't need visual verification, so it can ship before smoke test #7 — but it's easier to batch all 3 into one dispatch window after smoke test #7 runs cleanly.

---

## What smoke test #6 revealed (the three findings)

From Rob's visual review of the smoke test #6 YouTube Studio output + the nodemon FFmpeg logs + my diagnostic trace:

1. **The red `● LIVE | APRIL 13, 2026` indicator is flush against the right frame edge.** Rob wants it moved left so it's not pinned to the edge.

2. **The blue-and-gold flag (`.lower-third` top-left element) is NOT aligned to the top-left corner** of the frame in the rendered output. Additionally, it's coexisting with the right-side story list sidebar, which Rob flagged as wrong — the story list should NOT be on screen while the flag + TV card are showing. They need to be mutually exclusive, with the story list leaving 0.5–1.0 seconds BEFORE the flag + TV card animate in.

3. **Clips are not playing, and the nodemon log reveals two separate bugs that compound:**
    - Fix 9's `orderedClipUrls` build at `server.js:6879-6886` uses `.filter(c => c.url)` to drop entries with empty URLs. This destroys story-index alignment — a scenario where stories 3 and 4 scraped successfully but 1/2/5 did not produces a 2-entry filtered array, which the heygen-poller then assigns to STORY1_SETUP and STORY2_SETUP (wrong story-to-content pairing).
    - The silence placeholder insertion at `server.js:4211-4237` fires whenever the NEXT planned segment is a source_clip, regardless of whether that source_clip actually downloaded. Failed downloads produce 0.25s black-frame + silent audio placeholders that appear as "video jumps" in the final MP4.

---

## Fix 1 — Move red LIVE indicator left from the right frame edge

**File:** `tools/clipzworld_newscast.html`
**Element:** `.top-right` container inside `.top-bar`
**Effort:** ~2 minutes. Single CSS line change.

### Current state

The top bar's right-side container holds the `● LIVE` indicator + date display. It's currently positioned via `margin-left: auto` (in the existing `.top-right` CSS rule) which pushes it flush against the right frame edge. Rob wants it pulled inward.

### The fix

Find `.top-right` in `tools/clipzworld_newscast.html` CSS. It currently looks roughly like:

```css
.top-right {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 16px;
}
```

Add `margin-right: 80px` to pull the element inward from the right edge:

```css
.top-right {
  margin-left: auto;
  margin-right: 80px;  /* pull LIVE indicator + date inward from frame edge */
  display: flex;
  align-items: center;
  gap: 16px;
}
```

**Target distance from right edge: ~80px.** Tuneable — if Rob reviews smoke test #7 and says "more" or "less," adjust the value. Do NOT change the internal layout of the `.top-live` or `.top-time` elements — they're fine as-is. Only the outer container position.

### Verification

- Grep check: `grep -n "top-right" tools/clipzworld_newscast.html` should show the updated CSS rule with `margin-right: 80px`
- Visual: when rendered via Puppeteer and burned into the final MP4, the red LIVE dot + date should have visible space between them and the right frame edge
- Do NOT break anything else in the top bar — the brand name + episode number on the LEFT side should remain unchanged

### Commit message

```
fix(news): move LIVE indicator + date inward from top-right frame edge (Fix 1 of 3)

Rob's smoke test #6 review: the red ● LIVE | APRIL 13, 2026 indicator
was flush against the right frame edge of the rendered MP4. Pull it
inward by adding margin-right:80px to the .top-right container.

Changes:
- tools/clipzworld_newscast.html — add margin-right:80px to .top-right

References: smoke test #6 Rob visual review, gap audit Fix 1 of 3
```

---

## Fix 2 — Blue-and-gold flag top-left alignment + mutual-exclusive with sidebar

**Files:** `tools/clipzworld_newscast.html` (CSS + HTML) + `server.js` (optional state machine refinement)
**Effort:** ~45-60 minutes. Multi-part fix.

### Current state

From Rob's smoke test #6 visual review:

1. The `.lower-third` element (what Rob calls "the blue-and-gold flag") is not cleanly aligned to the top-left corner. Per Fix 7's CSS at `tools/clipzworld_newscast.html:32-41`, it's positioned at `top: 48, left: 0, width: 720` — which SHOULD put it flush against the top bar bottom edge (48px tall top bar → `.lower-third` starts at y=48) and flush against the left frame edge. If it's visibly misaligned in the rendered frame, something is clipping it, offsetting it, or the state machine isn't toggling its visibility correctly.

2. The right-side story list sidebar is visible at the SAME TIME as the flag + TV card. Per Rob's directive: **"story cards need to not be on the screen when the other two pieces [flag + TV card] are on the screen"** — meaning the sidebar and the flag+card pair are MUTUALLY EXCLUSIVE. When one is on, the other is off.

3. Additionally, Rob's earlier direction during the design conversation: **"cards leave the screen 0.5s-1s before the TV card lands"** — meaning the sidebar hides with a 0.75s lead time before the flag + TV card animate in. Smoothest visual: sidebar fades out during the LAST 0.75s of the scene BEFORE a `STORY#_INTRO` scene begins, so when `STORY#_INTRO` starts, the sidebar is already gone and the flag + TV card slide in cleanly.

### The fix — three sub-parts

#### Sub-fix 2a — Verify and force `.lower-third` top-left corner alignment

In `tools/clipzworld_newscast.html`, the `.lower-third` CSS rule should look roughly like:

```css
.lower-third {
  position: absolute;
  top: 48px;        /* just below the 48px top bar */
  left: 0;          /* flush against left frame edge */
  width: 720px;     /* pulled back from Bobby G's head */
  /* ... existing flex + visibility + animation rules ... */
  opacity: 0;
  visibility: hidden;
}

.lower-third.visible {
  opacity: 1;
  visibility: visible;
  animation: slideInLeft 0.5s cubic-bezier(0.22,1,0.36,1) 0.3s forwards;
  transform: translateX(0);
}
```

**Check that the existing rule actually reads `top: 48px; left: 0;`** — if it's `top: 48px; left: 32px;` or `top: 60px;` or something else, change it to `top: 48px; left: 0;` so the element is flush with the top bar bottom and the left frame edge.

**Also verify that when `.lower-third.visible` is applied, the `transform: translateX(0)` fully overrides any initial off-screen transform.** The `slideInLeft` animation should start from `translateX(-100%)` and end at `translateX(0)` — and the `forwards` fill mode keeps it at the end state.

**If the element is rendering at `left: 0` correctly but the `.lt-top` and `.lt-bottom` child elements are off-alignment** (for example, the `.lt-top`'s `clip-path: polygon(...)` is cutting off the left edge), inspect the child element positioning and ensure they're aligned to the parent's left edge without cutting off content.

#### Sub-fix 2b — Mutually-exclusive sidebar vs flag+TV-card state machine

**This is a template CSS + server.js state machine change.**

Currently Fix 7's two-state burn at `server.js:3876-3925` generates two PNG states per `STORY#_INTRO` segment:

- **PNG A (`showLowerThird: true`)** — lower-third visible, sidebar ALSO visible. Burned for first `DURATION_NEWS` seconds of the scene.
- **PNG B (`showLowerThird: false`)** — lower-third hidden, sidebar visible. Burned for the remainder of the scene.

This produces the overlap Rob flagged on smoke test #6 — PNG A has BOTH the flag and the sidebar visible at the same time.

**Change the state machine to make sidebar visibility INVERSE to lower-third visibility:**

- **PNG A (flag + TV card visible)** — lower-third VISIBLE, **sidebar HIDDEN**. This is the "story is being announced" state.
- **PNG B (flag + TV card hidden)** — lower-third HIDDEN, **sidebar VISIBLE**. This is the "Bobby G is talking" state.

**Template-side change in `tools/clipzworld_newscast.html`:**

Add a new CSS rule that hides the `.story-list` when the `.lower-third` has the `.visible` class. Use the general sibling combinator:

```css
/* When lower-third is visible, hide the sidebar story list. Mutually exclusive. */
.lower-third.visible ~ .story-list {
  opacity: 0;
  visibility: hidden;
}

/* Optional: smoother transition via CSS opacity */
.story-list {
  transition: opacity 0.5s ease, visibility 0.5s ease;
}
```

**IMPORTANT:** the `~` (general sibling combinator) requires `.lower-third` and `.story-list` to be siblings in the DOM tree. Verify they ARE siblings — both should be direct children of `<body>` or both children of the same parent container.

**If they're not siblings,** use a different approach: the `generateNewscastOverlay()` function at `server.js:10396+` can add a body-level class (e.g., `body.lower-third-visible`) via `page.evaluate()` at the same moment it toggles `.lower-third.visible`. Then the CSS rule becomes:

```css
body.lower-third-visible .story-list {
  opacity: 0;
  visibility: hidden;
}
```

**This sibling-class approach is more robust than the DOM sibling combinator.** Recommend using body class.

**Server-side — no change needed.** The existing Fix 7 two-state burn at `server.js:3876-3925` continues passing `showLowerThird: true/false` to `generateNewscastOverlay()`. The overlay function toggles the `.visible` class on `.lower-third` as it already does. The NEW sibling-class or body-class CSS rule automatically hides the sidebar when `.visible` is set. **No server.js changes required.**

#### Sub-fix 2c — Sidebar leaves 0.75s before flag+card arrive (transition timing)

**Default implementation:** the CSS `transition: opacity 0.5s ease` from sub-fix 2b handles the fade timing inside the PNG screenshot at whatever moment Puppeteer captures it. **But PNG screenshots are single-frame captures — they can't express a 0.75s fade animation across multiple frames.** Each segment burn captures ONE moment in time.

**The timing fix has to happen at the FFmpeg burn layer**, not the CSS layer. Here's the approach:

Extend Fix 7's two-state burn at `server.js:3876-3925` to a **three-state burn** for `STORY#_INTRO` segments:

1. **State 1 (first 0.75s of scene):** `showLowerThird: false` AND `hideSidebar: true` (both off — transition moment)
2. **State 2 (0.75s to `DURATION_NEWS` seconds):** `showLowerThird: true` (flag+card on, sidebar off via sibling/body-class rule)
3. **State 3 (`DURATION_NEWS` seconds to end of scene):** `showLowerThird: false` (flag+card off, sidebar on)

**That requires a third parameter in `generateNewscastOverlay()` options:** `hideSidebar: boolean`. When `hideSidebar: true`, the function adds a `body.sidebar-hidden` class (or similar) via `page.evaluate()`. Template CSS hides the sidebar on that class.

**Then the FFmpeg burn graph at `server.js:3891-3901` (approximate lines based on Fix 7's existing 2-state structure) changes from 2-input to 3-input:**

```javascript
if (isStoryIntro) {
  // Three-state burn for STORY#_INTRO:
  //   State 1 (0 to 0.75s):           sidebar hidden, lower-third hidden (transition gap)
  //   State 2 (0.75s to introDur):    sidebar hidden, lower-third visible (flag + TV card)
  //   State 3 (introDur to end):      sidebar visible, lower-third hidden (Bobby G talking)
  const overlayState1Path = path.join(TMP_DIR, `newscast_state1_${Date.now()}.png`);  // both off
  const overlayState2Path = path.join(TMP_DIR, `newscast_state2_${Date.now()}.png`);  // flag + card on
  const overlayState3Path = path.join(TMP_DIR, `newscast_state3_${Date.now()}.png`);  // sidebar on

  await generateNewscastOverlay(overlayBase, overlayState1Path, activeStoryIndex, {
    showLowerThird: false, hideSidebar: true, episodeNumber, activeCategory
  });
  await generateNewscastOverlay(overlayBase, overlayState2Path, activeStoryIndex, {
    showLowerThird: true, hideSidebar: true, episodeNumber, activeCategory
  });
  await generateNewscastOverlay(overlayBase, overlayState3Path, activeStoryIndex, {
    showLowerThird: false, hideSidebar: false, episodeNumber, activeCategory
  });

  const TRANSITION_GAP = 0.75;
  const introDur = CONFIG.INTRO_CARD.DURATION_NEWS || CONFIG.INTRO_CARD.DURATION_SECONDS || 10;

  // Three-input FFmpeg burn with time-gated overlay states:
  //   [0:v] = base video, [1:v] = state1 PNG, [2:v] = state2 PNG, [3:v] = state3 PNG
  const burnArgs = [
    '-i', inputForTS,
    '-i', overlayState1Path,
    '-i', overlayState2Path,
    '-i', overlayState3Path,
    '-filter_complex',
    `[0:v][1:v]overlay=0:0:enable='lt(t,${TRANSITION_GAP})'[m1];` +
    `[m1][2:v]overlay=0:0:enable='between(t,${TRANSITION_GAP},${introDur})'[m2];` +
    `[m2][3:v]overlay=0:0:enable='gte(t,${introDur})'[out]`,
    '-map', '[out]', '-map', '0:a',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', '44100', '-y', burnedPath
  ];
}
```

**For non-INTRO News avatar segments** (SETUP, SUMMARY, REACTION, cold open INTRO, OUTRO), the existing single-state burn continues to use `showLowerThird: false, hideSidebar: false` — flag off, sidebar on. No change needed.

#### Template-side — add the `hideSidebar` option to `generateNewscastOverlay()`

**File:** `server.js` function `generateNewscastOverlay()` at approximately line 10396+

Add `hideSidebar` to the options parameter:

```javascript
async function generateNewscastOverlay(storyData, outputPath, storyIndex = 0, options = {}) {
  const {
    showLowerThird = false,
    hideSidebar = false,   // ← NEW
    episodeNumber = 1,
    activeCategory = 'WORLD NEWS'
  } = options;

  // ... existing Puppeteer setup ...

  await page.evaluate((data, activeIndex, showLowerThird, hideSidebar, episodeNumber, activeCategory) => {
    // ... existing toggle logic ...

    // NEW: toggle sidebar visibility via body class
    if (hideSidebar) {
      document.body.classList.add('sidebar-hidden');
    } else {
      document.body.classList.remove('sidebar-hidden');
    }

    // ... rest of existing evaluate logic ...
  }, storyData, storyIndex, showLowerThird, hideSidebar, episodeNumber, activeCategory);
}
```

And in the template CSS:

```css
body.sidebar-hidden .story-list {
  opacity: 0;
  visibility: hidden;
}
```

### Verification for Fix 2

- Grep checks:
  - `grep -n "\.lower-third" tools/clipzworld_newscast.html` → shows the `top: 48; left: 0` rule
  - `grep -n "sidebar-hidden\|hideSidebar" server.js` → shows the new option plumbing
  - `grep -n "body.sidebar-hidden" tools/clipzworld_newscast.html` → shows the new CSS rule
  - `grep -n "TRANSITION_GAP\|overlayState1Path\|overlayState3Path" server.js` → shows the new 3-state burn

- `node -c server.js` exit 0

- Nodemon clean restart

- Visual verification on News smoke test #7:
  - During `STORY#_INTRO` scenes: TV card top-right + flag top-left both visible, sidebar HIDDEN
  - During `STORY#_SETUP/SUMMARY/REACTION` scenes: TV card + flag hidden, sidebar VISIBLE
  - Transition smoothness: the 0.75s gap at start of each STORY#_INTRO should feel like a clean wipe, not a hard swap

### Commit message

```
fix(news): chrome state machine — sidebar hides when flag + TV card appear (Fix 2 of 3)

Rob smoke test #6 review: the right-side story list sidebar was visible
at the same time as the flag (lower-third) + TV card during STORY#_INTRO
scenes, producing visual clutter. Rob's directive: "story cards need to
not be on the screen when the other two pieces are on the screen"
— mutually exclusive state machine.

Additionally: sidebar leaves 0.75 seconds before the flag + TV card animate
in for a smoother transition (no dead gap where both elements are fighting
for the same frame real estate).

Changes:
- tools/clipzworld_newscast.html — verify .lower-third at top:48,left:0;
  add body.sidebar-hidden .story-list { opacity:0; visibility:hidden }
- server.js generateNewscastOverlay() — add hideSidebar: boolean option
  that toggles body.sidebar-hidden class via page.evaluate
- server.js STORY#_INTRO burn loop — extend Fix 7 two-state burn to
  three-state: state1 (both off, 0-0.75s), state2 (flag+card on, sidebar
  hidden, 0.75-introDur), state3 (flag+card off, sidebar on, introDur-end)
- Non-INTRO avatar scenes unchanged — single-state burn with sidebar on

References: smoke test #6 Rob visual review, gap audit Fix 2 of 3
```

---

## Fix 3 — `orderedClipUrls` alignment + silence placeholder skip

**Files:** `server.js` (two separate sections)
**Effort:** ~30 minutes. Logic-only fix, no visual verification needed.

### Current state — two interacting bugs

**Bug A — Fix 9's `.filter(c => c.url)` breaks story-index alignment.**

At `server.js:6879-6886` (Fix 1 + Fix 9 combined News orderedClipUrls build):

```javascript
if (type === 'news') {
  orderedClipUrls = items.map((item, i) => ({
    url:      item.videoUrl || item.clipUrl || '',
    clipUrl:  item.videoUrl || item.clipUrl || '',
    pageUrl:  item.link || item.url || '',
    label:    `STORY${i + 1}_CLIP`,
    streamer: `story_${i + 1}`,
    title:    item.title || `Story ${i + 1}`
  })).filter(c => c.url); // only include stories that have a real video URL
  console.log(`[generate-full-script] Built News orderedClipUrls: ${orderedClipUrls.length}/${items.length} stories have clip URLs`);
}
```

**The `.filter(c => c.url)` drops entries with empty URLs.** This compacts the array — if only stories 3 and 4 scraped successfully out of 5, the filtered array becomes length-2 with entries labeled `STORY3_CLIP` and `STORY4_CLIP` at indices `[0]` and `[1]`.

**Then the heygen-poller at `server.js:250-261` uses a sequential `clipIdx` counter:**

```javascript
// If this is a SETUP scene, insert the corresponding source clip after it
if (/SETUP/i.test(avatarSeg.sceneName) && clipIdx < orderedClipUrls.length) {
  const clip = orderedClipUrls[clipIdx];
  segmentData.push({
    url:     clip.clipUrl || clip.url || '',
    pageUrl: clip.pageUrl || '',
    label:   clip.label || `CLIP_${clipIdx + 1}`,
    type:    'source_clip',
    clipUrl: clip.clipUrl || clip.url || ''
  });
  clipIdx++;
}
```

**When iterating SETUP scenes (STORY1_SETUP, STORY2_SETUP, ...STORY5_SETUP) against a filtered length-2 orderedClipUrls array:**

- STORY1_SETUP → `orderedClipUrls[0]` = STORY3's clip URL → segmentData gets STORY3's clip inserted at STORY1's position
- STORY2_SETUP → `orderedClipUrls[1]` = STORY4's clip URL → segmentData gets STORY4's clip at STORY2's position
- STORY3_SETUP, STORY4_SETUP, STORY5_SETUP → `clipIdx >= orderedClipUrls.length` → NO clip inserted

**Result: stories 1 and 2 would play clips that are actually about stories 3 and 4.** Nonsensical story-to-content pairing. Confirmed in smoke test #6's log:

```
⬇  [AVATAR] 3/24: STORY1_SETUP
⬇  [SOURCE_CLIP] 4/24: STORY3_CLIP      ← STORY3's clip inserted after STORY1_SETUP (WRONG)
⬇  [AVATAR] 5/24: STORY1_SUMMARY
...
⬇  [AVATAR] 8/24: STORY2_SETUP
⬇  [SOURCE_CLIP] 9/24: STORY4_CLIP      ← STORY4's clip inserted after STORY2_SETUP (WRONG)
```

**Bug B — Silence placeholder insertion doesn't check download success.**

At `server.js:4211-4237`:

```javascript
// Add 0.25s silence buffer after avatar segments before source clips
// Prevents Bobby G getting cut off mid-word when clip starts
const nextSeg = segsToProcess[i + 1];
const currSegType = segTypes[tsFiles.length - 1] || 'avatar';
const nextSegType = nextSeg && nextSeg.type === 'source_clip' ? 'source_clip' : 'avatar';
if (currSegType === 'avatar' && nextSegType === 'source_clip') {
  const silencePath = tsPath.replace('.ts', '_silence.ts');
  try {
    await new Promise((res, rej) => {
      const args = [
        '-f', 'lavfi', '-i', 'color=c=#000000:s=1920x1080:r=30:d=0.25',
        '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo:d=0.25',
        // ... encode to ts ...
      ];
      // ... exec ...
    });
    tsFiles.push(silencePath);
    segTypes.push('avatar'); // treat silence as avatar for transition logic
  } catch(e) {
    // non-fatal — skip silence if it fails
  }
}
```

The condition at line 4215-4216 checks `segsToProcess[i + 1].type === 'source_clip'` — the ORIGINAL plan, not the actual download state. If the planned source_clip failed download (e.g., SSRF block on Brightcove URLs), the silence placeholder still gets inserted because the condition only checks intent, not outcome.

**Result:** each failed source_clip position gets a 0.25-second black-frame + silent-audio placeholder. These appear as visible "video jumps" in the final MP4 — viewer sees Bobby G finish SETUP, then a black flash, then Bobby G in SUMMARY. Confirmed in smoke test #6 where 22 avatar segments + 2 silence placeholders = 24 total normalized segments (log line: `"✅ 24 segments normalized"` from a run where only 22 avatar files actually downloaded).

### The fix — two sub-parts, can ship as one commit

#### Sub-fix 3a — Preserve story-index alignment in `orderedClipUrls`

**Change `server.js:6879-6886` to keep the full-length array without filtering:**

```javascript
if (type === 'news') {
  // Build orderedClipUrls with ONE entry per story (even for stories that failed
  // to scrape a video). Empty-URL entries remain in the array to preserve story-index
  // alignment — the heygen-poller skips them at insertion time via the null-URL check.
  orderedClipUrls = items.map((item, i) => ({
    url:      item.videoUrl || item.clipUrl || '',
    clipUrl:  item.videoUrl || item.clipUrl || '',
    pageUrl:  item.link || item.url || '',
    label:    `STORY${i + 1}_CLIP`,
    streamer: `story_${i + 1}`,
    title:    item.title || `Story ${i + 1}`,
    storyIndex: i  // ← NEW: explicit 0-based story index for alignment
  }));
  // NO .filter() — keep all 5 entries, including null-URL ones
  const withUrls = orderedClipUrls.filter(c => c.url).length;
  console.log(`[generate-full-script] Built News orderedClipUrls: ${withUrls}/${items.length} stories have clip URLs (full-length array preserved for alignment)`);
}
```

**Note the removed `.filter()` and the added `storyIndex` field.**

#### Sub-fix 3b — Update heygen-poller to look up clip by story index, not sequential counter

**Change `server.js:220-261` to use scene-name-based story index lookup instead of sequential clipIdx:**

```javascript
const orderedClipUrls = card.orderedClipUrls || [];
const segmentData = [];

for (const avatarSeg of sortedAvatarSegs) {
  // Add the avatar segment
  segmentData.push({
    url:   avatarSeg.video_url,
    label: avatarSeg.sceneName,
    type:  'avatar'
  });

  // For News: attach cardData to STORY#_INTRO segments (existing Fix 8B logic — unchanged)
  if ((card.contentType || 'twitch') === 'news' && /STORY(\d+)_INTRO/i.test(avatarSeg.sceneName)) {
    // ... existing cardData attachment logic — no changes ...
  }

  // If this is a SETUP scene, insert the corresponding source clip after it
  // NEW: Look up the clip by story index (derived from scene name) instead of
  // using a sequential clipIdx counter. This preserves alignment even when some
  // stories fail to scrape.
  if (/SETUP/i.test(avatarSeg.sceneName)) {
    // Derive story index from scene name (e.g., STORY3_SETUP → story index 2 zero-based)
    const storyMatch = avatarSeg.sceneName.match(/STORY(\d+)_SETUP/i);
    if (storyMatch) {
      const storyIdx = parseInt(storyMatch[1], 10) - 1; // 1-based scene → 0-based index
      const clip = orderedClipUrls[storyIdx];

      // Only insert if the clip exists AND has a real URL
      if (clip && (clip.clipUrl || clip.url)) {
        segmentData.push({
          url:     clip.clipUrl || clip.url || '',
          pageUrl: clip.pageUrl || '',
          label:   clip.label || `STORY${storyIdx + 1}_CLIP`,
          type:    'source_clip',
          clipUrl: clip.clipUrl || clip.url || ''
        });
      } else {
        console.log(`[heygen-poller:${jobId}] No clip URL for story ${storyIdx + 1} — skipping source_clip insertion after ${avatarSeg.sceneName}`);
      }
    }
  }
}

// Count how many source_clips ended up in segmentData (not the same as orderedClipUrls.length anymore)
const actualClipCount = segmentData.filter(s => s.type === 'source_clip').length;
console.log(`[heygen-poller:${jobId}] Built segmentData: ${segmentData.length} segments (${sortedAvatarSegs.length} avatar + ${actualClipCount} source_clips)`);
```

**Key differences from current code:**

1. **Removed the `clipIdx` sequential counter.** Story index comes directly from the scene name regex.
2. **Skip insertion when clip URL is empty/null.** Current code has `clipIdx < orderedClipUrls.length` but that's length of the filtered array — now we use full-length array with null entries, so we check `clip && (clip.clipUrl || clip.url)` instead.
3. **Log the actual clip count from segmentData, not from orderedClipUrls.** More accurate accounting.

**Backward compat for Twitch:** the Twitch branch at `server.js:~6440` also builds orderedClipUrls. Its structure is different (streamers × clips per streamer). The Twitch heygen-poller path uses the same `clipIdx` counter. **DO NOT break Twitch.** Only change the News branch behavior.

**Hint: the scene name pattern `STORY\d+_SETUP` only matches News scene structure.** Twitch uses `CLIP\d+_SETUP` pattern. The new code's regex `/STORY(\d+)_SETUP/i` is News-specific and won't match Twitch scenes. Twitch scenes will fall through and NOT insert a clip via the new path — which would break Twitch.

**So the logic needs a branch:**

```javascript
if (/SETUP/i.test(avatarSeg.sceneName)) {
  const storyMatch = avatarSeg.sceneName.match(/STORY(\d+)_SETUP/i);

  if (storyMatch) {
    // News: look up by story index for alignment
    const storyIdx = parseInt(storyMatch[1], 10) - 1;
    const clip = orderedClipUrls[storyIdx];
    if (clip && (clip.clipUrl || clip.url)) {
      segmentData.push({
        // ... clip entry ...
      });
    } else {
      console.log(`[heygen-poller:${jobId}] No clip URL for story ${storyIdx + 1} — skipping`);
    }
  } else {
    // Twitch / NBA / other — use sequential clipIdx counter (existing behavior)
    if (clipIdx < orderedClipUrls.length) {
      const clip = orderedClipUrls[clipIdx];
      segmentData.push({
        // ... clip entry ...
      });
      clipIdx++;
    }
  }
}
```

**Keep `clipIdx` declared at the top of the loop** for the Twitch/NBA branch. News uses storyIdx instead.

#### Sub-fix 3c — Silence placeholder checks actual next-segment validity

**Change `server.js:4211-4237` to check that the NEXT segment in `localFiles` (not `segsToProcess`) is a source_clip that actually downloaded:**

```javascript
// Add 0.25s silence buffer after avatar segments before source clips
// Prevents Bobby G getting cut off mid-word when clip starts
// NEW: only insert silence if the NEXT DOWNLOADED segment is an actual source_clip,
// not just a planned-but-failed source_clip
const nextLocalFile = localFiles[i + 1];  // the next entry in the DOWNLOADED files list
const nextLocalSeg = nextLocalFile ? segsToProcess.find((s, si) => nextLocalFile.includes(`${asmId}_${si}_`)) : null;
const nextSegType = nextLocalSeg && nextLocalSeg.type === 'source_clip' ? 'source_clip' : 'avatar';
const currSegType = segTypes[tsFiles.length - 1] || 'avatar';

if (currSegType === 'avatar' && nextSegType === 'source_clip') {
  // Insert silence only if the next downloaded file is actually a source_clip
  const silencePath = tsPath.replace('.ts', '_silence.ts');
  // ... existing silence generation + push logic — unchanged ...
}
```

**Key difference:** old code checked `segsToProcess[i + 1].type` (the INTENT from the original plan). New code checks the next entry in `localFiles[]` (the ACTUAL downloaded files, post-SSRF-block filter). If a planned source_clip failed download, it's not in `localFiles`, so the check finds the NEXT AVATAR segment instead, and skips silence insertion.

**Result: no more phantom black-frame placeholders when clips fail to download.** The assembled MP4 has avatar → avatar transitions directly where clips were supposed to be, with no 0.25s gap.

**Caveat:** direct avatar-to-avatar concat at a failed-clip boundary may have a subtle visible hard cut because Bobby G's pose shifts between segments. That's a KNOWN acceptable tradeoff — better than a 0.25s black flash. Rob has said elsewhere he can live with hard cuts but not visible placeholders.

### Verification for Fix 3

- Grep checks:
  - `grep -n "storyIndex" server.js` → should show new field in orderedClipUrls build
  - `grep -n "STORY(\\\\d+)_SETUP" server.js` → should show new regex in heygen-poller
  - `grep -n "localFiles\\[i + 1\\]" server.js` → should show new silence insertion check
  - `grep -n "\\.filter(c => c.url)" server.js` → should return 0 hits in News orderedClipUrls block (the filter is removed)
- `node -c server.js` exit 0
- Nodemon clean restart
- **End-to-end test on News smoke test #7** (runs AFTER Fix 9b ships so clips actually download):
  - Log should show correct story-to-clip pairing: `STORY3_SETUP → STORY3_CLIP`, `STORY5_SETUP → STORY5_CLIP` — not cross-wired
  - Log should NOT show silence placeholder insertion for failed clips — only for successful ones
  - Filename should reflect ACTUAL clip count (`22_avatar_N_clips` where N = stories that both scraped AND downloaded)
  - Visual: no black flash "video jumps" at positions where clips failed to scrape
  - Visual: clips play in the correct story positions (STORY3's clip plays during STORY3's cycle, not STORY1's)

### Commit message

```
fix(news): clip story-index alignment + skip silence placeholder on failed downloads (Fix 3 of 3)

Smoke test #6 surfaced two interacting bugs that compound to produce
"video jumps" and wrong story-to-content pairing:

Bug A — Fix 9's .filter(c => c.url) at server.js:6886 dropped null-URL
entries from orderedClipUrls, compacting the array and destroying story
index alignment. When stories 3+4 scraped successfully but 1/2/5 failed,
the filtered length-2 array was then consumed sequentially by the heygen-
poller's clipIdx counter, which assigned STORY3's clip to STORY1_SETUP's
position and STORY4's clip to STORY2_SETUP's position. Wrong pairing.

Bug B — silence placeholder insertion at server.js:4211-4237 fired
whenever the NEXT PLANNED segment in segsToProcess was a source_clip,
even if that clip failed to download. Each failed-clip position got a
0.25-second black-frame + silent-audio placeholder appended to tsFiles,
which the viewer perceived as a "video jump" in the final MP4.

Fixes:

1. server.js:6879-6886 — News orderedClipUrls build no longer filters
   null-URL entries. Full-length array preserves story-index alignment.
   Added explicit storyIndex field for clarity. Log shows withUrls count.

2. server.js:220-261 — heygen-poller News branch looks up clips by story
   index derived from scene name regex (STORY\d+_SETUP → index), not
   sequential clipIdx counter. Skips insertion when clip URL is null.
   Twitch/NBA branch unchanged (still uses clipIdx).

3. server.js:4211-4237 — silence placeholder check now inspects
   localFiles[i+1] (actual downloaded files) instead of segsToProcess[i+1]
   (original plan). Failed downloads no longer trigger silence placeholders.
   Avatar-to-avatar concat at failed-clip boundaries has acceptable hard cut.

Does NOT fix:
- News smoke test #7 still needs Fix 9b (Brightcove whitelist + HLS FFmpeg)
  for clips to actually download in the first place. This handoff aligns
  them correctly once they DO download.

References: smoke test #6 nodemon log trace, gap audit Fix 3 of 3
```

---

## Dispatch order summary

**Total 3 commits from this handoff** (or 1-2 commits if Cline bundles trivially-related work).

**Suggested internal order:**

1. **Fix 3 first** — pure logic, no visual dependency. Ships immediately. Can be verified by grep + smoke test #7.
2. **Fix 1 second** — trivial CSS change. Can ship before or after Fix 3, no dependency either way.
3. **Fix 2 last** — biggest change, benefits from having Fix 1 + Fix 3 already in place so the visual verification frame is clean.

**Or bundle all 3 into one commit** if you prefer. Atomic staging works either way — the commit message above for Fix 3 is the largest; Fix 1 and Fix 2 commit messages are smaller.

---

## Rollback plan (per fix)

**Fix 1:** `git revert HEAD && git push` — zero risk, CSS-only change.

**Fix 2:** `git revert HEAD && git push` — restores the current sidebar + flag overlap state. Non-broken but visually cluttered.

**Fix 3:** `git revert HEAD && git push` — restores the alignment bug (wrong story-to-clip pairing) AND the silence placeholder insertion. Both bugs return. Safe to revert but not desirable.

---

## What this handoff does NOT solve

1. **Gate 3 LATE-sample OUTRO false positive (Gap #10)** — may auto-resolve after Gap #51 ships (stage direction leak fix). Separate Wave 0 cleanup item.

2. **Fix 9's Brightcove SSRF whitelist (Fix 9b)** — separate handoff `CLINE_HANDOFF_NEWS_FIX_9B_HLS_DOWNLOAD.md`. Must ship before Fix 3 can be verified end-to-end (no clips → nothing to align).

3. **Stage direction leak (Gap #51)** — separate handoff `CLINE_HANDOFF_GAP_51_STAGE_DIRECTION_LEAK.md`. Must ship before News smoke test #7 can pass Gate 3.

4. **NBA long-form voiceover rebuild** — separate handoff `CLINE_HANDOFF_NBA_VOICEOVER_FFMPEG_V2.md`. NBA-specific, unblocked by its own music tracks prerequisite.

5. **Wave 0 cleanup items (16 items)** — separate handoff `CLINE_HANDOFF_WAVE_0_CLEANUP.md`. Autonomous queue.

---

## Checklist for Cline

**Fix 1 — LIVE indicator position:**
- [ ] `tools/clipzworld_newscast.html` `.top-right` CSS rule updated with `margin-right: 80px`
- [ ] Grep check: `grep -n "margin-right.*80px" tools/clipzworld_newscast.html` shows hit
- [ ] Commit message per template above

**Fix 2 — Chrome state machine mutual exclusivity:**
- [ ] `.lower-third` verified at `top: 48, left: 0` (or adjusted if misaligned)
- [ ] `body.sidebar-hidden .story-list` CSS rule added
- [ ] `generateNewscastOverlay()` signature updated with `hideSidebar` option
- [ ] `page.evaluate()` toggles `body.sidebar-hidden` class
- [ ] STORY#_INTRO burn extended from 2-state to 3-state with 0.75s transition gap
- [ ] Non-INTRO avatar segment burn unchanged (single state, sidebar on, flag off)
- [ ] `node -c server.js` exit 0
- [ ] Commit message per template above

**Fix 3 — Clip alignment + silence placeholder:**
- [ ] `server.js:6886` `.filter(c => c.url)` removed from News orderedClipUrls build
- [ ] `storyIndex` field added to orderedClipUrls entries
- [ ] `server.js:220-261` heygen-poller News branch looks up by `STORY\d+_SETUP` regex
- [ ] Twitch/NBA sequential `clipIdx` counter path preserved
- [ ] `server.js:4211-4237` silence check uses `localFiles[i+1]` not `segsToProcess[i+1]`
- [ ] Grep: `grep -n "\.filter(c => c.url)" server.js` returns 0 hits in News build
- [ ] `node -c server.js` exit 0
- [ ] Commit message per template above

**After all 3 commits:**
- [ ] STATUS.md updated with Last Agent Action rows (one per commit)
- [ ] LONGFORM_FIX_ROTATION.md updated with Fix 1/2/3 entries in `✅ Shipped`
- [ ] Report commit hashes when pushed
- [ ] Await Rob's News smoke test #7 for visual verification (after Fix 9b + Gap #51 also ship)
