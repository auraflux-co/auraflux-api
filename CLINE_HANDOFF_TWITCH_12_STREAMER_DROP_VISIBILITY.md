# CLINE HANDOFF — Fix 12-streamer silent-drop + surface drop reasons

**Priority:** P0 — unblocks Rob's first real-content 12-streamer test
**Scope:** `cwn_production.html` dashboard only — no server.js changes
**Est. Cline time:** ~25 minutes including STATUS.md update + smoke-test sanity check
**Depends on:** Nothing

---

## The problem

Rob has been running tests for days and consistently sees only ≤9 streamers make it into any given episode, even though the textarea lists 10–12. He wants the first real test to include all 12 roster streamers with 2 clips each, AND he wants the Gate 1 report to tell him explicitly why any streamer came up short (0 clips, 1 clip, etc).

**Root cause:** `generateTwitch()` at `cwn_production.html:3076` queries the Twitch Helix API with `started_at = now - 24h` (line 3094). Less-active streamers who didn't stream or get clipped in the last 24 hours return `data: []`, fail the `if(validClips.length)` check at line 3110, and are **silently dropped** from the `items[]` array. The server never sees them, so the Gate 1 clip availability report just lists them as *"Not in this episode"* (line 2095 in `server.js`) instead of *"dashboard had 0 clips in 7d window"*.

Two secondary issues:
1. The dashboard's hardcoded `DISPLAY_NAMES` map at line 3114–3118 only has 10 streamers — `extraemily` and `yourragegaming` are missing. Server-side `STREAMER_DISPLAY_NAMES` already has all 12 (`server.js:4826`), so the dashboard is the stale copy.
2. When a streamer is dropped, there is zero visible feedback in the dashboard — no console log, no status bar message, no count of dropped streamers.

---

## What to change (three parts, one file: `cwn_production.html`)

### Part 1 — Widen Twitch clip window from 24h → 7d

**File:** `cwn_production.html`
**Line:** 3094

**Before:**
```js
var since=new Date(Date.now()-86400000).toISOString();
```

**After:**
```js
var since=new Date(Date.now()-86400000*7).toISOString();  // 7-day window (was 24h — too narrow for less-active streamers)
```

**Why:** 24h is too narrow for streamers who don't stream daily. 7 days gives every roster streamer a realistic pool while still keeping clips recent and topical. Fetch count stays at `Math.max(clipsPerStreamer * 5, 20)` — unchanged — so you still pull 20 clips from the wider window.

### Part 2 — Add missing streamers to DISPLAY_NAMES map

**File:** `cwn_production.html`
**Lines:** 3114–3118

**Before:**
```js
var DISPLAY_NAMES = {
  'jasontheween':'Jason','hasanabi':'Hasan','adapt':'Adapt',
  'stableronaldo':'Ron','lacy':'Lacy','marlon':'Marlon',
  'cinna':'Cinna','yonnajay':'Yonna','jaycinco':'Jay Cinco','maya':'Maya'
};
```

**After:**
```js
var DISPLAY_NAMES = {
  'jasontheween':'Jason','hasanabi':'Hasan','adapt':'Adapt',
  'stableronaldo':'Ron','lacy':'Lacy','marlon':'Marlon',
  'cinna':'Cinna','yonnajay':'Yonna','jaycinco':'Jay Cinco','maya':'Maya',
  'extraemily':'ExtraEmily','yourragegaming':'Rage'
};
```

**Why:** Mirror of the authoritative `STREAMER_DISPLAY_NAMES` in `server.js:4826–4839`. The two lists must stay in sync. If you find any other dashboard location with a hardcoded display-name map, flag it but **do not change it** without checking with Rob first.

### Part 3 — Track and surface silent-drops

In the `generateTwitch()` function, we need to:
1. Track every streamer that the Twitch API returns 0 clips for (or errors out on)
2. Show a visible status message listing dropped streamers after the fetch loop completes
3. Log to console for easier debugging

**Where to make the changes:**

**3a.** At the top of `generateTwitch()` (right after line 3083 `var items = []; var done = 0;`), add a droppedStreamers array:

```js
var items = []; var done = 0;
var droppedStreamers = []; // streamers returning 0 valid clips from dashboard fetch
```

**3b.** On line 3093 (the `if(!user){done++;check();return;}` branch), change it to record the drop reason before continuing:

**Before:**
```js
if(!user){done++;check();return;}
```

**After:**
```js
if(!user){
  droppedStreamers.push({name: name, reason: 'Twitch user not found'});
  console.warn('[generateTwitch] DROPPED: ' + name + ' — Twitch user not found');
  done++;check();return;
}
```

**3c.** In the `xC.onload` handler, wrap the existing `if(validClips.length)` block so the else branch records a drop. Currently lines 3107–3144 look like:

```js
var allValidClips=(cd.data||[]).filter(function(c){ return isRealTitle(c.title); });
var validClips=allValidClips.slice(0, clipsPerStreamer);
var backupClips=allValidClips.slice(clipsPerStreamer);
if(validClips.length) {
  // ... builds item, pushes to items[] ...
}
```

**Change to:**
```js
var allValidClips=(cd.data||[]).filter(function(c){ return isRealTitle(c.title); });
var validClips=allValidClips.slice(0, clipsPerStreamer);
var backupClips=allValidClips.slice(clipsPerStreamer);
if(validClips.length) {
  // ... existing item-building code unchanged ...
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

**3d.** Also catch the `xC.onerror` / `xC.ontimeout` path (line 3148) and the outer `xU` error path (line 3151):

**Before:**
```js
xC.onerror=xC.ontimeout=function(){done++;check();}; xC.send();
// ...
xU.onerror=xU.ontimeout=function(){done++;check();}; xU.send();
```

**After:**
```js
xC.onerror=xC.ontimeout=function(){
  droppedStreamers.push({name: name, reason: 'Twitch clips API timeout/error'});
  console.warn('[generateTwitch] DROPPED: ' + name + ' — Twitch clips API timeout/error');
  done++;check();
}; xC.send();
// ...
xU.onerror=xU.ontimeout=function(){
  droppedStreamers.push({name: name, reason: 'Twitch users API timeout/error'});
  console.warn('[generateTwitch] DROPPED: ' + name + ' — Twitch users API timeout/error');
  done++;check();
}; xU.send();
```

**3e.** In the `check()` function (starts at line 3153), surface the drops in the status bar BEFORE calling `callFullScriptServer`. After line 3155 (`g('script-type-label').textContent = 'TWITCH — Resolving clip URLs...';`) but before the items.sort, add:

```js
if (droppedStreamers.length > 0) {
  var dropMsg = 'TWITCH — Dropped ' + droppedStreamers.length + ' streamers: ' +
    droppedStreamers.map(function(d){ return d.name + ' (' + d.reason + ')'; }).join(', ');
  console.warn('[generateTwitch] ' + dropMsg);
  // Show in status bar for 6 seconds before script-gen status overwrites it
  setGeneratingState('twitch-gen-status', dropMsg);
}
```

**3f.** Also pass `droppedStreamers` to the server so the Gate 1 clip availability report can use it. In the final `callFullScriptServer` call at line 3196, find where `items` is passed and add `droppedStreamers` alongside it. Look at how `callFullScriptServer` currently signs its calls (grep the function) — the goal is to add the array to the payload without breaking the signature for NBA/News flows.

**IMPORTANT:** Part 3f is the one risky sub-step. If `callFullScriptServer` has a tight signature and adding a param would break NBA/News flows, **skip 3f** and just ship 3a–3e. Rob will still see the drops in the dashboard status bar, which is the most important UX improvement. Server-side drop visibility can be a follow-up handoff.

---

## What to NOT change

- ❌ `server.js` — do not touch. The server-side clip availability report already exists at `server.js:2052–2118` and works correctly on the data it receives. The fix is to get correct data TO it from the dashboard.
- ❌ `fetchCount` calculation at line 3097 — stays at `Math.max(clipsPerStreamer * 5, 20)`
- ❌ `isRealTitle` filter logic
- ❌ `resolveTwitchClipUrls` flow
- ❌ Any other `generateTwitch()` section, NBA/News generators, or publish pipeline
- ❌ The main-generator textarea contents
- ❌ `CLINE_HANDOFF_TV_CARD_HEIGHT_HALFWAY.md` — separate uncommitted handoff, don't bundle

---

## Verification before commit

1. **Grep check:** `grep -n "86400000" cwn_production.html` — should only appear once (the modified line 3094)
2. **Grep check:** `grep -n "extraemily\|yourragegaming" cwn_production.html` — should show the new DISPLAY_NAMES entries
3. **Syntax:** Load the file in Chrome DevTools — no JS parse errors
4. **Dry-run test:** Paste this 12-streamer list into the textarea:
   ```
   jasontheween, hasanabi, adapt, stableronaldo, lacy, marlon, cinna, yonnajay, jaycinco, maya, extraemily, yourragegaming
   ```
   Click GENERATE TWITCH VIDEO. In DevTools console, watch for:
   - `[generateTwitch] DROPPED: ...` warnings for any streamer with 0 clips
   - `[generateTwitch] Stored N clip URLs for assembly` (N should be ≥ 2 × surviving streamers)
   - `[generateTwitch] Clips by streamer: ...` — one entry per surviving streamer
   - Status bar briefly shows drop message if any streamers were dropped
5. If all 12 streamers survive the 7d window: nice, max case proven
6. If some still drop: the console + status bar tells Rob exactly who and why — that was the real goal

**Rob will do the actual test run himself — Cline's job is to verify the code change is syntactically clean and the console logging fires. Do NOT wait for Rob's run to commit; ship once the grep/syntax checks pass.**

---

## STATUS.md update

Add a new Last Agent Action row:
```
| 2026-04-11 [TIME] ET | Cline | cwn_production.html | Fix 12-streamer silent-drop: widen Twitch clip window 24h→7d, add extraemily+yourragegaming to DISPLAY_NAMES, surface drop reasons in console+status bar | [commit hash] |
```

Also update any open task items referencing "streamer dropdown" or "silent-drop" — this handoff partially addresses Task #8 but does not fully replace it (a real multi-select UI is still a future polish item).

---

## Commit message

```
fix(dashboard): widen Twitch clip window 24h→7d + surface streamer silent-drops

Rob's been seeing ≤9 streamers per episode even with 10-12 listed in the
textarea. Root cause: generateTwitch() fetched clips from the last 24h
only, silently dropping any streamer with 0 recent clips. Three fixes:

1. started_at window: 24h → 7d (line 3094) — every roster streamer
   gets a realistic clip pool without losing topicality
2. DISPLAY_NAMES map: added extraemily + yourragegaming to mirror
   server.js STREAMER_DISPLAY_NAMES (kept in sync)
3. Silent-drop visibility: track droppedStreamers[] across user-lookup,
   clips-fetch, and timeout paths; log to console + surface in status
   bar so Rob knows exactly which streamers were dropped and why

Server-side Gate 1 clip availability report (server.js:2052) already
works correctly — it just needed correct data from the dashboard.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
```

Push to `main`. Rob will run the 12-streamer test immediately after.

---

## Scope boundary summary

**IN:** cwn_production.html only, 3 tiny functional changes + drop tracking, STATUS.md row, single commit
**OUT:** server.js edits, NBA/News generators, new dropdown UI, Gate 1 report restructure, bundling with the TV card y=352 handoff

Ship it fast — Rob is waiting on this to run the first real 12-streamer test.
