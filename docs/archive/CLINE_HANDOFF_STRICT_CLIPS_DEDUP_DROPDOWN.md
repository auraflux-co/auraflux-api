# CLINE HANDOFF — Strict clip quota + clip dedup + dropdown persistence

**Priority:** P0 — three related dashboard fixes that together give Rob a reliable repeatable run. Ship as ONE commit since all three changes touch `cwn_production.html` and share the same data flow in `generateTwitch()`.
**Scope:** `cwn_production.html` only — zero server changes
**Est. Cline time:** ~35 minutes including verification
**Depends on:** Nothing

---

## Background — the product rule and why these three fixes go together

Rob's product decision tonight (2026-04-11): **a streamer must provide the full requested clip quota to make the episode.** 1-clip streamers get dropped entirely — 1 clip per streamer is a short-form pattern, not a compilation pattern. The compilation format is "N streamers × M clips each = 1 episode of length N×M×~30 seconds." Partial streamers break the format and create awkward asymmetric scripts.

Second product rule: **never ship the same clip twice.** Rob will run this every 1-2 days, and Twitch's 7-day fetch window will legitimately return the same clips across consecutive runs for low-activity streamers. Client-side dedup tracks clip IDs that have been used in previous episodes and filters them out before the quota check.

Third item, small but related: the `CLIPS PER STREAMER` dropdown defaults to `2` on every hard refresh. Rob has no localStorage persistence for it. If Rob picks 1 for a small test, hard-refreshes, forgets, clicks GENERATE — he gets the wrong run. Ties in here because it's the same function scope as the quota filter.

**All three fixes live in or adjacent to `generateTwitch()` at `cwn_production.html:3076-3199`**, so one commit covers them cleanly.

---

## What to change — Part 1: Dropdown persistence (small, do this first)

### 1a. Save dropdown value on change

**File:** `cwn_production.html`
**Location:** line 261-267 (the `<select id="twitch-clips-per-main">` element)

### Before
```html
<select id="twitch-clips-per-main" style="...">
  <option value="1">1 clip</option>
  <option value="2" selected>2 clips</option>
  <option value="3">3 clips</option>
  <option value="4">4 clips</option>
  <option value="5">5 clips</option>
</select>
```

### After
```html
<select id="twitch-clips-per-main" onchange="saveClipsPerStreamer()" style="...">
  <option value="1">1 clip</option>
  <option value="2" selected>2 clips</option>
  <option value="3">3 clips</option>
  <option value="4">4 clips</option>
  <option value="5">5 clips</option>
</select>
```

Only the `onchange="saveClipsPerStreamer()"` attribute is added. The `selected` attribute on `<option value="2">` stays as a fallback for brand-new sessions with no localStorage value.

### 1b. Add saveClipsPerStreamer() + loadClipsPerStreamer()

**File:** `cwn_production.html`
**Location:** find `function saveStreamerList()` (it's around line 5423 per the earlier grep). Add the two new functions right next to it so related persistence helpers sit together.

```js
function saveClipsPerStreamer() {
  try {
    var sel = g('twitch-clips-per-main');
    if (sel && sel.value) localStorage.setItem('cwn_clips_per_streamer', sel.value);
  } catch(e) {}
}

function loadClipsPerStreamer() {
  try {
    var saved = localStorage.getItem('cwn_clips_per_streamer');
    var sel = g('twitch-clips-per-main');
    if (saved && sel) sel.value = saved;
  } catch(e) {}
}
```

### 1c. Call loadClipsPerStreamer() on page load

Find where `loadStreamerList()` is called at page init (grep for `loadStreamerList()` with parens — it's called from the page init code near the bottom of the file, wherever other load* helpers are invoked). Add `loadClipsPerStreamer();` on the next line.

Example location pattern to look for:
```js
loadStreamerList();
loadClipsPerStreamer();   // ← NEW
```

**Test by hand after ship:** change dropdown to `1`, hard-refresh the page, dropdown should still be `1`. Change to `3`, hard-refresh, still `3`.

---

## What to change — Part 2: Clip deduplication (client-side)

### 2a. Add dedup helpers near saveStreamerList

Alongside the dropdown persistence helpers, add the dedup helpers:

```js
// ── Client-side clip dedup — prevents re-shipping clips across runs ──
// Stores clip IDs (from the Twitch clip URL) for 7 days. Clips older than
// 7 days are auto-pruned on every load so the cache never grows unbounded.
var CLIP_DEDUP_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function extractClipId(clipUrl) {
  // Twitch clip URL patterns:
  //   https://clips.twitch.tv/{ClipSlug}
  //   https://www.twitch.tv/{channel}/clip/{ClipSlug}
  // Return the slug as the stable ID.
  if (!clipUrl) return '';
  var m = clipUrl.match(/\/clip\/([^/?]+)/) || clipUrl.match(/clips\.twitch\.tv\/([^/?]+)/);
  return m ? m[1] : clipUrl; // fallback: use full URL as ID
}

function loadUsedClips() {
  try {
    var raw = localStorage.getItem('cwn_used_clips');
    if (!raw) return {};
    var data = JSON.parse(raw);
    // Prune anything older than TTL
    var now = Date.now();
    var pruned = {};
    Object.keys(data).forEach(function(id) {
      if (data[id] && (now - data[id]) < CLIP_DEDUP_TTL_MS) {
        pruned[id] = data[id];
      }
    });
    // Persist the pruned version
    if (Object.keys(pruned).length !== Object.keys(data).length) {
      localStorage.setItem('cwn_used_clips', JSON.stringify(pruned));
    }
    return pruned;
  } catch(e) {
    return {};
  }
}

function markClipsUsed(clipUrls) {
  try {
    if (!clipUrls || !clipUrls.length) return;
    var used = loadUsedClips();
    var now = Date.now();
    clipUrls.forEach(function(url) {
      var id = extractClipId(url);
      if (id) used[id] = now;
    });
    localStorage.setItem('cwn_used_clips', JSON.stringify(used));
  } catch(e) {}
}

function isClipUsed(clipUrl) {
  var used = loadUsedClips();
  var id = extractClipId(clipUrl);
  return !!(id && used[id]);
}
```

**Why 7 days:** Rob confirmed. It matches the Twitch fetch window so any clip visible in the current fetch that was used in a previous run within the same window gets filtered.

**Why localStorage (not server-side):** Rob confirmed. For the "don't re-use a clip I just used" use case, client-side is simpler and sufficient. Server-side dedup is future work for multi-tenant/multi-device scenarios — noted below in "roadmap" section.

### 2b. Filter out used clips in generateTwitch()

**File:** `cwn_production.html`
**Location:** inside `generateTwitch()`, right after the `allValidClips` filter at line 3112.

### Before
```js
var allValidClips=(cd.data||[]).filter(function(c){ return isRealTitle(c.title); });
var validClips=allValidClips.slice(0, clipsPerStreamer);
var backupClips=allValidClips.slice(clipsPerStreamer);
```

### After
```js
// Filter out clips already used in prior runs (client-side dedup, 7-day TTL)
var allValidClips=(cd.data||[]).filter(function(c){
  return isRealTitle(c.title) && !isClipUsed(c.url);
});
var validClips=allValidClips.slice(0, clipsPerStreamer);
var backupClips=allValidClips.slice(clipsPerStreamer);
```

This removes dedup'd clips BEFORE the quota check in Part 3, so a streamer whose only new clip is already used gets correctly counted as "insufficient clips."

### 2c. Mark clips as used after script generation succeeds

**File:** `cwn_production.html`
**Location:** inside `generateTwitch()`, in the `resolveTwitchClipUrls` callback after the script is successfully assembled — specifically right before `callFullScriptServer` is called at line ~3196.

Find this line:
```js
console.log('[generateTwitch] Clips by streamer:', Object.keys(CURRENT_META.clipsByStreamer).map(function(k){ return k + ':' + CURRENT_META.clipsByStreamer[k].length; }).join(', '));
g('script-type-label').textContent = 'TWITCH — Gemini + Claude writing full script...';
callFullScriptServer('twitch', items, 'twitch-gen-status', null);
```

Add a `markClipsUsed(...)` call right before `callFullScriptServer`:

```js
console.log('[generateTwitch] Clips by streamer:', Object.keys(CURRENT_META.clipsByStreamer).map(function(k){ return k + ':' + CURRENT_META.clipsByStreamer[k].length; }).join(', '));

// Mark all primary (non-backup) clips as used so they won't be re-pulled in the next run
var primaryClipUrls = CURRENT_META.orderedClipUrls
  .filter(function(c) { return !c.isBackup; })
  .map(function(c) { return c.pageUrl || c.url; });
markClipsUsed(primaryClipUrls);
console.log('[generateTwitch] Marked ' + primaryClipUrls.length + ' clips as used (7d dedup TTL)');

g('script-type-label').textContent = 'TWITCH — Gemini + Claude writing full script...';
callFullScriptServer('twitch', items, 'twitch-gen-status', null);
```

**Important design choice:** clips are marked "used" right before the script call fires. This means if script generation ITSELF fails downstream, those clips are still marked as used — the user will need to wait for them to TTL out. We accept this trade-off because the alternative (mark on publish success only) creates a much more complex callback chain.

---

## What to change — Part 3: Strict clip quota enforcement

### 3a. Drop streamers below quota in generateTwitch()

**File:** `cwn_production.html`
**Location:** inside `generateTwitch()`, the `xC.onload` callback around line 3115 where the existing `if(validClips.length) { ... } else { ... dropped ... }` block lives (from `cf3868b`).

### Before (current, from `cf3868b`)
```js
var allValidClips=(cd.data||[]).filter(function(c){
  return isRealTitle(c.title) && !isClipUsed(c.url);
});
var validClips=allValidClips.slice(0, clipsPerStreamer);
var backupClips=allValidClips.slice(clipsPerStreamer);
if(validClips.length) {
  // ... existing item-building code ...
} else {
  // Silent-drop visibility: no valid clips in the 7-day window
  var rawCount = (cd.data || []).length;
  var reason = rawCount === 0
    ? 'No clips in 7d window'
    : 'All ' + rawCount + ' clips had invalid titles (filtered by isRealTitle)';
  droppedStreamers.push({name: name, reason: reason});
  console.warn('[generateTwitch] DROPPED: ' + name + ' — ' + reason);
}
```

### After
```js
var allValidClips=(cd.data||[]).filter(function(c){
  return isRealTitle(c.title) && !isClipUsed(c.url);
});
var validClips=allValidClips.slice(0, clipsPerStreamer);
var backupClips=allValidClips.slice(clipsPerStreamer);

// Strict quota: a streamer must deliver the FULL requested clip count or they're dropped.
// Partial quotas (1 clip when 2 were requested) are a short-form pattern, not a compilation format.
// Per Rob's product rule 2026-04-11: variable clip counts per streamer create asymmetric scripts
// and awkward delivery — strictly drop the underfilled streamer and ship with the rest.
if(validClips.length >= clipsPerStreamer) {
  // ... existing item-building code ...
} else {
  // Silent-drop visibility: below quota
  var rawCount = (cd.data || []).length;
  var reason;
  if (rawCount === 0) {
    reason = 'No clips in 7d window';
  } else if (validClips.length === 0) {
    var usedCount = (cd.data || []).filter(function(c){ return isRealTitle(c.title) && isClipUsed(c.url); }).length;
    reason = usedCount > 0
      ? 'All ' + rawCount + ' clips filtered (' + usedCount + ' already used in prior runs)'
      : 'All ' + rawCount + ' clips had invalid titles';
  } else {
    reason = 'Below quota: ' + validClips.length + '/' + clipsPerStreamer + ' clips available (need ' + clipsPerStreamer + ')';
  }
  droppedStreamers.push({name: name, reason: reason});
  console.warn('[generateTwitch] DROPPED: ' + name + ' — ' + reason);
}
```

**Change summary:**
- `if(validClips.length)` → `if(validClips.length >= clipsPerStreamer)` — strict quota check
- Dropped-reason message now distinguishes three failure modes: no clips at all / all clips filtered by dedup / below quota partial fetch. Rob sees exactly why each streamer was dropped.

---

## What this produces, end-to-end

**Scenario:** Rob runs with 12 streamers, clipsPerStreamer=2, after a week of prior runs.

1. Twitch returns raw clips for each streamer
2. Invalid titles filtered (`isRealTitle`)
3. **Dedup filter removes any clip already used in the last 7 days**
4. **Quota check drops any streamer below 2 remaining fresh clips**
5. Status bar shows: `TWITCH — Dropped 4 streamers: marlon (Below quota: 1/2), extraemily (All 3 clips filtered — 3 already used), yourragegaming (No clips in 7d window), adapt (Below quota: 0/2)`
6. Script is generated with the 8 surviving streamers × 2 clips = 16 clips
7. **Gate 1's existing `streamers.length × clipsPerStreamer` math is correct again** because upstream is pre-filtered. No Gate 1 server-side changes needed.
8. After script generation fires, all 16 clip URLs are marked as used. Next run won't pull them.

---

## What you MUST NOT change

- ❌ **`server.js`** — zero server-side changes. Gate 1 math stays as-is and becomes correct because upstream pre-filtering guarantees streamers × clipsPerStreamer matches actual clip count.
- ❌ **The existing `saveStreamerList()` / `loadStreamerList()`** — those persist the streamer textarea, separate concern, already working.
- ❌ **`parseSegments_v2` or script parsing** — no changes needed.
- ❌ **Gate 1 CLIP COUNT check at `server.js:2154`** — leave alone. It's correct post-filter.
- ❌ **Gate 1 clip availability report at `server.js:2052`** — separate system, leave alone. It uses `streamerOrder` passed from the dashboard, which will naturally reflect the post-filtered streamer list.
- ❌ **NBA/News content types** — dedup and quota only apply to Twitch. NBA games and News stories have their own fetch logic.
- ❌ **Backup clip handling** — backups remain in place for GQL resolution fallback, unchanged. Only primary clips are marked as used.
- ❌ **`CLINE_HANDOFF_GATE1_CLIP_COUNT_DYNAMIC.md`** — already deleted; do not recreate it. That handoff was solving the wrong problem.

---

## Verification

1. **Grep checks:**
   ```bash
   grep -n "saveClipsPerStreamer\|loadClipsPerStreamer" cwn_production.html
   # Expect: 2 function definitions + 2 invocations = 4+ hits

   grep -n "isClipUsed\|markClipsUsed\|loadUsedClips\|extractClipId" cwn_production.html
   # Expect: 4 function definitions + 2-3 call sites = 6-7 hits

   grep -n "validClips.length >= clipsPerStreamer" cwn_production.html
   # Expect: 1 hit in generateTwitch()

   grep -n "Below quota:" cwn_production.html
   # Expect: 1 hit in the dropped-reason message
   ```

2. **Syntax:**
   Open `cwn_production.html` in Chrome. Open DevTools console. No errors on page load. Test these in console:
   ```js
   extractClipId('https://clips.twitch.tv/SomeAwesomeSlugHere')
   // Expect: "SomeAwesomeSlugHere"

   extractClipId('https://www.twitch.tv/jasontheween/clip/GlamorousDeadTruffleTF2John-abc123')
   // Expect: "GlamorousDeadTruffleTF2John-abc123"

   markClipsUsed(['https://clips.twitch.tv/TestClip1'])
   isClipUsed('https://clips.twitch.tv/TestClip1')
   // Expect: true

   isClipUsed('https://clips.twitch.tv/NeverSeenClip')
   // Expect: false

   localStorage.removeItem('cwn_used_clips')  // cleanup after test
   ```

3. **Dropdown persistence test:**
   - Change dropdown to "1 clip"
   - Hard refresh (Cmd+Shift+R)
   - Dropdown should still show "1 clip"
   - Change to "3 clips", hard refresh, should still show "3 clips"
   - Open DevTools → Application → Local Storage → `localhost:8765` → verify `cwn_clips_per_streamer` key exists

---

## STATUS.md update

Add one new Last Agent Action row:
```
| 2026-04-11 [TIME] ET | Cline | cwn_production.html | Strict clip quota (drop streamers below requested count) + client-side clip dedup (7d TTL, prevents re-shipping same clips across runs) + CLIPS PER STREAMER dropdown persistence via localStorage | [commit hash] |
```

---

## Commit message

```
feat(dashboard): strict clip quota + client-side dedup + dropdown persistence

Three related dashboard fixes that together give Rob a reliable
repeatable-run loop for CWN episodes. All three live in or adjacent
to generateTwitch() so they ship together.

1. STRICT CLIP QUOTA:
   Previously, generateTwitch() accepted any streamer with at least
   1 valid clip and pushed them into items[]. This created asymmetric
   episodes where some streamers had the requested clipsPerStreamer
   count and others had fewer — leading to awkward scripts and Gate 1
   CLIP COUNT false failures.

   Now: streamers below the requested quota are dropped entirely with
   a visible reason ("Below quota: 1/2 clips available"). Per Rob's
   product rule 2026-04-11: 1-clip streamers are a short-form pattern,
   not a compilation pattern. Strict quota → cleaner scripts →
   Gate 1's existing streamers × clipsPerStreamer math is correct
   again because upstream is pre-filtered.

2. CLIENT-SIDE CLIP DEDUP (7d TTL):
   Rob will run CWN every 1-2 days. Twitch's 7-day fetch window
   legitimately returns the same clips across consecutive runs for
   low-activity streamers. New localStorage-based dedup tracks clip
   IDs that have been used in prior runs and filters them out BEFORE
   the quota check. Entries auto-prune after 7 days.

   extractClipId() pulls a stable ID from either Twitch clip URL
   pattern (clips.twitch.tv/SLUG or twitch.tv/CHANNEL/clip/SLUG).
   markClipsUsed() fires right before callFullScriptServer — meaning
   clips are locked the moment the script starts. Script generation
   failure after that point does NOT unmark them. Acceptable trade-off
   — alternative (mark on publish success) creates complex callback
   chain. 7d TTL provides natural recovery.

   Server-side dedup parked as roadmap for multi-tenant/multi-device.

3. DROPDOWN PERSISTENCE:
   CLIPS PER STREAMER dropdown defaulted to "2 clips" on every hard
   refresh regardless of user's choice. Now saves to localStorage on
   change and restores on page load. Same pattern as saveStreamerList().

Zero server.js changes. Gate 1 CLIP COUNT math is untouched and
becomes correct again because upstream pre-filtering guarantees
streamers.length × clipsPerStreamer matches actual clip count
at the script-generation layer.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
```

Push to main.

---

## Roadmap notes (for HEYGEN_OPTIONS_INVENTORY.md or STATUS.md — not this commit)

- **Server-side dedup** — when CWN moves to Railway multi-tenant, `data/used_clips.json` with per-customer scoping replaces client-side localStorage. Current client-side implementation is sufficient for single-user localhost development.
- **Dedup retention tuning** — 7 days is the starting value. If Rob finds he's missing clips he'd be happy to reuse, shorten to 3-5 days. If he sees duplicates within 7-day window, lengthen to 10-14 days.
- **Full streamer multi-select dropdown (Task #8)** — this handoff does NOT replace the comma-separated textarea with a real multi-select UI. That's still a separate future task. This handoff only fixes the clips-per-streamer dropdown persistence.
- **Dedup inspector UI** — future nice-to-have: a small panel in the dashboard showing "N clips currently in dedup cache, oldest entry from X days ago" with a manual "clear cache" button for testing.

---

## Scope summary

**IN:**
- `cwn_production.html` — multiple edits in `generateTwitch()`, new persistence helpers alongside `saveStreamerList()`, one `<select>` `onchange` attribute addition, one init-time `loadClipsPerStreamer()` call
- STATUS.md single row
- One commit

**OUT:** server.js, Gate 1 check changes, NBA/News, parser, streamer textarea multi-select UI, anything else

**Three fixes, one commit. Ship it.**
