# Cline Handoff: Migrate Twitch Intro Card from Circle → TV Rectangle

**Author:** Claude Code
**Date:** 2026-04-11
**Status:** 🟡 Design spec change — brand consistency fix, small surgical migration
**Priority:** Medium — ships after Gate 2 smoke test is verified, NOT blocking that test
**Estimated effort:** 1-2 hours Cline work, single atomic commit
**Related:** `GATED_PIPELINE_ARCHITECTURE.md` → "Intro card design by content type", `CLAUDE.md` gotcha #6

---

## TL;DR

Rob reversed the Twitch intro card spec on 2026-04-11 morning. **All 3 content types (Twitch, NBA, News) now use the same 640×360 TV-rectangle design** for brand consistency. Previously Twitch used a circle-with-profile-PNG design rendered on a 720×840 canvas. NBA and News already use the TV rectangle. This handoff migrates Twitch to match.

**Why:** consistent TV-card aesthetic across all content types. Viewers scanning a CWN feed should instantly recognize the brand regardless of vertical. Mixed designs (circle for Twitch, rectangle for others) fragment the visual identity.

**What:** rewrite `generateIntroCardPNG()` at `server.js:500-670` to produce a 640×360 TV rectangle (at 2× resolution = 1280×720 for sharpness), matching the NBA/News rendering dimensions.

**What stays the same:** source data (`data/streamers.json` roster), content fields (displayName/origin/fact/profileImage), burn-in position (`OVERLAY_ZONE` top-right at `x=1240, y=40, 640×360`), gold border (5px `#c7af4f`), drop shadow, when the card appears (at STREAMER_INTRO scenes for 3.5s per `CONFIG.INTRO_CARD.DURATION_SECONDS`).

**What changes:** canvas dimensions, layout (circle-below-text → image-alongside-text inside rectangle), visual design.

---

## Part 1 — Current state (what the code produces today)

### Function: `generateIntroCardPNG()` at `server.js:500-670`

Current behavior:
- **Canvas:** 720×840 (portrait-ish, 2× resolution of a 360×420 final)
- **Design:** Circle (160px radius) centered horizontally, profile image clipped inside, gold ring (#c7af4f), drop shadow
- **Text below circle:**
  - Line 1 (name): 68pt Arial Bold, gold (#c7af4f)
  - Line 2 (origin): 44pt white
  - Line 3 (fact): 36pt grey (#aaaaaa), italic
- **Output:** PNG file for FFmpeg overlay burn
- **Size:** roughly 400-800KB per card

### Where it's called from

`server.js:3633-3686` inside the `/assemble` endpoint's segment normalization loop:

```javascript
if (isIntro && contentType === 'twitch' && streamerRoster.length) {
  // Finds streamer data matching the segment label (e.g. JASON_INTRO → Jason)
  const streamerData = streamerRoster.find(...)
  // Calls generateIntroCardPNG(streamerData, outputPath, 'cwn')
  // Burns PNG via FFmpeg overlay at x=1240:y=40 for 3.5s
}
```

### How NBA and News render their cards (the target design)

NBA cards: rendered via Puppeteer screenshot of `templates/nba_thumbnail_generator.html` or similar, outputting a 640×360 PNG with game data. Burned at the same `OVERLAY_ZONE` position.

News cards: Open Graph scraped article image + headline + source, formatted as a 640×360 rectangle, burned at `OVERLAY_ZONE`.

Both NBA and News use the same burn-in path in `/assemble` — the difference from Twitch is that they already produce 640×360 output, while Twitch produces 720×840.

---

## Part 2 — Target design for Twitch TV card

### Dimensions

- **Canvas:** 1280×720 (2× resolution of final 640×360 for sharpness)
- **Final output:** 640×360 after FFmpeg `scale=360:-1:flags=lanczos` in the overlay burn chain (same scaling as NBA/News)
- **Aspect ratio:** 16:9 (TV shape)

### Layout (inside the 1280×720 canvas)

```
┌──────────────────────────────────────────────────────────┐  y=0
│                                                          │
│  ┌──────────────┐   JASON                                │
│  │              │   Arlington                            │
│  │   Profile    │   Dep Gai guy                          │
│  │   Image      │                                        │
│  │   (square    │                                        │
│  │   or circle  │                                        │
│  │   inside     │                                        │
│  │   rectangle) │                                        │
│  │              │                                        │
│  └──────────────┘                                        │
│                                                          │
└──────────────────────────────────────────────────────────┘  y=720
```

**Two possible sub-layouts** — Cline to pick whichever renders cleaner:

**Option A — Image left + text right (my recommendation):**
- Profile image: square 600×600 on the left, 60px margin from edges, clipped to rounded square OR circle inside the rectangle
- Text: name (120pt gold), origin (80pt white), fact (64pt grey italic) stacked vertically on the right, left-aligned, 80px margin from center
- Rationale: matches the "over-the-shoulder news graphic" aesthetic, works well for text-heavy content

**Option B — Image top + text bottom:**
- Profile image: full width 1280px (or 1000px centered), top ~60%
- Text: overlaid on a semi-transparent gold bar at the bottom ~40%
- Rationale: matches the NBA card pattern more closely (image-dominant), easier to see the streamer's face

**Pick whichever you think looks cleaner.** I'd slightly prefer Option A because it keeps the face prominent AND the text readable, and the layout matches most news broadcasts. But Option B has more visual similarity to the NBA cards. Either is acceptable.

### Border and shadow (must match NBA/News exactly)

- **Gold border:** 10px `#c7af4f` (at 2× resolution of final 5px)
- **Drop shadow:** `0 8px 30px rgba(0, 0, 0, 0.5)` (at 2× resolution)
- **Corners:** 0px border radius (sharp corners for TV look), OR 12-16px for slight rounding — match whatever NBA/News use

### Typography (scale up to match 2× resolution)

| Element | Font | Size (2× resolution) | Color |
|---|---|---|---|
| Name (displayName) | Arial Bold or Bebas Neue | 136pt | Gold `#c7af4f` |
| Origin | Arial Regular | 88pt | White `#ffffff` |
| Fact | Arial Italic | 64pt | Light grey `#aaaaaa` |

If you use Option B (image top + text bottom), reduce the font sizes proportionally so the bottom bar is readable.

---

## Part 3 — The code change

### File: `server.js`
### Function: `generateIntroCardPNG()` at lines 500-670
### Scope: complete rewrite of the function body, keep the signature

Current signature:
```javascript
async function generateIntroCardPNG(streamerData, outputPath, variant = 'cwn') {
```

**Keep this signature.** Callers at server.js:3642 pass `streamerData`, `cardPngPath`, and optionally a variant — don't break their contract.

### New function body (pseudocode — Cline writes the actual Node Canvas code)

```javascript
async function generateIntroCardPNG(streamerData, outputPath, variant = 'cwn') {
  const canvasModule = require('canvas');
  const { createCanvas, loadImage } = canvasModule;

  // ── Dimensions (2x resolution for sharpness, matching NBA/News pattern) ──
  const W = 1280, H = 720;  // CHANGED FROM 720x840
  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext('2d');

  // Sanitize text strings (unchanged from current)
  const name   = (streamerData.displayName || streamerData.name || '').toUpperCase();
  const origin = (streamerData.origin  || '');
  const fact   = (streamerData.fact    || '');

  // Load profile image (unchanged logic — try local then remote)
  const profileImage = await loadProfileImage(streamerData);  // extract existing image-loading code

  // ── Paint background ────────────────────────────────
  // Dark slate background (#1a1a1a) matching CWN brand
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(0, 0, W, H);

  // ── Option A: Image left + text right layout ───────
  // Profile image: 600x600 square clipped to rounded rect, left side
  const imgSize = 600;
  const imgX = 60;
  const imgY = (H - imgSize) / 2;  // vertical center
  ctx.save();
  // Optional: clip to rounded rect for soft corners
  roundRect(ctx, imgX, imgY, imgSize, imgSize, 20);
  ctx.clip();
  ctx.drawImage(profileImage, imgX, imgY, imgSize, imgSize);
  ctx.restore();

  // Text column: right side
  const textX = imgX + imgSize + 80;  // start right of image with 80px gap
  const textY_name   = 240;
  const textY_origin = textY_name + 130;
  const textY_fact   = textY_origin + 110;

  ctx.textAlign = 'left';

  // Name (gold, bold)
  ctx.fillStyle = '#c7af4f';
  ctx.font = 'bold 136px Arial';
  ctx.shadowColor = 'rgba(0,0,0,0.8)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 4;
  ctx.fillText(name, textX, textY_name);

  // Origin (white)
  ctx.fillStyle = '#ffffff';
  ctx.font = '88px Arial';
  ctx.fillText(origin, textX, textY_origin);

  // Fact (grey italic) — may need auto-wrap if too long
  ctx.fillStyle = '#aaaaaa';
  ctx.font = 'italic 64px Arial';
  // Optional: wordwrap fact if it exceeds available width
  fillTextWrapped(ctx, fact, textX, textY_fact, W - textX - 60, 80);

  // ── Gold border (10px at 2x = 5px final) ──────────
  ctx.strokeStyle = '#c7af4f';
  ctx.lineWidth = 10;
  ctx.strokeRect(5, 5, W - 10, H - 10);

  // Save PNG
  const buf = canvas.toBuffer('image/png');
  await writeFileAsync(outputPath, buf);

  console.log(`[intro-card] ✅ TV card written: ${path.basename(outputPath)} (${name})`);
}

// Helper: rounded rectangle path
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Helper: word-wrap text to fit width
function fillTextWrapped(ctx, text, x, y, maxWidth, lineHeight) {
  const words = text.split(' ');
  let line = '';
  for (const word of words) {
    const test = line + word + ' ';
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line.trim(), x, y);
      line = word + ' ';
      y += lineHeight;
    } else {
      line = test;
    }
  }
  if (line) ctx.fillText(line.trim(), x, y);
}
```

### Don't forget

- **Keep the profile-image loading logic unchanged** (lines 516-598 current) — it handles local file fallbacks, remote URL loading, error cases. Just extract it into a helper function `loadProfileImage()` and call it from the new rewritten function.
- **Keep the same output path format** (the caller decides the filename via `cardPngPath` at line 3642).
- **Keep the `variant` parameter** even if you don't use it — future variants might be wanted.

### CONFIG update

Also update `lib/config.js` `CONFIG.INTRO_CARD` to reflect the new dimensions:

```javascript
INTRO_CARD: {
  // OLD (720x840 circle):
  // CANVAS_WIDTH: 720,
  // CANVAS_HEIGHT: 840,
  // CIRCLE_CENTER_Y: 330,
  // CIRCLE_RADIUS: 260,
  // NAME_FONT_SIZE: 68,
  // ORIGIN_FONT_SIZE: 44,
  // FACT_FONT_SIZE_START: 44,
  // FACT_FONT_SIZE_MIN: 28,

  // NEW (1280x720 TV rectangle):
  CANVAS_WIDTH: 1280,
  CANVAS_HEIGHT: 720,
  IMAGE_SIZE: 600,          // profile image square edge
  IMAGE_MARGIN: 60,         // left margin of image
  TEXT_GAP: 80,             // gap between image and text column
  NAME_FONT_SIZE: 136,      // 2x of final 68pt
  ORIGIN_FONT_SIZE: 88,     // 2x of final 44pt
  FACT_FONT_SIZE: 64,       // 2x of final 32pt
  BORDER_WIDTH: 10,         // 2x of final 5px gold border
  DURATION_SECONDS: 3.5     // unchanged
}
```

Remove the `CIRCLE_*` keys entirely — they're dead code after this migration.

---

## Part 4 — Test plan

### Test 1 — Render a single Twitch card in isolation

Use the existing test endpoint `/burn-streamer-intro` (documented in `CLAUDE.md` "Common Operations"):

```bash
curl -X POST http://localhost:3000/burn-streamer-intro \
  -H "Content-Type: application/json" \
  -d '{"streamer":"jasontheween"}'
```

This should write a PNG to `output/` (or `tmp/`, check the endpoint's output path). Open the PNG and visually verify:
- ✅ 1280×720 dimensions (`ffprobe` the PNG or just `file` it)
- ✅ Gold border (5px final)
- ✅ Jason's profile image on the left
- ✅ "JASON" in gold, "Arlington" in white, "Dep Gai guy" in grey italic on the right
- ✅ Drop shadow on the text
- ✅ Dark slate background

### Test 2 — Render in a full smoke test assembly

Run the Jason 2-clip smoke test:
1. Wipe `data/jobs.json`, clear localStorage
2. Generate Twitch with `jasontheween` only, 2 clips
3. FORCE ADVANCE past Gate 1 if needed (Task #14 still not fixed)
4. Send to HeyGen, wait for segments
5. Assemble
6. Extract frame from the output MP4 at the JASON_INTRO timestamp (~t=12-18s)
7. Verify the intro card visible in the top-right `OVERLAY_ZONE` is now a TV rectangle matching the test-1 PNG dimensions, NOT a circle

### Test 3 — Render multiple streamers (roster consistency)

Test that all streamers in `data/streamers.json` render correctly:

```bash
for streamer in jasontheween hasanabi adapt stableronaldo lacy marlon cinna yonnajay jaycinco extraemily; do
  curl -s -X POST http://localhost:3000/burn-streamer-intro \
    -H "Content-Type: application/json" \
    -d "{\"streamer\":\"$streamer\"}"
done
```

Open all 10 output PNGs and visually verify:
- Each shows the correct streamer's profile image
- Each has the right name/origin/fact text
- Text doesn't overflow the rectangle (streamers with long names or long facts may need word-wrap)
- No visual glitches

### Test 4 — Side-by-side comparison with NBA card

Render one NBA intro card via `/nba/generate-intro-card` (POST with a gameId) and one Twitch intro card via `/burn-streamer-intro` (POST with a streamer). Open them side-by-side. Verify:
- ✅ Same dimensions (640×360 final)
- ✅ Same gold border treatment
- ✅ Same overall visual aesthetic (both look like "CWN TV cards")
- ✅ Different internal content (NBA = game data, Twitch = streamer info)

If they don't feel consistent visually, adjust font sizes / spacing / margins in the Twitch rendering until they match.

---

## Part 5 — Rollback plan

If the new design looks worse than the circle (subjective judgment call):

**Full rollback:**
```bash
git revert HEAD
```

Reverts the entire Twitch TV migration atomically. Twitch reverts to the circle design.

**Partial rollback (feature flag):**
If you want to A/B test the circle vs TV designs:
1. Keep both `generateIntroCardPNG_v1_circle()` and `generateIntroCardPNG_v2_tv()` in the codebase
2. Add a feature flag: `const USE_TV_INTRO_CARD = true;` at the top of the module
3. Route calls based on the flag

This adds complexity but lets Rob visually A/B test without committing. **My vote: skip the A/B flag, just ship the TV design. If Rob hates it, revert.** Simpler is better.

---

## Part 6 — Why this works (teaching section)

### Why consistency beats distinctiveness

The original reasoning for the Twitch circle design was that streamers have strong personal branding (profile pictures, color themes) and a circle emphasizes the individual. But this fragments the CWN brand across content verticals — viewers see a circle for Twitch and a rectangle for NBA and think they're watching two different shows.

The reversal prioritizes **CWN as the umbrella brand** over individual streamer branding. The streamer's profile image still appears prominently inside the TV rectangle, so the personal branding element is preserved. What changes is the outer frame: consistent TV rectangle = consistent CWN identity.

### Why 640×360 (not 720×840)

- Matches NBA and News cards exactly
- Standard 16:9 ratio that reads as "TV" visually
- Fits comfortably in the top-right `OVERLAY_ZONE` without overlap
- Simpler Gate 4 detection logic (only one rectangle pattern to check, not a rectangle-OR-circle branch)

### Why image + text layout instead of just enlarged image

A full-width profile image in a 640×360 card leaves no room for origin/fact text, which are key brand elements from `streamers.json`. The "image on left, text on right" layout keeps both readable.

Could go "image top, text bottom" (Option B in Part 2) — matches NBA card layout more closely. Cline picks based on which renders cleaner visually after testing.

### Why keep the 2× resolution approach

The original 720×840 canvas was 2× the final 360×420 display size, rendered at high resolution then scaled down for sharpness. Same principle applies to 1280×720 canvas → 640×360 display. Don't render at 640×360 directly — the text will be blurry after FFmpeg's lanczos scaling.

### Relationship to other active handoffs

- **Gate 2 Phase 1** (`a1439b6` already shipped): unrelated to intro card design, orthogonal concern
- **Gate 4 (Phase 4, not yet built):** will check for consistent TV rectangle pattern across all 3 content types — this migration makes that check simpler
- **Task #14 Gemini truncation** (`b3602ae` handoff, pending ship): unrelated to intro cards
- **Task #18 Topaz ring removal:** unrelated to intro cards

None of those block or are blocked by this migration. Ship this one whenever convenient — it's small and self-contained.

---

## Part 7 — What NOT to touch

- **DO NOT** change the burn-in call site at `server.js:3642` unless the function signature changes. The caller passes `streamerData`, `cardPngPath`, and `variant` — keep accepting those.
- **DO NOT** touch the NBA or News intro card paths. They already produce TV rectangles correctly.
- **DO NOT** change `OVERLAY_ZONE` coordinates in `lib/config.js`. Already set correctly at `{x: 1240, y: 40, w: 640, h: 360}`.
- **DO NOT** change the FFmpeg overlay burn command at `server.js:3500` — it already scales to 360 wide with lanczos, which produces a 640×360 final from a 1280×720 source. That math still works.
- **DO NOT** delete any streamer data fields from `data/streamers.json` — the new design uses the same fields as the old one (displayName, origin, fact, profileImage).
- **DO NOT** change the `CONFIG.INTRO_CARD.DURATION_SECONDS` value — 3.5s is still the right duration.

---

## Part 8 — Commit message template

```
feat(intro-card): migrate Twitch from circle → TV rectangle for brand consistency

Rob reversed the Twitch intro card spec on 2026-04-11 morning: all 3 content
types (Twitch, NBA, News) now use the same 640×360 TV-rectangle design.
Previously Twitch used a 720×840 canvas with a circular profile-PNG-above-text
design while NBA/News used 640×360 TV rectangles. The reversal prioritizes
CWN umbrella brand consistency over individual streamer visual distinctiveness.

Changes:
- server.js:500-670 — rewrite generateIntroCardPNG() body:
  - Canvas changed from 720×840 → 1280×720 (2× resolution of final 640×360)
  - Layout changed from circle-above-text → image-alongside-text (Option A)
    inside a gold-bordered rectangle with drop shadow
  - Preserved: profile image loading logic, function signature, output PNG
    format, variant parameter (unused but reserved)
- lib/config.js CONFIG.INTRO_CARD — replace CIRCLE_* keys with TV rectangle
  dimensions (IMAGE_SIZE, IMAGE_MARGIN, TEXT_GAP, NAME/ORIGIN/FACT_FONT_SIZE,
  BORDER_WIDTH)

Unchanged:
- OVERLAY_ZONE position (top-right at x=1240 y=40)
- Burn-in FFmpeg filter (still scales 1280×720 → 640×360 via lanczos)
- DURATION_SECONDS (3.5s)
- Source data (data/streamers.json fields)
- NBA and News rendering (they were already correct)

Test plan:
- /burn-streamer-intro endpoint renders a single PNG, visually verified
- Full Jason 2-clip smoke test assembly produces a clean TV-rectangle card
- 10 streamer roster renders all correctly without text overflow
- Side-by-side comparison with NBA card confirms visual consistency

Rollback: git revert HEAD.

Unblocks: Gate 4 implementation (Phase 4 of Gated Pipeline) — detection logic
now only needs to recognize one rectangle pattern, not a rectangle-OR-circle
branch per content type.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
```

---

## Part 9 — Checklist for Cline

- [ ] `server.js:500-670` `generateIntroCardPNG()` body rewritten with 1280×720 canvas
- [ ] Profile image loading logic preserved (extracted to helper if needed)
- [ ] Gold border (10px at 2× = 5px final) on all 4 sides
- [ ] Drop shadow on text for readability
- [ ] Word-wrap on fact text (streamers with long facts don't overflow)
- [ ] `lib/config.js` `CONFIG.INTRO_CARD` updated with new dimensions, CIRCLE_* keys removed
- [ ] `node --check server.js` passes (no syntax errors)
- [ ] `/burn-streamer-intro` test renders a valid PNG for jasontheween
- [ ] Visual inspection: the PNG looks like a TV card, matches NBA/News aesthetic
- [ ] All 10 active streamers render cleanly
- [ ] STATUS.md Last Agent Action row added (pre-commit hook requires it)
- [ ] Task #17 in task list can be marked completed
- [ ] Atomic commit: single `git add server.js lib/config.js STATUS.md && git commit -m "..." && git push`
- [ ] After push, nodemon auto-restarts; next Twitch assembly uses TV design
- [ ] Optional: re-run Jason 2-clip smoke test and visually confirm the assembled MP4 shows the new TV card at JASON_INTRO timestamp

---

*Small, focused, self-contained migration. ~1-2 hours of Cline work. No architectural risk, no feature flags, clean rollback via `git revert`. Ships when convenient — not blocking any other work. — Claude Code*
