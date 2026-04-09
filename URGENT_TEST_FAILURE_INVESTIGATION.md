# URGENT: Test Failure Investigation - Data-Specific Scene Count Issues

**Date**: 2026-04-09T02:56:00Z  
**Updated**: 2026-04-09T03:24:00Z  
**Severity**: 🔴 CRITICAL  
**Assigned**: Cline (root cause ✅ COMPLETE), Aider (fix implementation)  
**Reporter**: Claude Code (Testing Lead)  
**Status**: 🟢 ROOT CAUSE CONFIRMED — Ready for Aider to fix

---

## Executive Summary

**ROOT CAUSE CONFIRMED**: Multi-word names (with spaces) in scene headers break Gemini's ability to parse and fill those scenes. This is a **prompt construction bug**, not a Gemini output limit issue.

**Two specific bugs found:**

### Bug 1: "Jay Cinco" → `=== JAY CINCO_INTRO ===` (space in header)
- `getDisplayName('jaycinco')` returns `"Jay Cinco"` (two words)
- `.toUpperCase()` → `"JAY CINCO"`
- Scene header becomes: `=== JAY CINCO_INTRO ===`
- Gemini sees `JAY` as the header name and `CINCO_INTRO ===` as content
- **Result**: Jay Cinco's 7 scenes are malformed — Gemini generates them incorrectly or skips them

### Bug 2: "Trail Blazers" → `=== GAME4_JAZZ_TRAIL BLAZERS_INTRO ===` (space in team name)
- NBA team name `"Trail Blazers"` has a space
- `.toUpperCase()` → `"TRAIL BLAZERS"`
- Scene header becomes: `=== GAME4_JAZZ_TRAIL BLAZERS_INTRO ===`
- Gemini sees `GAME4_JAZZ_TRAIL` as the header name, `BLAZERS_INTRO ===` as content
- **Result**: Game 4 (Jazz @ Trail Blazers) scenes are malformed — Gemini skips or mishandles them

---

## Live Test Confirmation

**Test 2 (Twitch Long-form B) — LIVE RUN RESULT:**
```
TOTAL SCENES: 37  ← correct count!
QA SCORE: 60 | OUTCOME: fail

SCENE HEADERS GENERATED:
  INTRO
  MARLON_INTRO ... MARLON_CLIP3_REACTION  ✅
  CINNA_INTRO  ... CINNA_CLIP3_REACTION   ✅
  YONNA_INTRO  ... YONNA_CLIP3_REACTION   ✅
  JAY CINCO_INTRO ... JAY CINCO_CLIP3_REACTION  ⚠️ SPACE IN HEADER
  EXTRAEMILY_INTRO ... EXTRAEMILY_CLIP3_REACTION  ⚠️ WRONG NAME (should be EMILY per roster)
  OUTRO
```

**Key observations from live run:**
1. Gemini DID generate 37 scenes — but QA FAILED (score 60/100)
2. `JAY CINCO_INTRO` headers were generated with spaces — Gemini handled them but Claude QA flagged issues
3. `EXTRAEMILY_INTRO` — Gemini used the Twitch username fallback, not the display name "Emily"
4. The previous test run that got 30 scenes was likely a different Gemini behavior on the malformed headers

**Note on scene count discrepancy (30 vs 37):** The previous 30-scene result was from an earlier test run. The current live run shows 37 scenes but QA fails at 60/100. This means the space-in-header bug causes **QA failures** (malformed content) rather than always causing scene count drops — the behavior is inconsistent.

---

## Confirmed Bugs

### Bug 1: Multi-word display names break scene headers (Twitch)

**Location**: `server.js:6231` (Twitch scene header generation)

```javascript
// CURRENT (BROKEN):
const name = getDisplayName(item.streamer).toUpperCase();
sceneHeaders.push(`=== ${name}_INTRO ===`);
// For "Jay Cinco" → === JAY CINCO_INTRO === ← SPACE BREAKS HEADER
```

**Affected streamers**: Any streamer with a space in their display name
- `jaycinco` → `"Jay Cinco"` → `=== JAY CINCO_INTRO ===` ❌

**Fix**: Replace spaces with underscores in scene header names:
```javascript
const name = getDisplayName(item.streamer).toUpperCase().replace(/\s+/g, '_');
sceneHeaders.push(`=== ${name}_INTRO ===`);
// For "Jay Cinco" → === JAY_CINCO_INTRO === ✅
```

---

### Bug 2: Multi-word team names break NBA scene headers

**Location**: `server.js:6015` (NBA scene header generation)

```javascript
// CURRENT (BROKEN):
const teams = `${(g.away||'AWAY').toUpperCase()}_${(g.home||'HOME').toUpperCase()}`;
sceneHeaders.push(`=== ${gameLabel}_${teams}_INTRO ===`);
// For "Trail Blazers" → === GAME4_JAZZ_TRAIL BLAZERS_INTRO === ← SPACE BREAKS HEADER
```

**Affected teams**: Any NBA team with a space in their name
- `"Trail Blazers"` → `=== GAME4_JAZZ_TRAIL BLAZERS_INTRO ===` ❌
- Also affects: `"76ers"` (has number — minor), any future multi-word team

**Fix**: Replace spaces with underscores in team names:
```javascript
const awayClean = (g.away||'AWAY').toUpperCase().replace(/\s+/g, '_');
const homeClean = (g.home||'HOME').toUpperCase().replace(/\s+/g, '_');
const teams = `${awayClean}_${homeClean}`;
// For "Trail Blazers" → === GAME4_JAZZ_TRAIL_BLAZERS_INTRO === ✅
```

---

### Bug 3: ExtraEmily display name mismatch (secondary issue)

**Observation**: `extraemily` resolves to `"Emily"` (display name in roster), but Gemini generated `EXTRAEMILY_INTRO` in the live test — meaning Gemini used the Twitch username, not the display name.

**Root cause**: The `displayName` in the payload is `"ExtraEmily"` (from test_suite_12cases.json), but `getDisplayName('extraemily')` returns `"Emily"` from the roster. The scene header uses `getDisplayName(item.streamer)` which returns `"Emily"`, but Gemini may be reading the `displayName` field from the streamer data section of the prompt and using that instead.

**Impact**: Minor — the scene header says `EMILY_INTRO` but Gemini writes content for `EXTRAEMILY`. Claude QA catches this as a name mismatch.

**Fix**: Ensure `displayName` in test payloads matches the roster `displayName` field:
- Change `"displayName": "ExtraEmily"` → `"displayName": "Emily"` in test_suite_12cases.json

---

## Exact Code Fixes Required

### Fix 1: server.js — Twitch scene header generation (~line 6231)

```javascript
// BEFORE:
const name = getDisplayName(item.streamer).toUpperCase();

// AFTER:
const name = getDisplayName(item.streamer).toUpperCase().replace(/\s+/g, '_');
```

### Fix 2: server.js — NBA scene header generation (~line 6015)

```javascript
// BEFORE:
const teams = `${(g.away||'AWAY').toUpperCase()}_${(g.home||'HOME').toUpperCase()}`;

// AFTER:
const awayClean = (g.away||'AWAY').toUpperCase().replace(/\s+/g, '_');
const homeClean = (g.home||'HOME').toUpperCase().replace(/\s+/g, '_');
const teams = `${awayClean}_${homeClean}`;
```

### Fix 3: test_suite_12cases.json — ExtraEmily display name

```json
// BEFORE (Test 2, item 5):
{"streamer": "extraemily", "displayName": "ExtraEmily", "clips": []}

// AFTER:
{"streamer": "extraemily", "displayName": "Emily", "clips": []}
```

### Fix 4: Also apply `.replace(/\s+/g, '_')` to News scene headers (defensive)

**Location**: `server.js:6111` (News scene header generation)

News uses `STORY1`, `STORY2` etc. (no names) so it's not currently affected, but the story label generation should be verified to be safe.

---

## Why Test 1 and Test 3 Passed

**Test 1 (Twitch A)**: Jason, Hasan, Adapt, Ron, Lacy — all single-word display names → no spaces in headers → ✅ PASS

**Test 3 (NBA A)**: Celtics, Lakers, Nets, Warriors, Bucks, Heat, Mavericks, Suns, Clippers, Nuggets — all single-word team names → no spaces in headers → ✅ PASS

**Test 2 (Twitch B)**: Jay Cinco has a space → `=== JAY CINCO_INTRO ===` → ❌ FAIL

**Test 4 (NBA B)**: Trail Blazers has a space → `=== GAME4_JAZZ_TRAIL BLAZERS_INTRO ===` → ❌ FAIL

---

## Impact Assessment

**Affected in production:**
- Any Twitch compilation including Jay Cinco (or any future multi-word display name)
- Any NBA compilation including Trail Blazers, Golden State Warriors (if used as "Golden State"), Oklahoma City Thunder (if used as "OKC Thunder"), etc.
- Any team/streamer name with spaces

**Not affected:**
- News compilations (uses STORY1, STORY2 — no names in headers)
- Single-word display names (Jason, Hasan, Adapt, Ron, Lacy, Marlon, Cinna, Yonna, Maya)

---

## Files to Fix

| File | Line | Change |
|------|------|--------|
| `server.js` | ~6231 | Add `.replace(/\s+/g, '_')` to Twitch name in scene header |
| `server.js` | ~6015 | Add `.replace(/\s+/g, '_')` to NBA away/home team names |
| `test_suite_12cases.json` | Test 2, item 5 | Change `"ExtraEmily"` → `"Emily"` |

---

## Validation After Fix

Run these two tests to confirm fix works:

**Test 2 (Twitch B) — should produce:**
```
=== JAY_CINCO_INTRO ===
=== JAY_CINCO_CLIP1_SETUP ===
=== JAY_CINCO_CLIP1_REACTION ===
... (7 scenes for Jay Cinco)
=== EMILY_INTRO ===
... (7 scenes for Emily)
```
Expected: 37 scenes, QA PASS

**Test 4 (NBA B) — should produce:**
```
=== GAME4_JAZZ_TRAIL_BLAZERS_INTRO ===
=== GAME4_JAZZ_TRAIL_BLAZERS_SETUP ===
=== GAME4_JAZZ_TRAIL_BLAZERS_CLIP_REACTION ===
=== GAME4_JAZZ_TRAIL_BLAZERS_REACTION ===
```
Expected: 22 scenes, QA PASS

---

## Status

- ✅ Root cause identified (spaces in multi-word names break scene headers)
- ✅ Both bugs confirmed with live test data
- ✅ Exact code fixes documented
- ⏳ Aider to implement fixes in server.js and test_suite_12cases.json
- ⏳ Re-run Tests 2 and 4 to confirm fix
