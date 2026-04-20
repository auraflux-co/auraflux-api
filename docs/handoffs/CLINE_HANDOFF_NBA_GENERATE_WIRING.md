# HANDOFF: NBA Generate Wiring Fix

**Agent:** Cline-C (frontend)
**Branch:** `cline-c/nba-generate-wiring`
**File:** `cwn_production.html`
**Priority:** High — blocks NBA Gate 0+1 testing

---

## Problem

`nbaUseSelected()` fills a placeholder template in the textarea and shows a hidden button, but never calls the server. `generateNBA()` is wired to a hidden button (`#nba-generate-btn`) that the operator must manually click after Gate 0.

This breaks the automated pipeline. Twitch and News both call `callFullScriptServer()` directly from their Gate 0 completion handler — NBA must do the same.

Additionally, `generateNBA()` makes a second ESPN summary API call that duplicates data already collected during `fetchNBAGames()`. This is waste.

---

## Required Changes

### 1. `nbaUseSelected()` — call server directly (line ~4908)

Currently ends with:
```javascript
  nav('generate');
  g('main-script').scrollIntoView({behavior:'smooth'});
}
```

Replace the entire function body so that after building the `games` array and `CURRENT_META`, it calls `callFullScriptServer()` directly — same pattern as `generateNews()` and `generateTwitch()`.

The items array shape to pass to the server:
```javascript
{
  gameId:       gm.id,
  away:         gm.away,
  home:         gm.home,
  awayAbbr:     gm.awayAbbr,
  homeAbbr:     gm.homeAbbr,
  awayScore:    gm.awayScore,
  homeScore:    gm.homeScore,
  leader:       gm.leader || '',
  leaderStat:   gm.leaderStat || '',
  injuries:     gm.injuries || [],
  clipUrl:      gm.clipUrl || '',
  clipDuration: gm.clipDuration || null,
  thumbnailUrl: gm.thumbnail || ''
}
```

Do NOT make a second ESPN API call — all this data is already on the `gm` object from `fetchNBAGames()` + the scraper.

Call:
```javascript
callFullScriptServer('nba', items, 'nba-status', null);
```

### 2. Remove the SCRIPTS.nba() template pre-fill

Remove line:
```javascript
g('main-script').value = SCRIPTS.nba(games);
```

This writes a placeholder script with `[YOUR OBSERVATION -- one sentence]` brackets to the textarea. Gate 1 auto-fails any script with brackets. Do not pre-fill.

### 3. Remove `generateNBA()` function

The entire `generateNBA()` function (lines 3093-3183) becomes dead code once `nbaUseSelected()` calls `callFullScriptServer()` directly. Remove it.

### 4. Remove the hidden GENERATE SCRIPT button

Line 207:
```html
<button class="btn btn-outline btn-sm" onclick="generateNBA()" id="nba-generate-btn" style="display:none;">GENERATE SCRIPT</button>
```

Remove this button entirely.

### 5. Update `regenScript()` (line 4575)

Currently:
```javascript
function regenScript() {
  if (CURRENT_TYPE === 'nba') generateNBA();
  else if (CURRENT_TYPE === 'news') generateNews();
  else if (CURRENT_TYPE === 'twitch') generateTwitch();
}
```

`generateNBA()` is being removed. For NBA regeneration, call `callFullScriptServer('nba', ...)` directly using `CURRENT_META` items, same as other types. Or simplest fix: for now call `callFullScriptServer(CURRENT_TYPE, CURRENT_META.items, ...)` universally.

---

## What NOT to change

- `fetchNBAGames()` — Gate 0 scraper is working correctly
- `callFullScriptServer()` — already universal, no changes needed
- Server-side `/generate-full-script` — no backend changes

---

## Test

1. Go to NBA page → SELECT GAMES → games load with highlights
2. Check games → click USE SELECTED GAMES
3. Server log should immediately show `/generate-full-script` being called
4. No manual button click required
5. Script in textarea should be Gemini-generated (no placeholder brackets)
6. Gate 1 QA file should appear in `output/qa_failures/`
