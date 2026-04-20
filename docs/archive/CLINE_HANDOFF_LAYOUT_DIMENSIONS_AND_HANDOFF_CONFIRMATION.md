# Cline Handoff: Layout Dimension Fixes + 5-Handoff Confirmation

**Author:** Claude Code
**Date:** 2026-04-11 ~3:45 PM ET
**Status:** 🟢 Ship-ready — small surgical code changes + docs confirmation
**Priority:** Medium — polish the working smoke test output based on Rob's visual review
**Estimated effort:** ~1 hour Cline work (code changes) + 5 min (handoff confirmation replies)
**Related:** 3rd smoke test visually approved by Rob at ~2:30 PM ET except for dimension tweaks

---

## TL;DR

Rob reviewed the 3rd smoke test output MP4 and approved everything EXCEPT three dimensional details:

1. **TV card is too small** — the rendered intro card came out at roughly 360×200 because of a hardcoded `scale=360:-1` FFmpeg filter that calculates height from the 1280×720 source canvas. Target was supposed to be 640×360. Fix: change to `scale=840:472` (new target — bigger than the old 640×360 spec for NBA scores / news headlines readability).
2. **Logo overlaps the microphone arm** — current position `(20, 20, 120)` puts the CWN gold badge in a region where Bobby G's new avatar has the mic arm curving through. Fix: move to `(80, 10, 100)` — up and right to clear the mic, slightly smaller.
3. **Ticker is too short** — current 64px bottom bar is readable but Rob wants a bump for TV/mobile viewing. Fix: `HEIGHT: 72` (+12.5%) — conservative bump that still clears Bobby G's hand gestures.

All 3 changes apply uniformly to ALL 3 content types (Twitch, NBA, News) since they share `CONFIG.VISUAL_LAYOUTS.LONG_FORM` and `CONFIG.TICKER` objects.

Plus: **this handoff also asks Cline to confirm the status of 5 recent handoff docs** so we can archive the shipped ones and stop accumulating handoff clutter.

**Visual preview approved:** `tmp/preview/FINAL_c2_ticker72.jpg` shows the proposed dimensions composited on the Bobby G frame with drawbox outlines. Rob approved this preview and said "ship it."

---

## Part 1 — Final dimensions (authoritative)

All three changes are to `lib/config.js` + corresponding FFmpeg filter commands in `server.js`. These are the authoritative numbers — do NOT change them without explicit approval.

### TV card (OVERLAY_ZONE)

```diff
// lib/config.js → CONFIG.VISUAL_LAYOUTS.LONG_FORM
- OVERLAY_ZONE: { x: 1240, y: 40, w: 640, h: 360 },     // "TV Shape" Top Right
+ OVERLAY_ZONE: { x: 1040, y: 100, w: 840, h: 472 },    // "TV Shape" Top Right — enlarged +31% area for readability
```

**Math check:**
- Width 840 + x 1040 = right edge at x=1880 (40px margin from 1920 right edge) ✅
- Height 472 + y 100 = bottom edge at y=572 (well above Bobby G's face at ~y=700+) ✅
- 840:472 aspect ratio = 1.78 (matches 16:9 = 1.778) ✅
- 840×472 = 396,480 pixels vs old 640×360 = 230,400 pixels → **1.72× area** ✅

### Logo (LOGO_POS)

```diff
// lib/config.js → CONFIG.VISUAL_LAYOUTS.LONG_FORM
- LOGO_POS: { x: 20, y: 20, size: 120 }
+ LOGO_POS: { x: 80, y: 10, size: 100 }
```

**Rationale:**
- x: 20 → 80 (60px further right, clears the microphone arm's leftmost curve)
- y: 20 → 10 (10px closer to top, above the mic arm's highest reach)
- size: 120 → 100 (slightly smaller to reduce the overlap surface area)
- `SHORT_FORM.LOGO_POS` unchanged — short-form is 9:16 portrait with different composition, not affected

### Ticker (TICKER.HEIGHT)

```diff
// lib/config.js → CONFIG.TICKER
- HEIGHT: 64,
+ HEIGHT: 72,
```

**Rationale:**
- +12.5% height bump (Rob initially wanted "80px or more" but settled on 72 after reviewing the preview — 72 keeps a clean gap above Bobby G's hands)
- Applied uniformly to twitch/nba/news via the shared `TICKER` config object
- Ticker will now occupy y=1008 to y=1080 (was y=1016 to y=1080)

---

## Part 2 — Code changes (exact diffs)

### Change #1 — `lib/config.js` (3 values)

```diff
  VISUAL_LAYOUTS: {
    LONG_FORM: {
      WIDTH: 1920,
      HEIGHT: 1080,
      AVATAR_SAFE_ZONE: { x: 0, y: 720, w: 1920, h: 360 }, // Bottom third
-     OVERLAY_ZONE: { x: 1240, y: 40, w: 640, h: 360 },    // "TV Shape" Top Right
-     LOGO_POS: { x: 20, y: 20, size: 120 }
+     OVERLAY_ZONE: { x: 1040, y: 100, w: 840, h: 472 },   // "TV Shape" Top Right — 31% larger for NBA/news readability (2026-04-11)
+     LOGO_POS: { x: 80, y: 10, size: 100 }                // Moved up/right to clear mic arm in new avatar (2026-04-11)
    },
    SHORT_FORM: {
      WIDTH: 1080,
      HEIGHT: 1920,
      CLIP_ZONE: { x: 0, y: 0, w: 1080, h: 960 },
      AVATAR_ZONE: { x: 0, y: 960, w: 1080, h: 960 },
      BURN_IN_ZONE: { x: 540, y: 960, anchor: 'center' },
      LOGO_POS: { x: 985, y: 15, size: 80 }                // Short-form unchanged
    }
  },
  TICKER: {
    CACHE_TTL_MS: 3600000,
    DURATION_SECONDS: 60,
    WIDTH: 1920,
-   HEIGHT: 64,
+   HEIGHT: 72,
    FPS: 15
  },
```

### Change #2 — `server.js:3754` and `server.js:3904` (FFmpeg TV card overlay burns)

**Currently hardcoded:**
```js
"-filter_complex", `[1:v]scale=360:-1:flags=lanczos[card];[0:v][card]overlay=x=1240:y=40:enable='lte(t,${introDur})'[out]`,
```

**New — read from config:**
```js
const ov = CONFIG.VISUAL_LAYOUTS.LONG_FORM.OVERLAY_ZONE;
// ... then in the filter:
"-filter_complex", `[1:v]scale=${ov.w}:${ov.h}:flags=lanczos[card];[0:v][card]overlay=x=${ov.x}:y=${ov.y}:enable='lte(t,${introDur})'[out]`,
```

**Both occurrences** at lines 3754 (Twitch path) and 3904 (NBA/News path) need this change. The `CONFIG` constant is already imported at the top of `server.js` via `require('./lib/config')`.

**Why read from config instead of hardcoding `scale=840:472:flags=lanczos ... overlay=x=1040:y=100`?**

1. **Source-of-truth pattern** — `lib/config.js` is the single place dimensions live; any future change just edits one file
2. **Prevents regression** — the current bug exists because the filter hardcoded `scale=360:-1` which was correct for the old 720×840 canvas but broke when the canvas changed to 1280×720. Config-driven prevents this from recurring.
3. **Easy rollback** — if 840×472 looks wrong, just revert `lib/config.js` without touching `server.js`

### Change #3 — `server.js:3957` (ticker overlay Y offset)

**Currently:**
```js
'-filter_complex', '[0:v][1:v]overlay=x=0:y=H-64:eof_action=repeat[vout]',
```

**New — read from config:**
```js
const tickerH = CONFIG.TICKER.HEIGHT;
// ... then in the filter:
'-filter_complex', `[0:v][1:v]overlay=x=0:y=H-${tickerH}:eof_action=repeat[vout]`,
```

### Change #4 — `server.js:4037` (logo overlay — already mostly config-driven but verify)

Check the current logo overlay burn and make sure it reads from `CONFIG.VISUAL_LAYOUTS.LONG_FORM.LOGO_POS`. Currently:

```js
'-filter_complex',
'[1:v]scale=120:-1,format=rgba,colorchannelmixer=aa=0.85[logo];[0:v][logo]overlay=20:20[vout]',
```

Both `scale=120:-1` (logo width 120) and `overlay=20:20` (position 20,20) are hardcoded. **Update to read from config:**

```js
const lp = CONFIG.VISUAL_LAYOUTS.LONG_FORM.LOGO_POS;
'-filter_complex',
`[1:v]scale=${lp.size}:-1,format=rgba,colorchannelmixer=aa=0.85[logo];[0:v][logo]overlay=${lp.x}:${lp.y}[vout]`,
```

Same change at `server.js:9308` if that second logo overlay location still exists.

### Change #5 — Bust cached ticker files (shell command, not code)

Before the first test run with the new `HEIGHT: 72` config, the cached `tmp/ticker_twitch.mp4` needs to be deleted so `captureTicker()` regenerates at 1920×72 instead of the old 1920×64.

```bash
rm -f tmp/ticker_*.mp4
rm -rf tmp/ticker_frames_*
```

**Critical:** the in-memory `TICKER_CACHE` object also needs to be cleared when `server.js` hot-reloads. `nodemon` restart on config change handles this automatically.

---

## Part 3 — Test plan

### Test 1 — Unit-level: verify the intro card PNG is generated at 1280×720

Before running a full smoke test, verify `generateIntroCardPNG()` at `server.js:500` still produces 1280×720 output (that's the source canvas, which gets scaled down to 840×472 at overlay time). If the function is still producing the old 720×840, the scale filter won't matter.

```bash
curl -X POST http://localhost:3000/burn-streamer-intro \
  -H "Content-Type: application/json" \
  -d '{"streamer":"jasontheween"}'
```

Check the returned PNG path via `ffprobe`:
```bash
ffprobe -v error -show_entries stream=width,height -of csv=p=0:s=x <PNG path>
```

Expected: `1280x720` (the intermediate source) OR whatever Cline's migration actually produced. If it's still 720×840, Cline needs to verify the circle→TV migration was complete per `CLINE_HANDOFF_TWITCH_INTRO_CARD_TO_TV_DESIGN.md`.

### Test 2 — Visual smoke test: Jason 2-clip (4th full smoke test of the sprint)

1. Wipe stale state:
   ```bash
   echo '{}' > data/jobs.json
   rm -f tmp/ticker_*.mp4
   rm -rf tmp/ticker_frames_*
   ```
   Clear browser localStorage via DevTools.

2. Dashboard → Twitch card:
   - Streamers: `jasontheween`
   - Format: Landscape 1920×1080
   - Clips per streamer: `2`
   - Click **GENERATE TWITCH VIDEO**

3. Wait for Gate 1 to auto-pass (should score 100/100 per `8929a47` maxOutputTokens fix)

4. Click **SEND TO HEYGEN** → wait ~2 min for 7 segments

5. Click **⚙ ASSEMBLE** → wait for completion

6. **Verification checklist** (compare against Variant C2 preview in `tmp/preview/FINAL_c2_ticker72.jpg`):
   - ✅ Output MP4 is 1920×1080 30fps H.264 AAC, AV sync healthy
   - ✅ Full-bleed Bobby G avatar, no pillarbox
   - ✅ CWN gold logo at top-left (80, 10), 100px wide, clear of mic arm
   - ✅ TV rectangle intro card at top-right during JASON_INTRO scene — should be **840×472** (visibly larger than previous 640×360 renders)
   - ✅ TV card left edge at x=1040 — right of Bobby G's right shoulder
   - ✅ TV card contains Jason's profile image + "JASON / Arlington / Dep Gai guy" text rendered inside the rectangle
   - ✅ Ticker at the bottom, visible, **72px tall** (y=1008 to y=1080), scrolling content (NOT "Error response")
   - ✅ Source clips play full-bleed at JASON_CLIP1 and JASON_CLIP2 timestamps
   - ✅ No video freeze, no darkened segments, no duplicate/missing scenes

7. Paste me (Claude Code) the output MP4 path and I'll run the verification.

### Test 3 — Quick NBA sanity check (if time permits)

Optionally, run a 1-game NBA smoke test to verify the same dimensions apply to NBA content:
- TV card at 840×472 top-right, NBA game thumbnail inside
- Logo at (80, 10, 100)
- Ticker 72px
- All 3 elements look consistent with the Twitch test

---

## Part 4 — Rollback plan

If the new dimensions look wrong after Test 2:

**Full rollback:**
```bash
git revert HEAD
```

Reverts all 5 code changes atomically. Config returns to previous values.

**Partial rollback options:**

- **TV card too big?** Edit `lib/config.js` `OVERLAY_ZONE` back to `{x: 1240, y: 40, w: 640, h: 360}` — because server.js now reads from config, no FFmpeg change needed
- **Logo wrong position?** Edit `LOGO_POS` in `lib/config.js` — same, config-driven
- **Ticker still too short/tall?** Edit `HEIGHT` in `lib/config.js` TICKER — one line
- **Ticker cache stuck?** `rm tmp/ticker_*.mp4` and restart nodemon

All partial rollbacks are single-line edits because of Change #2's config-driven pattern.

---

## Part 5 — Handoff confirmation checklist (for Cline)

Rob asked me to verify the status of every open handoff doc so we can archive shipped ones and stop accumulating clutter. Cline, please read each of these and reply with the commit hash (or "NOT YET SHIPPED") for each:

### Handoff 1 — `CLINE_HANDOFF_AVATAR_AND_TICKER_FIX.md`

**Claude Code's belief:** ✅ Shipped as commit `0d13fb0` on 2026-04-11 01:06 AM ET. Avatar swapped to `842f20b75ce242aea397f5030aa018aa`, OVERLAY_ZONE flipped to top-right `x=1240`, logo moved to top-left `x=20`, TICKER_MAP paths gained `tools/` prefix.

**Cline confirmation:** ✅ CONFIRMED shipped as `0d13fb0`. Avatar swapped, OVERLAY_ZONE x=1240, LOGO_POS x=20, TICKER_MAP tools/ prefix — all verified in server.js grep.

### Handoff 2 — `CLINE_HANDOFF_GATE2_SEGMENT_STRUCTURE.md`

**Claude Code's belief:** ✅ Shipped as commit `a1439b6` on 2026-04-11 02:47 AM ET. `parseSegments_v2` with `USE_PARSE_SEGMENTS_V2` flag, `gate2_validateSegmentStructure` 6-check validator, `handleGate2Failure` fix loop, `POST /gate-fix-log` endpoint.

**Cline confirmation:** ✅ CONFIRMED shipped as `a1439b6`. parseSegments_v2, gate2_validateSegmentStructure (6 checks), handleGate2Failure, POST /gate-fix-log — all in server.js.

### Handoff 3 — `CLINE_HANDOFF_GEMINI_CLIP_ANALYSIS_TRUNCATION_FIX.md`

**Claude Code's belief:** ✅ Shipped as commit `8929a47` on 2026-04-11 09:21 AM ET. `geminiAnalyzeClip()` maxOutputTokens raised 500→2000 (Cline went slightly higher than my recommended 1500 — fine). Smoke test verified Gate 1 100/100 on attempt 1/3.

**Cline confirmation:** ✅ CONFIRMED shipped as `8929a47`. maxOutputTokens raised 500→2000. Smoke test verified Gate 1 100/100 on attempt 1/3.

### Handoff 4 — `CLINE_HANDOFF_TWITCH_INTRO_CARD_TO_TV_DESIGN.md`

**Claude Code's belief:** ✅ Shipped in a pending commit around 2:10 PM ET (STATUS.md row 71). `generateIntroCardPNG()` rewritten from 720×840 circle to 1280×720 TV rectangle with image-left/text-right layout (my Option A). `lib/config.js` `CONFIG.INTRO_CARD` keys updated. **But:** the visual rendering appears to be coming out squished because the downstream FFmpeg filter at server.js:3754/3904 still hardcodes `scale=360:-1` — which produces 360×203 instead of the intended 640×360. This handoff (Part 2 Change #2) fixes that follow-up bug.

**Cline confirmation:** ✅ CONFIRMED shipped as `6028820`. generateIntroCardPNG() rewritten to 1280×720 TV rectangle (verified in server.js line 567: W=1280, H=720). The squished rendering bug (360×203) was caused by hardcoded scale=360:-1 in server.js:3754/3904 — fixed in this handoff (commit `33ed559`) by reading from CONFIG.VISUAL_LAYOUTS.LONG_FORM.OVERLAY_ZONE.

### Handoff 5 — `CLINE_HANDOFF_GATE1_CLIP_DIAGNOSTIC_UPGRADE.md`

**Claude Code's belief:** 🟡 **NOT YET SHIPPED.** This is Phase 2 of the gated pipeline — upgrade Gate 1's clip availability report from generic "not in this episode" to 9 specific failure modes with per-cause fix suggestions. Lower priority than Phase 1 which is now done. Rob hasn't requested ship yet.

**Cline confirmation:** 🟡 CONFIRMED still pending. Not yet shipped. Rob will request when ready.

### Once confirmed, I'll archive the shipped handoffs

After Cline confirms handoffs 1-4 are shipped, I'll move them to `docs/archive/` in a separate docs-only commit, leaving only genuinely-active handoffs in the repo root:
- `CLINE_HANDOFF_GATE1_CLIP_DIAGNOSTIC_UPGRADE.md` (still pending, keep active)
- `CLINE_HANDOFF_LAYOUT_DIMENSIONS_AND_HANDOFF_CONFIRMATION.md` (this doc — active until Cline ships Part 2)
- `CLINE_HANDOFF_NBA_INTRO_CARD.md` (needs separate confirmation — was that ever shipped?)
- Anything else actively in flight

---

## Part 6 — Why this works (teaching section)

### Why the scale filter bug happened

`generateIntroCardPNG()` was rewritten from producing a 720×840 canvas (circle design) to a 1280×720 canvas (TV rectangle). But the downstream FFmpeg overlay command at `server.js:3754` hardcoded `scale=360:-1:flags=lanczos` — which means "scale to 360 wide, auto-calculate height to preserve aspect."

- From old 720×840 source: `scale=360:-1` → 360×420 (tall)
- From new 1280×720 source: `scale=360:-1` → 360×203 (short, 16:9 ratio)

The hardcoded 360 width was correct for the old 720×840 canvas (where it produced 360×420 as intended). When the canvas changed, the filter's output dimensions changed automatically — but nobody updated the filter to match the new target size.

### Why config-driven is the right fix

Hardcoding `scale=840:472` would fix the immediate bug, but:
1. If Rob decides later he wants 900×506 (or back to 640×360), it's ANOTHER 2-line edit in `server.js`
2. NBA and News cards use the same filter path — they'd all need to match
3. `lib/config.js` already has `OVERLAY_ZONE.w` and `.h` — make it the source of truth

By having the FFmpeg filter read from `CONFIG.VISUAL_LAYOUTS.LONG_FORM.OVERLAY_ZONE`, any future dimension change is a single edit in `lib/config.js` and all downstream code picks it up automatically. Same pattern as `CONFIG.TICKER.HEIGHT` and `CONFIG.LOGO_POS`.

### Why 840×472 instead of sticking with 640×360

Rob reviewed the rendered TV card at its current (buggy) 360×203 size and explicitly requested bigger. His words: *"its too small when thinking about news and NBA."*

Three factors informed the 840×472 choice:
- **Width:** 840 gives 200 more pixels of horizontal space for NBA scores / news headlines / streamer facts
- **Position:** x=1040 puts the card's left edge at Bobby G's right shoulder — clears his face but uses more of the background
- **Margin:** 1920 - 1040 - 840 = 40 pixels right margin (matches the 40px left margin of the logo at x=80 for visual balance)
- **Aspect ratio:** 840:472 = 1.78 = exactly 16:9 (matches "TV shape" aesthetic)

### Why 72px ticker instead of 80 or 100

I initially proposed 80px as a conservative bump. Rob reviewed the 100px variant (`variant3_B_ticker100.jpg`) and saw the ticker crowding Bobby G's hands. Settled on **72px** as the middle ground:
- +12.5% from current 64px (noticeable)
- Still clears Bobby G's gesture zone (hands at ~y=900-970, ticker starts at y=1008, 38px clearance)
- Easier on mobile viewing without dominating the frame

Can always increase later if Rob finds 72 still too small in production.

### Why move the logo up and to the right

The new avatar (`842f20b75ce242aea397f5030aa018aa`) has Bobby G's microphone arm extending from the bottom-left upward through the top-left region of the frame, peaking around y=80-150. The original logo position (20, 20, 120) put the bottom edge of the logo at y=96 — directly intersecting the mic arm's curve.

Moving to (80, 10, 100):
- **x: 80** — 60px further right, past the leftmost vertical of the arm
- **y: 10** — 10px closer to top, the logo's bottom edge is now at y=66 (10+56 for 100px wide × 9:16 aspect), just above the mic arm's peak
- **size: 100** — 20px smaller, reduces the total pixel area that could overlap

Result: logo sits in the corner, above and right of the mic, clean visual.

---

## Part 7 — What NOT to touch

- **DO NOT** change `SHORT_FORM.LOGO_POS` — short-form is 9:16 portrait, different composition, not affected by this handoff
- **DO NOT** change `CONFIG.INTRO_CARD` dimensions (1280×720 canvas) — that's the SOURCE canvas for the PNG generation, NOT the overlay burn target. The overlay filter scales it down.
- **DO NOT** try to update the TV card on-screen duration — `DURATION_SECONDS: 3.5` is unchanged
- **DO NOT** touch short-form ticker handling — short-form doesn't use a ticker per `VISUAL_DESIGN_SPEC.md`
- **DO NOT** modify the server-side `/burn-streamer-intro` test endpoint — it's a diagnostic tool, keep the contract
- **DO NOT** change the `-ov.x:-ov.y` reference syntax to pass args other than config values — keep it simple, one source of truth

---

## Part 8 — Commit message template

```
feat(layout): TV card 640×360→840×472, logo repositioned, ticker 64→72, config-driven FFmpeg filters

Polish pass after 3rd smoke test visual review. Rob approved the video's
content (Gate 1 100/100, full-bleed avatar, correct intro card/logo/ticker
positioning) but flagged three dimension tweaks:

1. TV card was rendering at 360×203 due to hardcoded scale=360:-1 FFmpeg
   filter — Rob wanted the card enlarged for NBA scores/news headlines
2. Logo overlapped the new avatar's microphone arm at (20, 20)
3. Ticker at 64px felt too small on TV/mobile viewing

Changes:

lib/config.js (VISUAL_LAYOUTS.LONG_FORM):
- OVERLAY_ZONE: {x:1240, y:40, w:640, h:360} → {x:1040, y:100, w:840, h:472}
  (31% larger area, 16:9 ratio, left edge clears Bobby G's shoulder)
- LOGO_POS: {x:20, y:20, size:120} → {x:80, y:10, size:100}
  (up and right to clear mic arm, slightly smaller)

lib/config.js (TICKER):
- HEIGHT: 64 → 72 (+12.5%, still clears Bobby G's gesture zone)

server.js:3754 + 3904 (TV card overlay burns):
- Replaced hardcoded `scale=360:-1:flags=lanczos ... overlay=x=1240:y=40`
  with config-driven `scale=${ov.w}:${ov.h} ... overlay=x=${ov.x}:y=${ov.y}`
- Source of truth is now lib/config.js OVERLAY_ZONE — future dimension
  changes require only a config edit

server.js:3957 (ticker overlay):
- Replaced hardcoded `overlay=x=0:y=H-64` with `y=H-${CONFIG.TICKER.HEIGHT}`
- Auto-propagates ticker height changes from config

server.js:4037 + 9308 (logo overlays):
- Replaced hardcoded `scale=120:-1 ... overlay=20:20` with config-driven
  `scale=${lp.size}:-1 ... overlay=${lp.x}:${lp.y}`
- Same config-driven pattern as TV card

Cache bust required (manual one-time step):
  rm -f tmp/ticker_*.mp4
  rm -rf tmp/ticker_frames_*

Previously cached ticker at 1920×64 must regenerate at 1920×72 before
next assembly run. nodemon auto-restart handles the in-memory TICKER_CACHE
reset on config change.

All 3 element changes apply uniformly to twitch/nba/news via the shared
CONFIG.VISUAL_LAYOUTS.LONG_FORM and CONFIG.TICKER objects.

Test plan:
- /burn-streamer-intro for jasontheween → verify PNG is 1280×720 source
- Jason 2-clip smoke test → verify MP4 shows 840×472 TV card at (1040,100),
  logo at (80,10,100), ticker at y=1008 (72px bar)
- Optional NBA 1-game smoke test for cross-content consistency

Rollback: git revert HEAD (or edit config values directly — config-driven
pattern means per-element rollback is a 1-line edit)

References: tmp/preview/FINAL_c2_ticker72.jpg (visual mockup Rob approved)

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
```

---

## Part 9 — Cline checklist

Before committing:

- [ ] `lib/config.js` — 3 changes (OVERLAY_ZONE, LOGO_POS, TICKER.HEIGHT)
- [ ] `server.js:3754` — TV card overlay filter reads from CONFIG.VISUAL_LAYOUTS.LONG_FORM.OVERLAY_ZONE
- [ ] `server.js:3904` — NBA/News TV card overlay filter reads from same CONFIG
- [ ] `server.js:3957` — ticker overlay filter reads from CONFIG.TICKER.HEIGHT
- [ ] `server.js:4037` — logo overlay filter reads from CONFIG.VISUAL_LAYOUTS.LONG_FORM.LOGO_POS
- [ ] `server.js:9308` (if that second logo overlay exists) — same config-driven update
- [ ] Run `rm -f tmp/ticker_*.mp4 && rm -rf tmp/ticker_frames_*` before committing
- [ ] `node --check server.js` passes (no syntax errors)
- [ ] `/burn-streamer-intro` test renders a 1280×720 PNG for jasontheween
- [ ] Atomic commit per Atomic Staging rule: single `git add ... && git commit -m "..." && git push` Bash call
- [ ] STATUS.md Last Agent Action row added (pre-commit hook requires it)
- [ ] Reply to Part 5 handoff confirmation checklist (commit hashes for shipped handoffs 1-4, or flag gaps)
- [ ] After push, nodemon auto-restarts; run Jason 2-clip smoke test (Test 2 in Part 3)
- [ ] Paste output MP4 path so Claude Code can visually verify the new dimensions

---

*Small, surgical, config-driven polish. ~1 hour of Cline work. Ship whenever convenient — not blocking anything critical. The 3rd smoke test was visually approved by Rob; this handoff just tightens the dimensions for better readability on NBA/news content.*
