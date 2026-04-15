# CLINE_HANDOFF_NEWS_LONGFORM_FIXES_BATCH3_FIX7.md

**Author:** Claude Code (dispatched 2026-04-12 evening)
**For:** Cline (implementation)
**Scope:** News long-form newscast overlay — complete rewrite of `tools/clipzworld_newscast.html`, new per-segment two-state burn logic in `server.js`, News-specific logo position override in `lib/config.js`, critical Puppeteer `omitBackground` fix, FFmpeg filter change `blend` → `overlay`.
**Ship order:** Single commit covering all files. Atomic staging.
**Do NOT touch:** NBA, Twitch, short-form code paths. Cold-open INTRO scene handling may look unfamiliar — it is correct per the design, do not "fix" it.
**Before committing:** Re-read `COMMIT_CHECKLIST.md`. Atomic staging (`git add <files> && git commit -m "..." && git push` in a single chained command). STATUS.md update. LONGFORM_FIX_ROTATION.md update.

---

## Context — what's broken, why this fix exists, how I verified it

Every News long-form run from Apr 7 through today (smoke tests #1, #2, #3) has shipped with an invisible or broken newscast overlay. Root causes, in order of discovery:

1. **Fix 5 (commit `971429d`) fixed the HTTP 500 on `/newscast-overlay`** — the route path was stale after the `b31533f` folder reorganization. Puppeteer was screenshotting a 500 error page.
2. **Even after Fix 5, the overlay was still invisible in finals** — `clipzworld_newscast.html` had `body { background: transparent }` and Puppeteer's default `page.screenshot({ fullPage: false })` composites transparent bodies against a white canvas. Result: PNG with `pix_fmt=rgb24`, YAVG=213 (near-white grayscale), no usable alpha data.
3. **Even if the PNG had been correct, the FFmpeg filter was `blend=all_mode=normal:all_opacity=1`** — `blend` does not composite alpha correctly for RGBA input; `overlay` is the correct primitive for "composite this image on top of that video respecting alpha."
4. **The template itself did not match Rob's locked design.** Rob spent the evening iterating on a visual preview composite (Puppeteer + FFmpeg, not production code) and locked a specific layout that the existing HTML does not produce.

**Verification approach used:** live Puppeteer render of the edited preview template with `omitBackground: true`, then FFmpeg `overlay` composite onto a real Bobby G frame extracted from `output/news_sunday_april_12_2026_22_avatar_0_clips__1776033894626.mp4` at t=15s, then additional composite layer for the real `cwn_combined_ticker.html` captured the same way production does. Rob approved the final 4-layer composite at `/tmp/newscast_FINAL_with_ticker.jpg`. All dimensions, positions, and state transitions in this handoff are derived from that approved composite.

**Local preview artifacts on disk (not committed, just reference):**
- `/tmp/newscast_preview.html` — working edited template that Rob approved visually
- `/tmp/newscast_preview.png` — Puppeteer-rendered RGBA overlay (pix_fmt confirmed rgba)
- `/tmp/newscast_FINAL_with_ticker.jpg` — fully assembled 4-layer preview Rob signed off on
- `/tmp/bobbyg_frame.jpg` — base frame extracted from smoke test #3

Cline does not need to reproduce the preview workflow. All the final locked values are in this handoff.

---

## The design — locked state machine

### Persistent chrome (every News avatar segment, frame 0 to last word)

| Element | State |
|---|---|
| **Top bar** (top, 48px tall) | Always on. Text: `BECAUSE THE LIGHT WAS ON \| Episode {N} \| ● LIVE \| {date}` where `{N}` is the News episode number and `{date}` is today's date. |
| **Right sidebar story list** (420px wide, 5-10 items, each min-height 90px for uniform spacing) | Always on. Active story highlighted red ▶ ON AIR. Highlight moves to next story at each `STORY#_INTRO` boundary. Stays visible through cold open INTRO and OUTRO. |
| **Top-right segment-tag** (`.segment-tag`, navy box top-right) | Always on. `NOW COVERING` label stays constant. `seg-name` line updates to active story's category ("WORLD" / "SPORTS" / etc.) at each `STORY#_INTRO` boundary, same cadence as sidebar highlight. |
| **CWN logo** | Always on. News-specific position: `{x: 1725, y: 910, size: 90, opacity: 0.85}` — on the coffee mug in Bobby G's desk scene. Different from Twitch/NBA logo position. |
| **Combined ticker** (`tools/cwn_combined_ticker.html` at bottom, 72px tall) | Always on. Untouched by Fix 7 — already handled by existing `TICKER_MAP.news` wiring and `captureTicker('news')` at assembly layer. Do NOT touch this. |

### Timed element (TV card / lower-third)

| Element | State |
|---|---|
| **Lower-third TV card** (top-left, `top:48, left:0, width:720`) | **Hidden** during cold open INTRO scene. **Visible** for the first `CONFIG.INTRO_CARD.DURATION_SECONDS` seconds (currently 10) of each `STORY#_INTRO` segment, displaying that story's headline. **Hidden** for the remainder of the INTRO segment and all subsequent SETUP/SUMMARY/REACTION segments in the same story cycle. **Re-appears** at each next `STORY#_INTRO` boundary with the new story's headline. **Hidden** during OUTRO scene. |

### The two visual states

**State A — Cold open, SETUP/SUMMARY/REACTION, OUTRO, and post-timeout portion of each STORY#_INTRO:**
- Top bar visible
- Sidebar visible (active story highlighted)
- Segment-tag visible (current category)
- Logo visible on mug
- Combined ticker visible
- **TV card lower-third: HIDDEN**

**State B — First `DURATION_SECONDS` of each STORY#_INTRO:**
- All of State A **PLUS** TV card lower-third VISIBLE with current story's headline

The `STORY#_INTRO` segment uses both states with a timed transition at `t = DURATION_SECONDS`.

---

## Files to modify

1. `tools/clipzworld_newscast.html` — template rewrite
2. `server.js` — overlay generator signature, per-segment burn logic, two-state time-gated burn for INTRO segments, News-specific logo overlay, critical Puppeteer `omitBackground` fix
3. `lib/config.js` — new `LOGO_POS_NEWS` key
4. `STATUS.md` — Last Agent Action row
5. `LONGFORM_FIX_ROTATION.md` — move Fix 7 from Dispatched → Shipped

---

## Change 1 — `tools/clipzworld_newscast.html` (complete rewrite of several elements)

### A. Remove elements

Delete the following element/CSS blocks entirely:

- **`.breaking-flag`** CSS block AND the `<div class="breaking-flag">...</div>` HTML block — red breaking flag is being removed
- **`.nameplate`** CSS block AND any `<div class="nameplate">...</div>` HTML if present — unused, collides with `.lower-third`
- **`.news-ticker`** CSS block AND the `<div class="news-ticker">...</div>` HTML block — duplicated by the real `cwn_combined_ticker.html` at assembly layer
- **`.comedy-tag`** CSS block — leftover prototype, not used

### B. Move `.lower-third` from bottom-left to top-left and narrow it

In the `.lower-third` CSS:

```css
/* BEFORE */
.lower-third {
  position: absolute;
  bottom: 80px;
  left: 0;
  width: 860px;
  /* ... */
  transform: translateX(-100%);
  animation: slideInLeft 0.5s cubic-bezier(0.22,1,0.36,1) 0.3s forwards;
}
```

```css
/* AFTER */
.lower-third {
  position: absolute;
  top: 48px;        /* sits directly below the 48px top bar */
  left: 0;
  width: 720px;     /* narrowed from 860px to pull back from Bobby G's face */
  /* ... */
  /* REMOVE the transform + animation — lower-third visibility is controlled by the .visible class */
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

**Why `.visible` class:** The Node overlay generator will add/remove this class via `page.evaluate()` to toggle the TV card on/off per segment. Default state is hidden so cold open INTRO (which doesn't add the class) renders without the TV card.

### C. Remove the `.lt-sub` element from the lower-third HTML

Per Rob: no date line on the TV card.

```html
<!-- BEFORE -->
<div class="lt-bottom">
  <div class="lt-headline">Global Markets React to Federal Reserve Rate Decision</div>
  <div class="lt-sub">MARCH 30, 2026</div>
</div>

<!-- AFTER -->
<div class="lt-bottom">
  <div class="lt-headline">Global Markets React to Federal Reserve Rate Decision</div>
</div>
```

Also remove the `.lt-sub` CSS rule.

### D. Simplify the `.lt-top` gold strip HTML

Remove the `BREAKING` second category and the `.lt-dot` separator. Gold strip now shows only the active story's category (will be dynamically updated at runtime).

```html
<!-- BEFORE -->
<div class="lt-top">
  <div class="lt-category">WORLD NEWS</div>
  <div class="lt-dot"></div>
  <div class="lt-category">BREAKING</div>
</div>

<!-- AFTER -->
<div class="lt-top">
  <div class="lt-category">WORLD NEWS</div>
</div>
```

Remove the `.lt-dot` CSS rule too.

### E. Widen `.story-list` from 360px → 420px

```css
.story-list {
  position: absolute;
  top: 120px;
  right: 32px;
  width: 420px;    /* was 360px — per QA checklist in qa/record_session.js:215 */
  /* ... */
}
```

### F. Add uniform `min-height` + flex-centering to `.story-item`

So story items have visually-equal spacing regardless of text length.

```css
.story-item {
  background: rgba(13,20,36,0.92);
  border-left: 4px solid var(--gold);
  border-radius: 0 4px 4px 0;
  padding: 14px 16px;
  backdrop-filter: blur(8px);
  min-height: 90px;            /* NEW */
  display: flex;               /* NEW */
  flex-direction: column;      /* NEW */
  justify-content: center;     /* NEW */
}
```

### G. Rename top bar brand + remove duplicate episode element

```html
<!-- BEFORE -->
<div class="top-bar">
  <div class="top-brand">ClipzWorld News</div>
  <div class="top-divider"></div>
  <div class="top-show" id="show-info">EPISODE 1</div>
  <div class="top-right">...</div>
</div>

<!-- AFTER -->
<div class="top-bar">
  <div class="top-brand">BECAUSE THE LIGHT WAS ON</div>
  <div class="top-divider"></div>
  <div class="top-show" id="show-info">Episode 1</div>
  <div class="top-right">...</div>
</div>
```

Note: the episode number (`Episode 1` in the default markup) is overwritten at runtime via `page.evaluate()` from the overlay generator, using the current News episode from `data/episode_counters.json`.

### H. Add a permanent design-intent comment at the top of `tools/clipzworld_newscast.html`

Immediately after `<!DOCTYPE html>` and before `<html>`, add this HTML comment block. Do not edit the content — this is a historical record that must survive future refactors:

```html
<!--
  ═══════════════════════════════════════════════════════════════════════════════
  CWN NEWSCAST OVERLAY — LONG-FORM BROADCAST CHROME
  ═══════════════════════════════════════════════════════════════════════════════

  Purpose:
    Full-screen broadcast-graphics chrome that burns onto every News long-form
    avatar segment (INTRO cold open, STORY#_INTRO, STORY#_SETUP, STORY#_SUMMARY,
    STORY#_REACTION, OUTRO). Consumed by server.js generateNewscastOverlay() via
    Puppeteer + omitBackground:true → real RGBA PNG → FFmpeg `overlay` filter.

  Always-on elements (frame 0 → last word):
    - Top bar: show name + Episode N + LIVE + date
    - Right sidebar story list (420px, min 90px per item, red ▶ ON AIR highlight)
    - Top-right segment-tag (NOW COVERING / category)
    - CWN logo at LOGO_POS_NEWS = {x:1725, y:910, size:90, opacity:0.85}
      (on Bobby G's coffee mug — News-specific override, not the shared LOGO_POS)
    - Combined ticker at y=H-72 (baked at assembly layer via cwn_combined_ticker.html)

  Timed element (TV card / lower-third):
    - Hidden during cold open INTRO
    - Visible for first CONFIG.INTRO_CARD.DURATION_SECONDS at each STORY#_INTRO
    - Hidden for remainder of each STORY# cycle after timeout
    - Hidden during OUTRO

  State transitions per STORY# boundary:
    - Sidebar highlight moves to next story
    - TV card headline swaps to next story
    - Segment-tag seg-name swaps to next story's category

  ─────────────────────────────────────────────────────────────────────────────
  FUTURE WORK — REBRAND TO TWITCH + NBA (post-test-case-completion)
  ─────────────────────────────────────────────────────────────────────────────

  Rob directive 2026-04-12 evening (after approving the Fix 7 preview composite):
    "post test cases I want to rebrand this look for the other shows"

  Meaning: after Twitch, NBA, and News long-form all pass their test cases, port
  this same broadcast-graphics chrome design to Twitch and NBA long-form so all
  three shows share the visual language. Key elements to replicate:

    - Top bar with show name + Episode N + LIVE + date
    - Right sidebar list of streamers (Twitch) / games (NBA) with ▶ ON AIR highlight
    - Top-right segment-tag updating per active item
    - TV card lower-third time-gated at each item's INTRO scene
    - Logo on the coffee mug (LOGO_POS_NEWS coordinates, same mug across all shows)
    - Same state machine: sidebar always-on, TV card timed

  Currently Twitch uses a small top-right TV card at OVERLAY_ZONE =
  {x:1360, y:60, w:520, h:293} and NBA uses the same zone with a different
  Canvas-generated PNG. The rebrand replaces both with the full-chrome design.

  Tracked in:
    - ROADMAP.md → Bucket 4 Enterprise → Could-Have →
      "Rebrand Twitch and NBA long-form to match the News newscast chrome design"
    - LONGFORM_FIX_ROTATION.md rotation log entry dated 2026-04-12 evening

  DO NOT start this work until News + Twitch + NBA long-form all pass test cases.
  This comment exists so the decision is not lost if ROADMAP.md is archived or
  rewritten between now and when the rebrand becomes active work.
  ═══════════════════════════════════════════════════════════════════════════════
-->
```

This comment is **non-negotiable** — it must be added verbatim to the top of the rewritten template. Rob specifically asked for the decision to be captured inline in the code so it survives doc churn.

### I. Keep existing elements unchanged

- `.top-bar` structure (gradient, LIVE indicator, date display) — unchanged
- `.segment-tag` element — unchanged markup; the `.seg-name` inner text gets updated at runtime per active story's category
- `.story-list` inner story items — rendered dynamically at runtime, same as today's production code
- `@keyframes slideInLeft`, `@keyframes fadeIn`, `@keyframes bpulse` animations — unchanged
- CSS variables (`--navy`, `--gold`, `--red`, `--dark`, `--white`) — unchanged
- `body { background: transparent }` — STAYS. Do not add a background color. The real fix is `omitBackground: true` in Puppeteer (Change 2).
- `<script>` block at the bottom with `updateDate()`, `setActiveStory()`, `postMessage` listener — unchanged. The overlay generator will call `setActiveStory()` via `page.evaluate()` the same way it already does.

---

## Change 2 — `server.js` `generateNewscastOverlay()` function (around line 10328)

### Critical fix: add `omitBackground: true` to the screenshot call

This is the single most important code change. Without it, the overlay PNG renders as near-white RGB instead of RGBA with real alpha transparency, and the entire Fix 7 doesn't work.

```javascript
// BEFORE
await page.screenshot({ path: outputPath, fullPage: false });

// AFTER
await page.screenshot({ path: outputPath, fullPage: false, omitBackground: true });
```

### Expand the function signature to accept new state params

```javascript
// BEFORE
async function generateNewscastOverlay(storyData, outputPath, storyIndex = 0) {

// AFTER
async function generateNewscastOverlay(storyData, outputPath, storyIndex = 0, options = {}) {
  const {
    showLowerThird = false,   // whether the TV card is visible for this segment
    episodeNumber = 1,        // News episode number to inject into top bar
    activeCategory = 'WORLD NEWS'  // category text for segment-tag and gold strip
  } = options;
```

### Inside `page.evaluate()`, use the new params

Add code to toggle the `.lower-third.visible` class, inject episode number into `.top-show`, inject the segment-tag seg-name, inject the gold strip category:

```javascript
await page.evaluate((data, activeIndex, showLowerThird, episodeNumber, activeCategory) => {
  // ── existing: update lower-third headline/category/date text ──
  const ltHeadline = document.querySelector('.lt-headline');
  if (ltHeadline) ltHeadline.textContent = data.title || 'Breaking News';

  // ── NEW: update the single .lt-category in the gold strip ──
  const ltCategoryEls = document.querySelectorAll('.lt-category');
  if (ltCategoryEls.length > 0) ltCategoryEls[0].textContent = activeCategory.toUpperCase();

  // ── NEW: toggle lower-third visibility ──
  const lowerThird = document.querySelector('.lower-third');
  if (lowerThird) {
    if (showLowerThird) lowerThird.classList.add('visible');
    else lowerThird.classList.remove('visible');
  }

  // ── NEW: update top bar episode text ──
  const showInfo = document.getElementById('show-info');
  if (showInfo) showInfo.textContent = `Episode ${episodeNumber}`;

  // ── NEW: update segment-tag seg-name with active category ──
  const segName = document.querySelector('.seg-name');
  if (segName) segName.textContent = activeCategory.toUpperCase();

  // ── existing: update story list ──
  if (data.allStories && data.allStories.length > 0) {
    const storyList = document.querySelector('.story-list');
    if (storyList) {
      storyList.innerHTML = '';
      data.allStories.forEach((story, idx) => {
        const storyItem = document.createElement('div');
        storyItem.className = 'story-item' + (idx === activeIndex ? ' active' : '');
        storyItem.innerHTML = `
          <div class="story-item-cat">${idx === activeIndex ? '▶ ON AIR' : (story.category || 'WORLD').toUpperCase()}</div>
          <div class="story-item-text">${story.title || story.text || ''}</div>
        `;
        storyList.appendChild(storyItem);
      });
    }
  }

  // ── REMOVED: breaking-text banner update — .breaking-text element no longer exists ──
}, storyData, storyIndex, showLowerThird, episodeNumber, activeCategory);
```

---

## Change 3 — `server.js` per-segment burn logic (around line 3824, the `isIntro && contentType === 'news'` branch)

### Expand condition from `isIntro` to `segType === 'avatar'`

Every News avatar segment needs the newscast chrome burned, not just INTRO segments.

```javascript
// BEFORE
} else if (isIntro && contentType === 'news') {
  // News newscast overlay burn — INTRO segments only
  ...
}

// AFTER
} else if (contentType === 'news' && segType === 'avatar') {
  // News newscast chrome burn — every avatar segment (INTRO, STORY#_*, OUTRO)
  ...
}
```

### Derive per-segment state from scene name regex

Inside the new branch, before generating the overlay PNG:

```javascript
const label = (segsToProcess.find((s, si) => localFiles[i].includes(`${asmId}_${si}_`))?.label || '').toUpperCase();

// Determine which story is active for this segment
let activeStoryIndex = 0;
let currentStoryMeta = null;
const storyMatch = label.match(/STORY(\d+)/);
if (storyMatch) {
  activeStoryIndex = parseInt(storyMatch[1]) - 1;
  currentStoryMeta = (card?.newsItems || [])[activeStoryIndex] || null;
} else if (label === 'INTRO' || /COLD/i.test(label)) {
  // Cold open — story 1 pre-highlighted per Rob's directive
  activeStoryIndex = 0;
  currentStoryMeta = (card?.newsItems || [])[0] || null;
} else if (label === 'OUTRO') {
  // Outro — last story stays highlighted
  activeStoryIndex = (card?.newsItems || []).length - 1;
  currentStoryMeta = (card?.newsItems || [])[activeStoryIndex] || null;
}

// Determine if this is an INTRO segment that needs the two-state time-gated burn
const isStoryIntro = /^STORY\d+_INTRO$/.test(label);
```

### Generate overlay PNGs per state

For most segments (non-INTRO), generate one PNG with the TV card hidden:

```javascript
const newsItems = card?.newsItems || [];
const allStories = newsItems.map((item, idx) => ({
  title: item.title || `Story ${idx + 1}`,
  category: item.category || 'WORLD',
  storyId: `story_${idx + 1}`
}));

const activeCategory = currentStoryMeta?.category || 'WORLD';
const activeTitle = currentStoryMeta?.title || 'News Story';
const episodeNumber = getNewsEpisodeNumber(); // helper reading data/episode_counters.json

if (isStoryIntro) {
  // Two-state burn for INTRO segments — TV card visible for first DURATION_SECONDS,
  // then hidden for the remainder of the segment.
  const overlayVisible = path.join(TMP_DIR, `newscast_overlay_visible_${Date.now()}.png`);
  const overlayHidden = path.join(TMP_DIR, `newscast_overlay_hidden_${Date.now()}.png`);

  await generateNewscastOverlay(
    { title: activeTitle, category: activeCategory, allStories, date: todayDateStr },
    overlayVisible,
    activeStoryIndex,
    { showLowerThird: true, episodeNumber, activeCategory }
  );
  await generateNewscastOverlay(
    { title: activeTitle, category: activeCategory, allStories, date: todayDateStr },
    overlayHidden,
    activeStoryIndex,
    { showLowerThird: false, episodeNumber, activeCategory }
  );

  const burnedPath = inputForTS.replace('.mp4', '_newscast_burned.mp4');
  const introDur = CONFIG.INTRO_CARD.DURATION_SECONDS;

  // Two-pass overlay: PNG A (lower-third visible) for t=0..introDur,
  // then PNG B (lower-third hidden) for t>introDur
  const burnArgs = [
    '-i', inputForTS,
    '-i', overlayVisible,
    '-i', overlayHidden,
    '-filter_complex',
    `[0:v][1:v]overlay=0:0:enable='lte(t,${introDur})'[mid];[mid][2:v]overlay=0:0:enable='gt(t,${introDur})'[out]`,
    '-map', '[out]', '-map', '0:a',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', '44100', '-y', burnedPath
  ];

  // ... existing exec pattern ...

  // Cleanup temp PNGs
  try { fs.unlinkSync(overlayVisible); fs.unlinkSync(overlayHidden); } catch(e) {}

} else {
  // Single-state burn — TV card always hidden for non-INTRO segments
  const overlayHidden = path.join(TMP_DIR, `newscast_overlay_${Date.now()}.png`);

  await generateNewscastOverlay(
    { title: activeTitle, category: activeCategory, allStories, date: todayDateStr },
    overlayHidden,
    activeStoryIndex,
    { showLowerThird: false, episodeNumber, activeCategory }
  );

  const burnedPath = inputForTS.replace('.mp4', '_newscast_burned.mp4');
  const burnArgs = [
    '-i', inputForTS,
    '-i', overlayHidden,
    '-filter_complex',
    `[0:v][1:v]overlay=0:0[out]`,
    '-map', '[out]', '-map', '0:a',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', '44100', '-y', burnedPath
  ];

  // ... existing exec pattern ...

  // Cleanup temp PNG
  try { fs.unlinkSync(overlayHidden); } catch(e) {}
}

if (fs.existsSync(burnedPath) && fs.statSync(burnedPath).size > 10000) {
  inputForTS = burnedPath;
  log(asmId, `  📰 NEWS newscast burned: ${label} (story ${activeStoryIndex + 1}, lowerThird=${isStoryIntro ? 'timed' : 'hidden'})`);
}
```

**CRITICAL:** Replace the existing `blend=all_mode=normal:all_opacity=1` filter with `overlay=0:0`. The old `blend` filter is the reason the overlay is invisible in current production — `blend` doesn't composite alpha correctly; `overlay` does.

### Helper to read current News episode number

Near the other `data/*.json` helpers at the top of server.js:

```javascript
function getNewsEpisodeNumber() {
  try {
    const p = path.join(__dirname, 'data', 'episode_counters.json');
    if (!fs.existsSync(p)) return 1;
    const counters = JSON.parse(fs.readFileSync(p, 'utf8'));
    return counters.news || counters.news_long || 1;
  } catch (e) {
    console.warn('[news-episode] Failed to read episode_counters.json:', e.message);
    return 1;
  }
}
```

If the existing code already has a News episode counter helper, use that — don't duplicate.

---

## Change 4 — `lib/config.js` — News-specific logo override

Add a new key to `CONFIG.VISUAL_LAYOUTS.LONG_FORM`:

```javascript
// lib/config.js — LONG_FORM section
LONG_FORM: {
  OVERLAY_ZONE: { x: 1360, y: 60, w: 520, h: 293 },  // unchanged, Twitch/NBA TV card
  LOGO_POS: { x: 80, y: 10, size: 100 },              // unchanged, Twitch/NBA logo top-left
  LOGO_POS_NEWS: { x: 1725, y: 910, size: 90, opacity: 0.85 },  // NEW — News-specific on-mug logo
  // ... other keys unchanged
}
```

Then in `server.js` wherever the logo burn happens (currently around line 4312), branch on contentType:

```javascript
// BEFORE
const logoPos = CONFIG.VISUAL_LAYOUTS.LONG_FORM.LOGO_POS;

// AFTER
const logoPos = (contentType === 'news')
  ? CONFIG.VISUAL_LAYOUTS.LONG_FORM.LOGO_POS_NEWS
  : CONFIG.VISUAL_LAYOUTS.LONG_FORM.LOGO_POS;
```

The existing logo overlay FFmpeg filter already uses `logoPos.x` / `logoPos.y` / `logoPos.size` — no other changes needed. The new `opacity: 0.85` value in the config matches the existing hardcoded `aa=0.85` in the filter, so it's a config-driven representation of current behavior.

---

## Verification (must run before commit)

After saving all files, nodemon auto-restarts. Then:

### 1. Route still serves correctly

```bash
curl -s -o /tmp/newscast_check.html -w "HTTP:%{http_code} SIZE:%{size_download}\n" http://localhost:3000/newscast-overlay
```

Expected: `HTTP:200 SIZE:~10000-15000` (the new template is smaller than the old one because dead elements were removed).

### 2. Puppeteer generates a real RGBA PNG (not RGB)

Write a one-line node check:

```bash
node -e "
const puppeteer = require('puppeteer');
(async () => {
  const b = await puppeteer.launch({ headless: true });
  const p = await b.newPage();
  await p.setViewport({ width: 1920, height: 1080 });
  await p.goto('http://localhost:3000/newscast-overlay', { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 1500));
  await p.screenshot({ path: '/tmp/verify.png', omitBackground: true });
  await b.close();
})();
" && ffprobe -v error -show_entries stream=pix_fmt /tmp/verify.png
```

Expected: `pix_fmt=rgba`. If it returns `rgb24`, the `body { background }` or Puppeteer call is wrong.

### 3. Grep checks

```bash
# No stale breaking-flag, news-ticker, or blend filter references in modified files
grep -n "breaking-flag\|news-ticker\|blend=all_mode" tools/clipzworld_newscast.html
# Expected: 0 hits

grep -n "blend=all_mode=normal" server.js
# Expected: 0 hits in the News overlay burn section (may still exist in other content types — those stay untouched)

grep -n "omitBackground" server.js
# Expected: 1+ hits in generateNewscastOverlay()

grep -n "LOGO_POS_NEWS" lib/config.js server.js
# Expected: 1 hit in lib/config.js (definition), 1+ hits in server.js (usage)
```

### 4. Nodemon clean boot

Watch the nodemon output after save. Expected: no syntax errors, no "Cannot find module" errors, server boots on port 3000 within ~2 seconds.

---

## Commit strategy

**Single commit.** All files staged atomically.

```
fix(news): complete newscast overlay rewrite — alpha PNG + state machine + logo on mug (Fix 7)

Rewrites tools/clipzworld_newscast.html to match Rob's approved design (verified via
local Puppeteer+FFmpeg preview composite). Fixes two critical rendering bugs that
made the overlay invisible in every News long-form run from Apr 7 through today's
smoke test #3:

1. Puppeteer page.screenshot() was not using omitBackground:true, so body{background:
   transparent} composited as white, producing rgb24 PNGs with YAVG~213 (near-white).
   Fix: omitBackground:true produces rgba PNGs with real alpha.

2. FFmpeg was using blend=all_mode=normal:all_opacity=1 which does not composite
   alpha correctly for RGBA input. Fix: overlay=0:0 filter (same primitive Twitch/NBA
   use) respects alpha natively.

Template changes:
- Remove .breaking-flag, .nameplate, .news-ticker (dup), .comedy-tag elements
- Move .lower-third from bottom-left(860px) to top-left(720px, top:48)
- Hide .lower-third by default; show via .lower-third.visible class toggle
- Remove .lt-sub (date line) per Rob's "no story date" directive
- Simplify .lt-top gold strip to single .lt-category (was WORLD NEWS ● BREAKING)
- Widen .story-list from 360px → 420px (QA checklist qa/record_session.js:215)
- Add min-height:90px + flex-center to .story-item for uniform spacing
- Rename .top-brand "ClipzWorld News" → "BECAUSE THE LIGHT WAS ON"
- Rename .top-show "EPISODE 1" → "Episode N" (dynamic via episode_counters.json)

Assembly changes (server.js):
- Expand News overlay burn from `isIntro` → `segType === 'avatar'` — chrome burns on
  every News avatar segment (INTRO, STORY#_*, OUTRO)
- Add two-state time-gated burn for STORY#_INTRO segments: lower-third visible for
  first CONFIG.INTRO_CARD.DURATION_SECONDS, hidden for remainder
- Add generateNewscastOverlay() options param: showLowerThird, episodeNumber,
  activeCategory — overlay generator now accepts state per segment
- Add getNewsEpisodeNumber() helper reading data/episode_counters.json
- Branch logo overlay position on contentType: News uses LOGO_POS_NEWS (on mug),
  Twitch/NBA unchanged at LOGO_POS (top-left)

Config changes (lib/config.js):
- Add CONFIG.VISUAL_LAYOUTS.LONG_FORM.LOGO_POS_NEWS = {x:1725, y:910, size:90, opacity:0.85}

Verification: local 4-layer composite at /tmp/newscast_FINAL_with_ticker.jpg (Bobby G
frame + newscast chrome PNG + CWN logo + real combined ticker) approved by Rob.

Does NOT fix: News source clips still missing (batch 4 scope — News has no videoUrl
in ingestion). SUMMARY scenes will still describe clips the viewer doesn't see until
batch 4 wires up a video source.

References: LONGFORM_FIX_ROTATION.md News batch 3, qa/record_session.js:214-220 QA checklist
```

Then per `COMMIT_CHECKLIST.md`:

1. **Atomic staging:**
   ```bash
   git add tools/clipzworld_newscast.html server.js lib/config.js STATUS.md LONGFORM_FIX_ROTATION.md && git commit -m "..." && git push
   ```
   **Do NOT** split `git add` and `git commit` into separate tool calls.

2. **Update STATUS.md** 🤖 Last Agent Action table with this task + commit hash + timestamp.

3. **Update LONGFORM_FIX_ROTATION.md** — move Fix 7 from `📤 Dispatched to Cline` → `✅ Shipped` with commit hash. Add rotation log entry.

4. **Do not update other docs.** No CLAUDE.md, no POST_PUBLISH_TASKS.md, no ROADMAP.md (Claude Code will handle the rebrand note separately).

---

## Testing checklist (Cline runs BEFORE committing)

- [ ] `git diff tools/clipzworld_newscast.html` shows removed elements + moved lower-third + widened story list + renamed top-brand
- [ ] `git diff server.js` shows omitBackground:true, expanded condition, two-state INTRO burn, options param, getNewsEpisodeNumber helper, logo contentType branch
- [ ] `git diff lib/config.js` shows LOGO_POS_NEWS addition
- [ ] Grep checks from "Verification" section above all pass
- [ ] `node -c server.js` returns exit 0
- [ ] Nodemon restart is clean (no errors in boot output)
- [ ] Route returns HTTP 200 and Puppeteer produces rgba PNG (not rgb24)

Rob will then run News long-form smoke test #4 from the dashboard to verify visually.

---

## Rollback plan

If Fix 7 causes any regression on Twitch or NBA (shouldn't — all changes are News-specific or are defensive fixes to the News branch):

```bash
git revert HEAD && git push
```

News-specific code paths are walled off behind `contentType === 'news'` checks. Twitch uses `generateIntroCardPNG()` + OVERLAY_ZONE logic in its own branch. NBA uses `generateGameStoryCardPNG()` in its own branch. Neither is touched by Fix 7.

If Fix 7 causes News to fail in a new way (overlay invisible, overlay too big, overlay in wrong position), revert and we'll diagnose together — do NOT try to patch in-place without a revert first, because further breakage on top of breakage makes the rollback harder.

---

## What this fix does NOT solve

1. **News still has no source video clips.** `orderedClipUrls` is still filtered to empty because News ingestion doesn't populate `videoUrl`. The `[CLIP PLAYS HERE]` markers in the script are ignored by the heygen-poller. Scheduled for batch 4.
2. **SUMMARY scenes describe invisible clips.** Gemini writes "the footage shows X" for a clip that never plays. Batch 4 artifact, not a Fix 7 bug. Do not attempt to suppress SUMMARY scenes — fix the clip source, not the symptom.
3. **Gate 3 LATE-sample outro false positive.** Gemini's 20s sample window ends mid-sentence, gets flagged as "outro cut off" and deducts 20 points. Rob confirmed via YouTube review that the outro actually plays cleanly. Cross-cutting scoring bug, not a Fix 7 concern.
4. **White strips at top of frame (Twitch top/bottom, News top).** Tracked in POST_PUBLISH_TASKS §1.1. Cross-cutting fix that comes after long-form test cases pass.
5. **Rebrand to Twitch/NBA.** Rob's directive after this run: "post test cases I want to rebrand this look for the other shows." Parked in ROADMAP.md as a Could-Have — not in scope for Fix 7.

---

## Why this works (teaching section)

**The central insight that made this fixable:** separating the "template renders a PNG" problem from the "FFmpeg composites the PNG over Bobby G" problem. For weeks, the News overlay was broken because both problems existed simultaneously and each one masked the other.

- The template rendered near-white because of `body { background: transparent }` + Puppeteer default white canvas → the PNG had no usable alpha data
- FFmpeg used `blend` filter which doesn't respect alpha → even a correctly-rendered RGBA PNG would have composited wrong

Fixing either one alone produces no visible improvement. The screenshot is still white-washed, or the filter still doesn't respect alpha. Both had to be fixed in the same commit.

**The lesson for Cline and future agents:** when a visual system has multiple layered bugs, each layer can mask the others. The way to find all the bugs at once is to run the pipeline end-to-end with instrumentation at every boundary — not just at the failing output. In this case, the missing instrumentation was "inspect the intermediate overlay PNG" — something we never did until Rob got frustrated enough to demand a local preview workflow. The moment we looked at the intermediate PNG and saw it was rgb24 instead of rgba, the whole bug chain collapsed into a concrete diagnosis.

**Future prevention:** any time Fix 7's approach ("burn a PNG over a video via FFmpeg overlay") is used, the Cline handoff should include an explicit verification step that inspects the intermediate PNG for correct `pix_fmt` and non-trivial content (YAVG not near 0 or 255, SATAVG > 10 if color is expected). That's the cheapest way to catch this class of bug before it reaches a smoke test.

---

## After shipping — Rob's next action

Smoke test #4 (News long-form). Expected behavior:
- Newscast overlay VISIBLE in the assembled MP4 for the first time since Apr 7
- Top-left TV card appears for 10s at each STORY#_INTRO, then hides
- Right sidebar story list visible entire video, red highlight moves through stories
- Logo on Bobby G's coffee mug (bottom-right area)
- Combined ticker unchanged at bottom
- Top bar reads "BECAUSE THE LIGHT WAS ON | Episode N | ● LIVE | date"
- Outro: story 10 still highlighted, TV card hidden, everything else visible

What will still be broken (expected): no source clips playing. Script still says "the footage shows X" for clips that don't exist. That's batch 4 work, not a Fix 7 regression.

If Fix 7 works visually — Rob moves to scoping batch 4 (News video source wiring) or to NBA long-form smoke testing, whichever he prioritizes.
