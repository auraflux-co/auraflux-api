# CLINE HANDOFF: Shared Newscast Chrome — Per-Show Skins

**Agent:** Cline-A
**Priority:** HIGH — blocks Twitch and NBA smoke tests from using correct chrome
**Status:** READY — root cause diagnosed, all injection points identified, no dependencies

---

## Decision Context

Rob directive (confirmed 2026-04-15): Remove TV cards from ALL content types. News newscast chrome (`clipzworld_newscast.html`) is the universal creative template. Only show branding (show name + accent colors) differs per content type:

| Content Type | Show Name | `--gold` | `--gold2` | `--red` |
|---|---|---|---|---|
| `news` | BECAUSE THE LIGHT WAS ON | `#C7AF4F` | `#f0d060` | `#C0392B` |
| `twitch` | TALK SOUP | `#6441A5` | `#7d5bbe` | `#6441A5` |
| `nba` | OTHER SIDE OF THE PILLOW | `#17408B` | `#1a4fa8` | `#C9082A` |

**News is the default** — already hardcoded in the HTML, no CSS override needed for News.

---

## What Needs to Change

### 1. `generateNewscastOverlay()` — add `contentType` parameter

**File:** `server.js`
**Function:** `generateNewscastOverlay(storyData, outputPath, storyIndex, options)` — line ~11697
**Current signature:**
```javascript
async function generateNewscastOverlay(storyData, outputPath, storyIndex = 0, options = {}) {
  const {
    showLowerThird = false,
    hideSidebar = false,
    episodeNumber = null,
    activeCategory = null
  } = options;
```

**Change:** Add `contentType = 'news'` to the destructured options:
```javascript
async function generateNewscastOverlay(storyData, outputPath, storyIndex = 0, options = {}) {
  const {
    showLowerThird = false,
    hideSidebar = false,
    episodeNumber = null,
    activeCategory = null,
    contentType = 'news'
  } = options;
```

### 2. `generateNewscastOverlay()` — inject CSS variables + show name in `page.evaluate()`

**File:** `server.js`
**Location:** Inside `generateNewscastOverlay()`, in the `page.evaluate(async (data, activeIndex, opts) => { ... })` block — line ~11719

Add this block **at the very top** of the `page.evaluate` callback body (before the lower-third toggle), so CSS variables are set before any element rendering:

```javascript
// ── Per-show CSS skin injection ─────────────────────────────
const skinMap = {
  twitch: { gold: '#6441A5', gold2: '#7d5bbe', red: '#6441A5', showName: 'TALK SOUP' },
  nba:    { gold: '#17408B', gold2: '#1a4fa8', red: '#C9082A', showName: 'OTHER SIDE OF THE PILLOW' }
};
const skin = skinMap[opts.contentType];
if (skin) {
  const root = document.documentElement;
  root.style.setProperty('--gold',  skin.gold);
  root.style.setProperty('--gold2', skin.gold2);
  root.style.setProperty('--red',   skin.red);
  const topBrand = document.querySelector('.top-brand');
  if (topBrand) topBrand.textContent = skin.showName;
}
// News: no override needed — defaults in :root CSS are already correct
```

**Also update the `page.evaluate` call signature** at the bottom of the evaluate block — `opts` object needs to include `contentType`:
```javascript
}, storyData, storyIndex, { showLowerThird, hideSidebar, episodeNumber, activeCategory, contentType });
```

### 3. All `generateNewscastOverlay()` call sites — pass `contentType`

**File:** `server.js`

There are 4 call sites inside the main assembly flow (~lines 4379–4466). All currently look like:
```javascript
await generateNewscastOverlay(overlayBase, overlayVisiblePath, activeStoryIndex, {
  showLowerThird: true, hideSidebar: true, episodeNumber, activeCategory
});
```

Each call site is inside a `contentType`-aware block. Add `contentType` to every call:
```javascript
await generateNewscastOverlay(overlayBase, overlayVisiblePath, activeStoryIndex, {
  showLowerThird: true, hideSidebar: true, episodeNumber, activeCategory, contentType
});
```

Do this for ALL 4 calls at lines ~4379, 4382, 4427, 4466.

**Also update the directive wrapper** at `server.js:11684`:
```javascript
await generateNewscastOverlay(storyData, outputPath, storyIndex, {
  // existing params...
  contentType: context.contentType || 'news'
});
```

---

## Part 2: Wire Newscast Chrome Into NBA Assembly

Currently NBA assembly calls `generateGameStoryCardPNG()` (TV card burn) and does NOT call `generateNewscastOverlay()`. This needs to change.

### What NBA scenes get the newscast overlay

Per the universal chrome decision:
- NBA uses the same newscast chrome as News
- The **sidebar** shows the list of **games** (instead of stories)
- The **flag** (`showLowerThird`) shows game/team info at `GAME#_INTRO` scenes
- Show name = "OTHER SIDE OF THE PILLOW", colors = blue/red skin

### Where in `server.js` NBA assembly currently burns its TV card

Search for: `generateGameStoryCardPNG` — used around line ~3968-4038 in the NBA assembly branch.

**Replace the NBA TV card burn block** with newscast overlay burns using the same pattern as News (lines 4373-4499), but adapted for NBA's `allStories` = game list from the script's storyList.

The `overlayBase` for NBA is the same: build it from `card.storyList` (array of `{ index, title, source }`) mapped to `{ title, category, storyId }` format expected by `generateNewscastOverlay()`.

**Specific changes:**
1. In the NBA `contentType === 'nba'` assembly branch, build `overlayBase` from `card.storyList`:
```javascript
const overlayBase = {
  allStories: (card.storyList || []).map(s => ({
    title:    s.title,
    category: 'NBA GAME',
    storyId:  `game_${s.index}`
  })),
  title: card.storyList?.[0]?.title || 'NBA Highlights',
  category: 'NBA GAME'
};
const episodeNumber = card.episodeNumber || 'Episode 1';
```

2. Apply the same scene-type detection logic as News:
   - `isGameIntro` = scene name matches `/GAME\d+_.*_INTRO/i`
   - `isGameOutro` = scene name matches `/OUTRO/i`
   - `activeGameIndex` = parsed from scene name or `card.currentStoryIndex`

3. Call `generateNewscastOverlay()` with `contentType: 'nba'` for every NBA avatar scene that needs chrome.

4. **Remove** or **skip** the `generateGameStoryCardPNG()` call in the NBA branch — the newscast chrome replaces it.

---

## Part 3: Wire Newscast Chrome Into Twitch Assembly

Same pattern as NBA.

### What Twitch scenes get the newscast overlay

- The **sidebar** shows the list of **streamers** (Twitch usernames → display names)
- The **flag** shows streamer name at `{STREAMER}_INTRO` scenes
- Show name = "TALK SOUP", colors = purple skin

### Where in `server.js` Twitch assembly burns its intro card

Search for: `generateIntroCardPNG` — called in the Twitch assembly branch (~line 500+ range, and in the assembly segment loop).

**Replace the Twitch intro card burn** with newscast overlay burns using `contentType: 'twitch'`.

Build `overlayBase` from the streamer roster:
```javascript
const overlayBase = {
  allStories: streamers.map((s, idx) => ({
    title:    getDisplayName(s.username),
    category: 'ON STREAM',
    storyId:  `streamer_${idx}`
  })),
  title: getDisplayName(currentStreamer),
  category: 'ON STREAM'
};
```

Flag (`showLowerThird: true`) = active at `{STREAMER}_INTRO` scenes, hidden otherwise.

---

## Part 4: Twitch White Trim — More Aggressive Crop

**File:** `server.js`
**Location:** Source clip vfFilter block — line ~4587-4593

Current zoom-to-fill filter:
```javascript
`scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080`
```

Some Twitch clips have white or black trim bars baked in (streamer OBS scene). The current fill-then-crop gets to 1920×1080 but doesn't eliminate embedded bars. Fix: crop a slightly smaller region from the fill output, then rescale back up:

```javascript
`scale=1920:1080:force_original_aspect_ratio=increase,crop=1880:1040,scale=1920:1080`
```

This crops 40px from width and 40px from height (20px each edge) before the final rescale, eliminating typical OBS border thickness without meaningful content loss.

---

## Priority Order

1. **Part 1** — CSS skin injection in `generateNewscastOverlay()` + pass `contentType` at all call sites. This is a self-contained change that makes News chrome already correct and prepares Twitch/NBA.
2. **Part 4** — Twitch white trim crop (1-line change in vfFilter).
3. **Parts 2 + 3** — NBA + Twitch chrome migration (larger change, removes TV card / intro card burns).

---

## Test After Fix

### Part 1 verify (CSS skins):
- Run a News assembly → top bar still shows "BECAUSE THE LIGHT WAS ON" in gold
- Run an NBA assembly → top bar shows "OTHER SIDE OF THE PILLOW" in `#17408B` blue
- Run a Twitch assembly → top bar shows "TALK SOUP" in `#6441A5` purple

### Part 4 verify (Twitch white trim):
- Source clip segments in Twitch assembly should have no white/black border bars visible

### Parts 2+3 verify (TV card removal):
- NBA assembly log should NOT show `[game-story-card]` output
- Twitch assembly log should NOT show `[intro-card]` output
- Both should show `[newscast-overlay]` output for each scene
