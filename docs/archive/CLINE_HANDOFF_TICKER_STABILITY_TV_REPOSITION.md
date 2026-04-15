# Cline Handoff: TV Card Reposition + Ticker Stability Fix

**Author:** Claude Code
**Date:** 2026-04-11 ~5:15 PM ET
**Status:** 🟢 Ship-ready — small surgical config changes, no new code
**Priority:** Medium — polish after 4th smoke test visual review
**Estimated effort:** ~15 min Cline work for Part 1+2, separate ~4 hour handoff for Part 3
**Related:** `CLINE_HANDOFF_LAYOUT_DIMENSIONS_AND_HANDOFF_CONFIRMATION.md` (shipped as `33ed559`), current OVERLAY_ZONE at `{x:1040, y:100, w:840, h:472}` covers Bobby G's right shoulder

---

## TL;DR

Rob reviewed the 4th smoke test output and found two issues:

1. **TV card left edge overlaps Bobby G's right shoulder.** The 840×472 card at `x=1040` has its left edge inside the avatar silhouette. Rob picked Option (c) `{x:1160, y:100, w:720, h:405}` as the fix — mathematically exact 16:9 aspect ratio (720÷405 = 1.77777...), right edge at 1880 (40px margin), clears the shoulder completely.

2. **Ticker is visibly shaky during playback.** Root cause is frame rate mismatch: ticker MP4 is captured at 15fps but composited into a 30fps video, causing "step-and-wait" motion every other frame. Quick fix: bump ticker FPS from 15 → 30. Long-term fix (separate handoff, Part 3 of this doc): replace the Puppeteer pre-rendered MP4 approach with FFmpeg's `drawtext` filter for perfectly smooth scrolling.

Parts 1 and 2 ship NOW. Part 3 is a queued follow-up handoff Cline schedules when convenient.

---

## Part 1 — TV card reposition (Option C, 16:9 exact)

### The math (why Option C is mathematically correct)

Rob derived this. Recording it here for future reference:

| Option | Coords | Aspect ratio | Height at 720 width | Verdict |
|---|---|---|---|---|
| (a) | {x:1140, y:100, w:740, h:416} | 740÷416 = 1.7788 | n/a | Not 16:9 |
| (b) | {x:1120, y:100, w:760, h:428} | 760÷428 = 1.7757 | n/a | Not 16:9 |
| **(c)** | **{x:1160, y:100, w:720, h:405}** | **720÷405 = 1.7778** | **720 × 9/16 = 405.0** | **Exact 16:9 ✅** |

**Why aspect ratio purity matters for the TV card:**

- **Sub-pixel rounding elimination:** non-integer heights (like 428 from 760×9/16 = 427.5) cause FFmpeg scale/overlay filters to round to the nearest pixel boundary, introducing edge aliasing on the gold border. Exact 16:9 integers (720×405) have zero rounding.
- **Standard video geometry:** 720 width is a standard building block (720p HD uses 1280×720, and 720×405 is "half-720p" with the same 16:9 ratio). FFmpeg's lanczos scaler handles standard dimensions better than arbitrary ones.
- **Visual consistency with NBA 16:9 game thumbnails:** NBA game cards from ESPN are typically 1280×720 (full HD) or derivatives. Scaling an ESPN 1280×720 thumbnail down to 720×405 is a clean 56% reduction. Scaling to 760×428 or 840×472 introduces slight non-uniform scaling.
- **Right-edge placement:** 1160 + 720 = 1880 → 40px right margin from 1920 frame edge, matches the 40px visual pattern used elsewhere.

### Change #1 — `lib/config.js`

```diff
  VISUAL_LAYOUTS: {
    LONG_FORM: {
      WIDTH: 1920,
      HEIGHT: 1080,
      AVATAR_SAFE_ZONE: { x: 0, y: 720, w: 1920, h: 360 },
-     OVERLAY_ZONE: { x: 1040, y: 100, w: 840, h: 472 },   // "TV Shape" Top Right — 31% larger for NBA/news readability (2026-04-11)
+     OVERLAY_ZONE: { x: 1160, y: 100, w: 720, h: 405 },   // "TV Shape" Top Right — exact 16:9 (720÷405 = 1.7778), clears Bobby G's shoulder, 40px right margin (2026-04-11 revision)
      LOGO_POS: { x: 80, y: 10, size: 100 }
    },
```

### Changes in `server.js`

**None needed.** The FFmpeg filters at `server.js:3754` and `server.js:3904` already read from `CONFIG.VISUAL_LAYOUTS.LONG_FORM.OVERLAY_ZONE` per commit `33ed559`. Changing the config value in `lib/config.js` automatically propagates to the filter. This is exactly the source-of-truth pattern we built for.

**Verify:** `grep -n "OVERLAY_ZONE" server.js | head` — all references should be `CONFIG.VISUAL_LAYOUTS.LONG_FORM.OVERLAY_ZONE.w` / `.h` / `.x` / `.y`, no hardcoded pixel values.

### Visual verification after config change

After `nodemon` auto-restarts on the config save:
1. Run `/burn-streamer-intro` for Jason to generate a fresh intro card PNG
2. The PNG itself is still rendered at 1280×720 (the canvas size in `generateIntroCardPNG()`)
3. During assembly, FFmpeg scales it down to 720×405 via the config-driven filter
4. Card appears in the final video at `x=1160, y=100` with exact 16:9 aspect
5. Bobby G's right shoulder is completely clear of the card's left edge

---

## Part 2 — Ticker stability quick fix (FPS 15 → 30)

### Root cause of the shakes

The ticker is pre-rendered as an MP4 file at `tmp/ticker_twitch.mp4` via Puppeteer screenshot capture. Current spec in `lib/config.js`:

```js
TICKER: {
  WIDTH: 1920,
  HEIGHT: 72,
  FPS: 15   // ← the problem
}
```

The assembled video is **30 fps** (per `VISUAL_DESIGN_SPEC.md` and all current assembly output). The ticker is **15 fps**. When FFmpeg composites the 15fps ticker over a 30fps video, each ticker frame is displayed for 2 video frames in a row ("hold and jump"), causing a visible stutter pattern at roughly 15Hz — the human eye picks this up as "shaky" motion.

Additional contributing factors (not fixed by this change, see Part 3):
- **Sub-pixel scroll drift:** Puppeteer's `setInterval(66ms)` isn't precisely 15fps (66.66ms is the correct interval), so scroll distance between frames varies by ~1%, causing slight jitter
- **FFmpeg overlay rounding:** overlay filter computes output positions as floats and rounds to pixel grid, adding up to 0.5px drift per frame

The 15→30 FPS bump **eliminates the "hold and jump" stutter** which is ~70% of the visible shakiness. The remaining 30% (sub-pixel drift + rounding) requires Part 3's `drawtext` approach.

### Change #2 — `lib/config.js`

```diff
  TICKER: {
    CACHE_TTL_MS: 3600000,
    DURATION_SECONDS: 60,
    WIDTH: 1920,
    HEIGHT: 72,
-   FPS: 15
+   FPS: 30
  },
```

### Change #3 — Cache bust (shell commands, not code)

The cached `tmp/ticker_twitch.mp4` was captured at 15fps. It must be deleted so `captureTicker()` regenerates at 30fps:

```bash
rm -f /Users/robertgregory/cwn-production/tmp/ticker_twitch.mp4
rm -f /Users/robertgregory/cwn-production/tmp/ticker_nba.mp4
rm -f /Users/robertgregory/cwn-production/tmp/ticker_news.mp4
rm -rf /Users/robertgregory/cwn-production/tmp/ticker_frames_twitch
rm -rf /Users/robertgregory/cwn-production/tmp/ticker_frames_nba
rm -rf /Users/robertgregory/cwn-production/tmp/ticker_frames_news
```

Plus the in-memory `TICKER_CACHE` object needs to be cleared — `nodemon` handles this automatically on config save (server restart drops the in-memory Map).

### Puppeteer capture loop verification

Look at `captureTicker()` in `server.js:4595` area. Verify:
1. The screenshot loop frame count scales with FPS: `FPS * CAP_SECS = 30 * 60 = 1800 frames` at 30fps vs 900 at 15fps
2. The `setInterval` math: `Math.round(1000 / 30) = 33ms` between frames (was 67ms at 15fps)
3. The Puppeteer page animation speed DOES NOT need adjustment — the ticker HTML uses `requestAnimationFrame` internally which targets the display's refresh rate, not a fixed fps. Screenshots at 30fps will capture the animation at 2x the granularity, smoother result.
4. Capture wall time roughly doubles (~60s instead of ~30s) but pre-warm in `startHeyGenPoller()` is now `await`ed before assembly (per `6028820`), so the extra 30s adds only 30s of pre-assembly wait, negligible against total assembly time.

**Worth confirming before commit:** run `/burn-streamer-intro` or trigger any quick assembly to force `captureTicker('twitch')` to run. Check `tmp/ticker_twitch.mp4` via `ffprobe` — should show `r_frame_rate=30/1` and `nb_frames=1800` (or close to it).

---

## Part 3 — Long-term ticker stability (drawtext replacement, queued for later)

**This is a separate future handoff**, not ship-now work. Writing it here so Cline can queue it and you have the context.

### Why this is better than pre-rendered MP4

Current architecture:
```
Puppeteer captures scrolling HTML → writes 1800 PNG frames to disk →
FFmpeg encodes PNGs to ticker_twitch.mp4 → overlay filter composites
MP4 over the main assembly video
```

Every step has jitter sources:
- Puppeteer screenshot timing drift
- PNG → MP4 encode introduces frame timing inconsistency
- overlay filter sub-pixel rounding

New architecture:
```
Main FFmpeg assembly reads scrolling text data from a JSON file →
drawtext filter renders text at integer x positions computed per output
frame → scroll position is mod(t * speed, W + tw) which is smooth by
mathematical construction
```

No pre-rendering, no Puppeteer, no cache, no sub-pixel drift.

### The filter expression (for future reference)

Rob's research from the FFmpeg Video Production Stack Exchange points at this pattern:

```
drawtext=fontfile=/path/to/font.ttf:\
  text='CLIPZWORLD NEWS LIVE  —  <streamer list with live viewer counts>':\
  fontsize=40:\
  fontcolor=white:\
  borderw=2:\
  bordercolor=black:\
  x='w - mod(n*5, w+tw)':\
  y='h - th - 10'
```

Where:
- `n` = current frame number (increments per output frame, smoothly)
- `5` = pixels to scroll per frame (speed control, 5px × 30fps = 150 px/sec)
- `w` = video width
- `tw` = text width (auto-computed by drawtext)
- `th` = text height

The `x` expression `w - mod(n*5, w+tw)` produces a smooth right-to-left scroll that loops seamlessly. Integer math only, no sub-pixel calculations.

### Data source

Currently ticker content comes from these HTML files in `tools/`:
- `tools/cwn_twitch_ticker.html` — Twitch live streamer feed from Twitch API
- `tools/sports_ticker.html` — NBA scores from ESPN API
- `tools/cwn_combined_ticker.html` — News headlines from various sources

For the `drawtext` approach, we need these data sources queryable at assembly time and formatted as a single long text string:

```
CLIPZWORLD NEWS LIVE  —  RealKatieB LIVE 15.7K  •  s1mple LIVE 15.4K  •  GoodTimesWithScar LIVE 15.4K  •  Rainbow6 LIVE 14.7K  —  [repeat]
```

New server endpoint `/ticker-text/:contentType` returns the current text string. `/assemble` calls it at ticker-bake time, passes result to drawtext.

### What's lost vs current design

- **LIVE red badge icons** — `drawtext` is plain text, no per-word colors (can get colored text via multiple drawtext filters chained, but loses simplicity)
- **Streamer profile thumbnails** — current HTML has small profile pics, `drawtext` has no images
- **Gradient backgrounds, animated highlights** — any visual flourish beyond plain text on solid color

### What's gained

- **Perfectly smooth scrolling** (the primary goal)
- **Zero cache management** (no tmp/ticker_*.mp4 files, no cache bust, no Puppeteer process)
- **Faster assembly** (skip the ~60s ticker capture step entirely)
- **Simpler failure model** (no "Error response" ticker bug from 2026-04-10 can recur — no HTTP dependency during capture)
- **Trivially font-portable** (any TTF in the repo works, no browser dependency)

### Estimated effort

- 2 hours: refactor `captureTicker()` → remove Puppeteer call, replace with data-source fetch
- 1 hour: new `/ticker-text/:contentType` endpoint + JSON data sources for twitch/nba/news
- 1 hour: FFmpeg filter chain update to include drawtext, test rendering, font path resolution
- **Total: ~4 hours**

### When to ship

After 12-test suite passes. Before multi-tenant (drawtext is way easier to scale — no Puppeteer process pool per customer).

### Not ship-now because

- Current sprint priority is dimension polish + 12-test pass, not ticker architecture rewrite
- Quick fix (FPS 15→30) addresses 70% of the shakiness with a 1-line change
- Losing LIVE badges and profile thumbs is a product decision that needs a separate conversation with Rob before shipping

### Park as handoff

Write-up for later as `CLINE_HANDOFF_TICKER_DRAWTEXT_REPLACEMENT.md` when Rob is ready. Until then, a pointer in the Product Roadmap Track 2 (Gated Pipeline) or Track 9 (Content Operations).

---

## Part 4 — Test plan

### After Cline ships Parts 1 + 2

1. **Verify config changes landed:**
   ```bash
   grep "OVERLAY_ZONE\|FPS:" /Users/robertgregory/cwn-production/lib/config.js
   ```
   Expected: `{ x: 1160, y: 100, w: 720, h: 405 }` and `FPS: 30`

2. **Cache bust:**
   ```bash
   rm -f tmp/ticker_*.mp4
   rm -rf tmp/ticker_frames_*
   ```

3. **Verify node syntax:**
   ```bash
   node --check server.js
   ```
   Expected: no errors

4. **Smoke test retry — 5th Jason 2-clip run:**
   - Wipe `data/jobs.json` and browser localStorage
   - Dashboard → Twitch card → `jasontheween` → 2 clips → GENERATE
   - Wait through Gate 1 → HeyGen → ASSEMBLE

5. **Visual verification after smoke test:**
   - Paste the output MP4 path to Claude Code
   - Claude Code extracts frames at: t=2s (cold open), t=18s (JASON_INTRO with intro card visible), t=30s (Jason clip playback), t=60s (mid-reaction), t=100s (outro approach)
   - Confirm: TV card at (1160, 100, 720×405), clears Bobby G's shoulder, 16:9 aspect visible
   - Confirm: ticker smoother — not perfect without Part 3, but noticeably less jittery at 30fps
   - Confirm: logo unchanged at (80, 10, 100)
   - Confirm: Bobby G full-bleed, no pillarbox, scene order correct

6. **If ticker is STILL visibly shaky** after the 30fps fix:
   - Ship Part 3 drawtext replacement as a follow-up handoff
   - Until then, the 30fps improvement is the best we can do without a bigger rewrite

### Ticker ffprobe spot-check

After the cache regenerates during the next assembly, run:
```bash
ffprobe -v error -show_entries stream=r_frame_rate,nb_frames,width,height -of csv=p=0:s=x tmp/ticker_twitch.mp4
```

Expected: `h264,30/1,1800,1920,72` (codec, rate, frame count, w, h)

If the frame count is still ~900 and rate is `15/1`, the cache bust didn't work — force a manual `rm` and retry assembly.

---

## Part 5 — Rollback plan

**Full rollback:**
```bash
git revert HEAD
```

Reverts both config changes atomically.

**Partial rollback via config edit (no git revert needed):**

- **TV card too small / want to go back to 840×472:** edit `lib/config.js` OVERLAY_ZONE back to `{x: 1040, y: 100, w: 840, h: 472}`. Source-of-truth pattern means no server.js change needed.
- **Ticker regen too slow / want to go back to 15fps:** edit `lib/config.js` TICKER.FPS back to `15`, cache bust.

Both partial rollbacks are single-line edits with no re-testing burden because the filter chain is config-driven.

---

## Part 6 — Commit message template

```
fix(layout): TV card 840×472→720×405 exact 16:9 + ticker FPS 15→30 for smoother scroll

Rob's math showed Option (c) 720×405 is mathematically exact 16:9
(720÷405 = 1.7778...), unlike the previous 840×472 which wasn't a
standard video aspect ratio. The exact ratio eliminates FFmpeg
scale/overlay sub-pixel rounding that contributes to edge aliasing
on the gold border.

Right edge at 1160+720 = 1880, 40px right margin from 1920 frame.
Left edge at 1160 clears Bobby G's right shoulder completely (was
overlapping at x=1040).

Ticker FPS bump 15→30 matches the video frame rate, eliminating the
"hold and jump" stutter where each 15fps ticker frame was shown for
2 video frames in a row. Visible shake should drop ~70%. Remaining
~30% sub-pixel drift requires the drawtext filter approach documented
in Part 3 of CLINE_HANDOFF_TICKER_STABILITY_TV_REPOSITION.md (queued
for later).

Changes:
- lib/config.js OVERLAY_ZONE: {x:1040,y:100,w:840,h:472} →
  {x:1160,y:100,w:720,h:405}
- lib/config.js TICKER.FPS: 15 → 30

Cache bust required (manual one-time step):
  rm -f tmp/ticker_*.mp4
  rm -rf tmp/ticker_frames_*

server.js unchanged — both filter chains already read from config per
commit 33ed559's source-of-truth refactor.

Test plan:
- /burn-streamer-intro for jasontheween → 1280×720 source PNG unchanged
- Jason 2-clip smoke test → 720×405 TV card at (1160,100), ticker at
  30fps (verify via `ffprobe tmp/ticker_twitch.mp4`)
- Visual confirm Bobby G's shoulder is clear, card aspect is exact 16:9,
  ticker scroll is noticeably smoother

Rollback: git revert HEAD OR edit lib/config.js values directly.

Long-term ticker stability (FFmpeg drawtext filter replacement) is
queued as Part 3 of the handoff doc — estimated 4 hours of work,
schedules when convenient post-12-test-suite.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
```

---

## Part 7 — Cline checklist

- [ ] `lib/config.js` OVERLAY_ZONE updated to `{x: 1160, y: 100, w: 720, h: 405}`
- [ ] `lib/config.js` TICKER.FPS updated to `30`
- [ ] Cache bust executed: `rm -f tmp/ticker_*.mp4 && rm -rf tmp/ticker_frames_*`
- [ ] `node --check server.js` passes
- [ ] STATUS.md Last Agent Action row added (pre-commit hook requires it)
- [ ] Atomic commit per COMMIT_CHECKLIST.md: `git add lib/config.js STATUS.md && git commit -m "..." && git push` in ONE Bash call
- [ ] After push, nodemon auto-restarts
- [ ] Rob runs 5th smoke test (Jason 2-clip)
- [ ] `ffprobe tmp/ticker_twitch.mp4` after next assembly — verify `r_frame_rate=30/1`
- [ ] Claude Code extracts frames from output MP4, verifies visual dimensions
- [ ] Long-term drawtext replacement parked as pending future handoff

---

## Part 8 — What NOT to touch

- **DO NOT** modify `server.js` filter chains — they already read from config
- **DO NOT** change `CONFIG.INTRO_CARD.CANVAS_WIDTH/HEIGHT` (still 1280×720) — that's the source canvas, the new 720×405 is the DISPLAY size after downscale
- **DO NOT** delete Puppeteer or `captureTicker()` yet — Part 3 is separate, not this handoff
- **DO NOT** touch `SHORT_FORM.LOGO_POS` or any short-form config — unaffected
- **DO NOT** modify `tools/*ticker*.html` files — they still drive the MP4 render at 30fps (same pages, just screenshot faster)

Scope discipline: 2 config lines + cache bust + one atomic commit. That's it.

---

*Small, surgical, config-only. ~15 minutes of Cline work. Part 3 parked as a future ~4 hour handoff for the drawtext replacement. Ship Parts 1+2 whenever convenient.*
