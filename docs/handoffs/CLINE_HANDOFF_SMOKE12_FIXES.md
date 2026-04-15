# CLINE_HANDOFF_SMOKE12_FIXES.md
→ Agent: Cline-A

**Author:** Claude Code, 2026-04-14
**Size:** S — `server.js` + `tools/clipzworld_newscast.html` + `lib/chromeDirectives.js`
**Files:** All Tier 1/Tier 2 — declare lock before editing
**Depends on:** Nothing — standalone

---

## Context

Smoke test 12 review produced 4 fixes. TV card removed (user decision), source clip
zoom-to-fill broken for portrait clips, top-right "NOW COVERING" label shows "AL JAZEERA"
instead of "WORLD NEWS", and show name indent is wrong (should flush far left).

---

## Fix 1 — Remove TV card code entirely (all content types)

User confirmed: **scrap TV card code from all sets.** It never rendered correctly and is
not needed. Story sidebar + lower-third flag are sufficient chrome for News. Twitch and NBA
also have no TV card.

### 1a. `tools/clipzworld_newscast.html` — remove CSS + HTML

**Remove the entire `.tv-card` CSS block (lines ~331–377):**

Find and delete this entire block:
```css
/* ═══════════════════════════════════════
   TV CARD — OVERLAY_ZONE top-right
═══════════════════════════════════════ */
.tv-card {
  ...
}
.tv-card-image { ... }
.tv-card-meta { ... }
.tv-card-headline { ... }
.tv-card-source { ... }
```

**Remove the HTML element (lines ~406–414):**
```html
<!-- TV CARD — OVERLAY_ZONE top-right (520×293 at x=1240, y=40) -->
<!-- Red 4 Fix 3d: hidden by default, shown via page.evaluate() JS injection when tvCard data present -->
<div class="tv-card">
  <img class="tv-card-image" src="" alt="">
  <div class="tv-card-meta">
    <div class="tv-card-headline">Breaking News</div>
    <div class="tv-card-source">CWN</div>
  </div>
</div>
```

### 1b. `lib/chromeDirectives.js` — remove ChromeTvCardSchema and tvCard field

Find and remove `ChromeTvCardSchema` (lines ~24–29):
```javascript
const ChromeTvCardSchema = z.object({
  visible:    z.boolean(),
  imageUrl:   z.string().optional(),
  headline:   z.string().optional(),
  sourceName: z.string().optional(),
});
```

In `ChromeDirectiveSchema`, remove the `tvCard` field:
```javascript
tvCard:  ChromeTvCardSchema.optional(),
```

In `directiveToOverlayParams()` (lines ~163–167), remove the tvCard block:
```javascript
tvCard: directive.tvCard ? {
  visible:    directive.tvCard.visible,
  imageUrl:   directive.tvCard.imageUrl    || null,
  headline:   directive.tvCard.headline    || null,
  sourceName: directive.tvCard.sourceName  || null,
} : null,
```

### 1c. `server.js` — remove TV card injection in generateNewscastOverlay

In `generateNewscastOverlay()` around line ~11839–11842, find and remove the block that
sets tvCard headline and sourceName textContent:
```javascript
if (tvCardSource && opts.tvCard.sourceName) tvCardSource.textContent = opts.tvCard.sourceName;
```

Search for `tvCard` in `generateNewscastOverlay()` and remove the entire tv-card injection
block (show(), display, headline, sourceName population).

Also in `server.js` around line ~4421–4426 in the assembly loop, remove the storyCardData
block that builds `source: cardData.source || 'AL JAZEERA'` and calls `generateNewsStoryCardPNG()`:
```javascript
const storyCardData = {
  title: cardData.title || 'Breaking News',
  category: cardData.category || 'WORLD NEWS',
  source: cardData.source || 'AL JAZEERA',
  heroImageUrl: cardData.heroImageUrl || cardData.imageUrl
};
await generateNewsStoryCardPNG(storyCardData, newsCardPngPath);
```

If `generateNewsStoryCardPNG()` is only called from this one place, mark it with a
`// DEAD — TV card removed smoke test 12` comment but do NOT delete the function yet
(leave for next cleanup pass).

Also remove the `tvCard` field from the Gemini News prompt schema example around line ~7983:
```json
"tvCard": { "visible": true, "imageUrl": "...", "headline": "Full Article Headline", "sourceName": "Al Jazeera" },
```
Replace with a comment or just remove the tvCard line from the example.

---

## Fix 2 — Source clip zoom-to-fill broken for portrait clips

**Root cause:** The current scale formula at `server.js:4628`:
```javascript
"scale=w='if(gt(a,16/9),-2,1920)':h='if(gt(a,16/9),1080,-2)',crop=1920:1080,fps=fps=30"
```

For portrait input (a < 1, e.g. Al Jazeera 9:16 = 0.5625):
- `gt(a,16/9)` = false (0.5625 < 1.778)
- So `w=-2, h=1080` → scales height to 1080, width = ~608px
- Then `crop=1920:1080` crops a 1920-wide region from a 608-wide frame → FFmpeg error or black fill

**Fix — replace the source clip scale formula at `server.js:4628`:**

```javascript
// Before:
: "scale=w='if(gt(a,16/9),-2,1920)':h='if(gt(a,16/9),1080,-2)',crop=1920:1080,fps=fps=30" +

// After:
: 'scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=fps=30' +
```

`force_original_aspect_ratio=increase` scales to cover 1920×1080 regardless of input aspect
ratio (wide, square, portrait), then `crop=1920:1080` trims overflow. This is the correct
zoom-to-fill for any input.

---

## Fix 3 — "AL JAZEERA" appearing in top-right "NOW COVERING" segment tag

**Root cause:** `cardData.category` is built at `server.js:291`:
```javascript
category: storyItem.category || storyItem.source || 'WORLD NEWS',
```

When `storyItem.category` is empty/null, it falls through to `storyItem.source` ("Al Jazeera"),
which becomes the `activeCategory` that populates the `.seg-name` element.

**Fix — change the fallback at `server.js:291`:**

```javascript
// Before:
category: storyItem.category || storyItem.source || 'WORLD NEWS',

// After:
category: storyItem.category || 'WORLD NEWS',
```

The `.seg-name` ("NOW COVERING" box) should always show the content type label ("WORLD NEWS")
not the source outlet. Source outlet belongs in the lower-third flag (`flag.source` field),
not the segment tag.

**Also fix the same fallback at `server.js:4356`:**
```javascript
// Before:
const activeCategory = cardData.category || 'WORLD NEWS';

// After:
const activeCategory = (cardData.category && cardData.category !== cardData.source)
  ? cardData.category : 'WORLD NEWS';
```

This ensures even existing job cards that stored source as category get the correct fallback.

---

## Fix 4 — Show name indent: flush far left

**Root cause:** The top bar has `padding: 0 32px` (line ~165 in `clipzworld_newscast.html`).
The `.top-brand` element ("BECAUSE THE LIGHT WAS ON") starts at the left padding. The
`.top-show` element (`id="show-info"`) comes third in the flex row:
`[top-brand] [top-divider] [top-show]`

User wants the **show name to start flush far left** — meaning it should be the first element
on the left edge, or at minimum not have the brand + divider pushing it to the right.

**Fix — reorder the top bar so `#show-info` is flush left, with brand pushed right:**

In `tools/clipzworld_newscast.html`, find the top-bar HTML (line ~383–394):

```html
<!-- Before: -->
<div class="top-bar">
  <div class="top-brand">BECAUSE THE LIGHT WAS ON</div>
  <div class="top-divider"></div>
  <div class="top-show" id="show-info">Episode 1</div>
  <div class="top-right">
    ...
  </div>
</div>

<!-- After: -->
<div class="top-bar">
  <div class="top-show" id="show-info">Episode 1</div>
  <div class="top-divider"></div>
  <div class="top-brand">BECAUSE THE LIGHT WAS ON</div>
  <div class="top-right">
    ...
  </div>
</div>
```

This puts the episode/show name at position 1 (leftmost after 32px padding), then divider,
then the channel brand text.

---

## Files to change

| File | Tier | Edits |
|------|------|-------|
| `tools/clipzworld_newscast.html` | 2 | Fix 1a (remove TV card CSS+HTML), Fix 4 (top-bar reorder) |
| `lib/chromeDirectives.js` | 1 | Fix 1b (remove ChromeTvCardSchema + tvCard field) |
| `server.js` | 1 | Fix 1c (remove TV card injection), Fix 2 (zoom-to-fill formula), Fix 3 (category fallback) |

---

## Verification

1. Run assembly on a News job
2. **Fix 1:** No TV card ever appears — confirm OVERLAY_ZONE (top-right) is empty on all scenes
3. **Fix 2:** Al Jazeera portrait clip fills full 1920×1080 frame — no black bars on sides
4. **Fix 3:** Top-right "NOW COVERING" box always shows "WORLD NEWS", never a source outlet name
5. **Fix 4:** Show name / episode number is the leftmost element in the top bar (far left after frame padding)

---

## Commit message

```
fix(news-chrome): TV card removed, portrait clip zoom-to-fill, category label, show name indent

- Remove TV card code entirely from clipzworld_newscast.html, chromeDirectives.js,
  and server.js — never rendered correctly; sidebar + flag sufficient (smoke test 12)
- Fix portrait source clip sizing: replace conditional scale formula with
  force_original_aspect_ratio=increase,crop — correct zoom-to-fill for any aspect ratio
- Fix "AL JAZEERA" in NOW COVERING box: cardData.category no longer falls through to
  storyItem.source; always shows 'WORLD NEWS' when category absent
- Move show name to far-left position in top bar (was third in flex row after brand+divider)
```
