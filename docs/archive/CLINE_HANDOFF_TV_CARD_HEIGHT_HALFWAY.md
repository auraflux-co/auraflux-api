# CLINE HANDOFF — TV Card Y Position: Halfway Drop

**Priority:** P1 — unblocks Rob's next real-content test
**Scope:** One-line config change in `lib/config.js`
**Est. Cline time:** ~5 minutes including STATUS.md update
**Depends on:** Nothing (independent of any in-flight work)

---

## Context

Screenshot from Rob's most recent smoke test (2026-04-11 5:29 PM):
- Ticker at y=1008 (72px tall, 30fps) is stable and readable ✅
- TV card at y=100 looks clean but sits **inside the neon world map**, competing visually with the brightest part of the background set
- Rob asked about bottom-right placement; we flagged hand-gesture collision risk in the y≈600 zone
- Compromise: **drop the card halfway** between original top (y=100) and true-bottom (y=603) — lands at **y=352**

## The change

**File:** `lib/config.js`
**Line:** 55

### Before
```js
OVERLAY_ZONE: { x: 1160, y: 100, w: 720, h: 405 },  // "TV Shape" Top Right — exact 16:9 (720÷405=1.7778), clears Bobby G shoulder, 40px right margin (2026-04-11 revision)
```

### After
```js
OVERLAY_ZONE: { x: 1160, y: 352, w: 720, h: 405 },  // "TV Shape" Mid-Right — exact 16:9 (720÷405=1.7778), dropped from y=100 halfway toward bottom to exit neon-map "billboard zone", still 251px above ticker (2026-04-11 revision)
```

**Only `y` changes** (100 → 352). Do not touch `x`, `w`, or `h`.

## Why 352

```
Original y:    100   (inside neon map, competes with background)
True-bottom y: 603   (y=603 → y=1008 would overlap hand gestures)
Halfway:       (100 + 603) / 2 = 351.5 → 352
```

**Frame math after change:**
- Card spans y=352 → y=757
- Top edge (352) is below the neon world map's brightest arc
- Bottom edge (757) leaves **251px** of breathing room above the ticker at y=1008
- Sits against the quieter bookshelf zone behind Bobby G's shoulder
- Lower-half of the card (y≈580–757) may still catch occasional hand gestures — Rob is aware and will validate on the next real test

## What you MUST NOT change

- ❌ `x` (stays at 1160)
- ❌ `w` (stays at 720)
- ❌ `h` (stays at 405)
- ❌ `LOGO_POS` (stays at x:80, y:10, size:100)
- ❌ `TICKER.HEIGHT` (stays at 72)
- ❌ Any FFmpeg filter in `server.js` — they already read from `CONFIG.VISUAL_LAYOUTS.LONG_FORM.OVERLAY_ZONE.y`, so the config change propagates automatically

## Verification

1. `git diff lib/config.js` — should show **exactly one numeric change** on line 55 (and the comment update)
2. Grep for hardcoded `y=100` in `server.js` FFmpeg filters — there should be none; all overlay y values read from `CONFIG.VISUAL_LAYOUTS.LONG_FORM.OVERLAY_ZONE.y`
3. No need to restart server — nodemon will pick up the config change

## STATUS.md update

Add a new Last Agent Action row:
```
| 2026-04-11 [TIME] ET | Cline | lib/config.js | TV card y: 100 → 352 (halfway drop to exit neon-map zone, 251px ticker clearance) | [commit hash] |
```

## Commit

```
fix: drop TV card y=100 → y=352 — exits neon-map billboard zone, preserves ticker clearance

One-line config change in lib/config.js OVERLAY_ZONE.y. Screenshot from
2026-04-11 smoke test showed the card sitting inside the neon world map
behind Bobby G. Halfway drop toward true-bottom moves it to the quieter
bookshelf zone without risking ticker overlap or heavy hand-gesture
collision. Rob will validate on next real-content multi-streamer test.
```

Push to `main`. Done.

## What's NOT in scope

- ❌ Any FFmpeg filter edits
- ❌ Logo position adjustments
- ❌ Ticker changes
- ❌ Short-form layout changes
- ❌ Any `server.js` edits
- ❌ Streamer dropdown work (separate Task #8)

**One line. Config only. Ship it.**
