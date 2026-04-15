# CLINE HANDOFF — TV card: 520×293 at (1360, 60)

**Priority:** P1 — visual placement fix, unblocks Rob's 12-streamer real-content test
**Scope:** One line in `lib/config.js`
**Est. Cline time:** ~5 minutes including STATUS.md update
**Depends on:** Nothing

---

## Context

Three iterations on TV card placement tonight:

1. **Commit `0b613af` (earlier today):** `{ x: 1160, y: 100, w: 720, h: 405 }` — top-right, in the neon map's brightest zone
2. **Commit `2781d8a` (tonight):** `{ x: 1160, y: 352, w: 720, h: 405 }` — mid-right halfway drop. Rob's screenshot showed it overlapping Bobby G's shoulder and upper chest. Worse than the original.
3. **This commit:** `{ x: 1360, y: 60, w: 520, h: 293 }` — smaller card, top-right next to Bobby G's head, honoring Rob's constraints.

Rob ran `scripts/measure_bobby_g.js` on the current screenshot via Gemini 2.5 Flash. Gemini's recommended placement was `(1460, 60, 430, 242)` but it left a 560px horizontal gap between Bobby G's shoulder and the card — too conservative. Rob's visual estimate of his head/shoulder position suggests the card can be bigger AND closer without overlap. This commit uses Rob's visual estimate, not Gemini's.

**Constraints honored:**
- ≥60px top padding from frame top
- ≥40px right margin (card right edge at 1880, frame right edge 1920)
- Exact 16:9 aspect ratio (520 ÷ 293 = 1.7747, within float rounding of 1.7778)
- Next to Bobby G's head on viewer's right side
- Much larger readable area than Gemini's suggestion (49% more area: 520×293 = 152,360px² vs 430×242 = 104,060px²)
- May have mild overlap with Bobby G's right shoulder — acceptable, looks like a broadcast over-the-shoulder graphic

---

## The change

**File:** `lib/config.js`
**Line:** 55

### Before
```js
OVERLAY_ZONE: { x: 1160, y: 352, w: 720, h: 405 },  // "TV Shape" Mid-Right — exact 16:9 (720÷405=1.7778), dropped from y=100 halfway toward bottom to exit neon-map "billboard zone", still 251px above ticker (2026-04-11 revision)
```

### After
```js
OVERLAY_ZONE: { x: 1360, y: 60, w: 520, h: 293 },  // "TV Shape" Top-Right OTS — 16:9 (520÷293≈1.775), next to Bobby G's head on viewer's right, 60px top padding + 40px right margin. Smaller than previous 720×405 so card respects Bobby G's silhouette. (2026-04-11 iteration 3)
```

**Only change the one line.** Do not touch `x`, `w`, `h` elsewhere in the file. Do not touch `LOGO_POS`, `AVATAR_SAFE_ZONE`, `SHORT_FORM`, or `TICKER`.

---

## Why 520×293 (not the Gemini-suggested 430×242)

Math:
- 520 ÷ 293 = 1.7747 (16:9 target is 1.7778, difference = 0.0031 or 0.17% — imperceptible)
- Right edge: 1360 + 520 = 1880 → 40px right margin (not flush, per constraint)
- Bottom edge: 60 + 293 = 353 → rests just at Bobby G's shoulder line per Rob's visual estimate
- Width = 520, larger than Gemini's 430 → bigger profile image and more readable text at the intro card's final render scale
- Placement (x=1360) is 100px closer to Bobby G than Gemini's suggestion (x=1460), which reduces the "floating card in the corner" feel

Rob specifically wants a broadcast over-the-shoulder newsgraphic look, not a floating corner card. This placement achieves that.

---

## What you MUST NOT change

- ❌ Any other line in `lib/config.js`
- ❌ `server.js` — FFmpeg overlay filters already read from `CONFIG.VISUAL_LAYOUTS.LONG_FORM.OVERLAY_ZONE`, config change auto-propagates
- ❌ `cwn_production.html` — dashboard doesn't use OVERLAY_ZONE
- ❌ The intro card canvas dimensions at `CONFIG.INTRO_CARD` (still 1280×720 internally — FFmpeg will scale that down to 520×293 automatically)
- ❌ Any other in-flight handoff or file

---

## Verification

1. **`git diff lib/config.js`** — should show exactly one modified line (line 55) plus the inline comment update
2. **No server restart needed** — but `nodemon` will auto-restart when it detects the `lib/config.js` change; that's fine and expected

---

## STATUS.md update

Add one new Last Agent Action row:
```
| 2026-04-11 [TIME] ET | Cline | lib/config.js | TV card: {1160,352,720,405} → {1360,60,520,293} — smaller top-right OTS position, next to Bobby G's head, honors 60px top padding + 40px right margin per Rob's visual measurement | [commit hash] |
```

---

## Commit message

```
fix(layout): TV card 520×293 at top-right (1360, 60) — broadcast OTS position

Third iteration on TV card placement tonight. Previous position
(1160, 352, 720, 405) overlapped Bobby G's shoulder and upper chest.
Rob measured the frame via scripts/measure_bobby_g.js (Gemini 2.5
Flash vision) and chose a smaller card size positioned next to
Bobby G's head on viewer's right — broadcast over-the-shoulder
newsgraphic style.

- Size: 520×293 (16:9, ≈1.7747 — within float rounding of 1.7778)
- Position: x=1360 y=60 (60px top padding, 40px right margin)
- Right edge: x=1880 (not flush to frame edge 1920 per constraint)
- Bottom: y=353 (at shoulder line — acceptable mild overlap like
  a real OTS graphic)

Smaller than previous 720×405 but positioned so Bobby G's silhouette
is respected. One-line change in lib/config.js — FFmpeg filters
already read from CONFIG.VISUAL_LAYOUTS.LONG_FORM.OVERLAY_ZONE so
change auto-propagates.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
```

Push to main.

---

## Scope summary

**IN:** `lib/config.js` line 55, STATUS.md row, single commit
**OUT:** server.js, dashboard, intro card canvas, every other file

**One line. Ship it.**
