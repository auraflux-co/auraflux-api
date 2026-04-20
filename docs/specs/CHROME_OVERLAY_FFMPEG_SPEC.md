# CHROME_OVERLAY_FFMPEG_SPEC.md — Universal Broadcast Chrome Engine

**Author:** Rob Gregory / Claude Code  
**Created:** 2026-04-19  
**Status:** APPROVED — pending implementation  
**Replaces:** `SET_DESIGN_SPEC_CWN.md` sections 3.1–3.3 + `lib/chrome_overlay.js` Puppeteer pipeline  
**Scope:** Universal broadcast chrome for all customers. Customer 0 (ClipzWorld News) is the reference implementation.

---

## 1. Why We're Replacing the Current System

Current pipeline:
```
Assembly → puppeteer.launch() → page.goto(localhost:3000/newscast-overlay) → screenshot → .png → FFmpeg overlay=0:0
```

Four failure modes:
1. **Alpha channel corruption** — Puppeteer `omitBackground:true` collapses to white/blue in certain CSS states
2. **Font artifacts** — Google Fonts loaded over HTTP fail silently in production environments
3. **Hard dependency on localhost:3000** — parallel assembly workers can't guarantee the route is available
4. **Not universal** — every new customer needs a new HTML template and skin map entry in code

Replacement: **pure FFmpeg `drawtext`/`drawbox` filter chains** built from customer config and per-scene context. No browser. No HTTP. No alpha channel. Fonts from local `.ttf` files.

---

## 2. Universal customerConfig Schema

All chrome fields live under `templates["long-form"].designDefaults.chrome`.

```json
"chrome": {
  "name": "BECAUSE THE LIGHT WAS ON",

  "colors": {
    "primary":    "#22304b",
    "accent":     "#c7af4f",
    "text":       "#ffffff",
    "background": "#0d1424",
    "active":     "#C0392B"
  },

  "topBar": { "height": 48, "episodePrefix": "Episode" },

  "flag": {
    "width": 620, "height": 88, "borderWidth": 4, "maxTitleChars": 50,
    "categoryLabel": {
      "news":   "WORLD NEWS",
      "clips":  "ON STREAM",
      "sports": "NBA GAME"
    }
  },

  "sidebar": {
    "top": 120, "rightMargin": 32, "width": 420,
    "itemHeight": 90, "itemGap": 12, "maxItems": 5,
    "borderWidth": 4, "activeBorderWidth": 5
  },

  "logo": {
    "asset": "assets/cwn_logo.png",
    "x": 1725, "y": 910, "size": 90, "opacity": 0.85
  },

  "font": {
    "headline": "assets/fonts/BebasNeue-Regular.ttf",
    "body":     "assets/fonts/BarlowCondensed-SemiBold.ttf",
    "small":    "assets/fonts/BarlowCondensed-Regular.ttf"
  },

  "contentTypeOverrides": {
    "news":   { "name": "BECAUSE THE LIGHT WAS ON", "colors": { "primary": "#22304b", "accent": "#c7af4f", "active": "#C0392B" } },
    "clips":  { "name": "TALK SOUP",                "colors": { "primary": "#6441A5", "accent": "#7d5bbe", "active": "#6441A5" } },
    "sports": { "name": "OTHER SIDE OF THE PILLOW", "colors": { "primary": "#17408B", "accent": "#1a4fa8", "active": "#C9082A" } }
  }
}
```

**`chrome.name`** — channel/brand name shown in top bar. Universal field — not "show name". Customer 1 with one brand sets this once.

**`chrome.colors`** — semantic color slots. `primary` = main panel background. `accent` = borders/labels. `active` = highlight color for the active sidebar card and LIVE badge. No more `gold`/`red`/`navy` naming.

**`chrome.flag.categoryLabel`** — per-content-type category string shown in flag top row and sidebar inactive cards. Lives in config, not code.

**`chrome.contentTypeOverrides`** — Customer 0 has 3 shows sharing one config. Deep-merged over base `chrome.*` at build time. Customer 1+ with one show sets nothing here.

---

## 3. FFmpeg Filter Chain Design

### Top bar (always on, every scene)

Full-width 1920×48px strip at y=0.

```
drawbox=x=0:y=0:w=1920:h=48:color=0x22304b@0.97:t=fill
drawbox=x=0:y=46:w=1920:h=2:color=0xc7af4f@1.0:t=fill
drawtext=fontfile=HEADLINE:text=EPISODE_NUM:fontsize=22:fontcolor=0xc7af4f:x=32:y=14
drawtext=fontfile=HEADLINE:text=SHOW_NAME:fontsize=22:fontcolor=0xc7af4f:x=(w-text_w)/2:y=14
drawbox=x=1640:y=8:w=80:h=32:color=0xC0392B:t=fill
drawtext=fontfile=HEADLINE:text=LIVE:fontsize=14:fontcolor=white:x=1648:y=18
drawtext=fontfile=HEADLINE:text=DATE_STR:fontsize=18:fontcolor=0xc7af4f:x=1740:y=15
```

### Flag (top-left, conditional — hidden on COLD_OPEN/SOURCE_CLIP/OUTRO)

Occupies x=0, y=48, w=620, h=88 (directly below top bar).

Row 1 — category label (accent background):
```
drawbox=x=0:y=48:w=620:h=38:color=ACCENT:t=fill
drawtext=fontfile=SMALL:text=CATEGORY:fontsize=14:fontcolor=BACKGROUND:x=32:y=58
```

Row 2 — title (primary background, accent left border):
```
drawbox=x=0:y=86:w=620:h=50:color=PRIMARY:t=fill
drawbox=x=0:y=86:w=4:h=50:color=ACCENT:t=fill
drawtext=fontfile=BODY:text=TITLE:fontsize=28:fontcolor=TEXT:x=16:y=97
```

Multi-line title: chrome builder truncates to `maxTitleChars`, splits at word boundary if > 28 chars per line, adds second `drawtext` at y=118. Row 2 height increases to 72px if two lines needed.

### Sidebar (right side, conditional — same rules as flag)

Left edge: `1920 - rightMargin - width = 1468`. Items stacked at `itemY = 120 + (i * (itemHeight + itemGap))`.

Inactive item:
```
drawbox=x=1468:y=Y:w=420:h=90:color=0x080e1c:t=fill
drawbox=x=1468:y=Y:w=4:h=90:color=ACCENT:t=fill
drawtext=fontfile=SMALL:text=CATEGORY:fontsize=12:fontcolor=ACCENT:x=1482:y=Y+10
drawtext=fontfile=BODY:text=TITLE:fontsize=22:fontcolor=TEXT:x=1482:y=Y+30
```

Active item (index === activeIdx):
```
drawbox=x=1468:y=Y:w=420:h=90:color=PRIMARY:t=fill
drawbox=x=1468:y=Y:w=5:h=90:color=ACTIVE:t=fill
drawtext=fontfile=SMALL:text=▶ ON AIR:fontsize=12:fontcolor=ACTIVE:x=1482:y=Y+10
drawtext=fontfile=BODY:text=TITLE:fontsize=22:fontcolor=TEXT:x=1482:y=Y+30
```

Max 5 items. Titles truncated to 35 chars with ellipsis.

### Logo (always on, every scene)

Logo PNG has its own alpha — uses FFmpeg `overlay` filter, not drawtext/drawbox.

```
-i INPUT_VIDEO
-i LOGO_ASSET
-filter_complex "[0:v]DRAWCHAIN[drawn];[drawn][1:v]scale=SIZE:-1[logo];[drawn][logo]overlay=x=X:y=Y[out]"
```

Opacity applied via `colorchannelmixer=aa=OPACITY` on logo stream when `opacity < 1.0`.

---

## 4. Per-Scene Parameters Interface

```javascript
const chromeParams = {
  // Visibility (resolved by assembly from scene type)
  showFlag:    boolean,   // false on COLD_OPEN, SOURCE_CLIP, OUTRO
  showSidebar: boolean,   // same rules as showFlag

  // Top bar (every scene)
  episodeNumber: string,  // "Episode 7"
  showName:      string,  // from chrome config after contentTypeOverride merge
  dateStr:       string,  // "APRIL 19, 2026"

  // Flag (when showFlag === true)
  flagCategory: string,   // "WORLD NEWS" / "ON STREAM" / "NBA GAME"
  flagTitle:    string,   // active item's display title

  // Sidebar (when showSidebar === true)
  sidebarItems: [{ title: string, category: string }],  // max 5
  activeIdx:    number,   // 0-based index of active item

  contentType:  string    // 'news' | 'clips' | 'sports'
};
```

**Visibility rules:**
```javascript
const isColdOpen   = /cold.open/i.test(label) || /^INTRO$/i.test(label);
const isOutro      = /OUTRO/i.test(label);
const isSourceClip = seg.type === 'source_clip';
const showFlag     = !isColdOpen && !isOutro && !isSourceClip;
const showSidebar  = showFlag;
```

---

## 5. Migration Plan

### Changes in assembly.js
- **Remove**: `generateNewscastOverlay()` calls, two-state PNG render branch, temp PNG file creation/cleanup
- **Add**: `buildAndBurnChrome(inputPath, chromeParams, chromeCfg, outputPath)` calling new `lib/chrome_overlay_ffmpeg.js`
- **Unchanged**: `activeIdx` derivation, `allStories`/`sidebarItems` construction, watermarkBox drawbox for news clips, episode counter reads

### Changes in customerConfig (c0.json)
- **Add**: new `chrome` block per section 2
- **Deprecate but keep**: `templateFile`, `skins` fields — ignored by new engine, kept so Gate 3b readers don't error

### What becomes obsolete
| Component | Status |
|---|---|
| `lib/chrome_overlay.js` Puppeteer functions | Deprecated — keep file, mark `@deprecated` |
| `tools/clipzworld_newscast.html` | Deprecated — keep as reference, add deprecation header |
| `lib/chromeDirectives.js` → `directiveToOverlayParams()` | Deprecated |
| `localhost:3000/newscast-overlay` Express route | Remove after 2 smoke test passes |
| Puppeteer in `package.json` | Remove after 2 smoke test passes |

### What stays unchanged
| Component | Reason |
|---|---|
| Ticker pipeline | Separate Puppeteer render, out of scope |
| Logo asset file | Consumed via FFmpeg overlay — no change |
| Thumbnail generation | Canvas-based, separate pipeline |
| Gates 2, 4, 5 | No chrome reads |

### Gate 3a update required
Lines 338–340 — replace diagnostic hint:
- Old: references CSS injection / Puppeteer
- New: references `drawtext`/`drawbox` color params and font file availability

### CHANGE_IMPACT_MAP update required
New rows:
- `customerConfig chrome colors` → assembly chrome builder, gate3a expectedSkin check
- `chrome font files` → chrome builder in `lib/chrome_overlay_ffmpeg.js`, gate3a prompt
- `chrome flag/sidebar coords in customerConfig` → gate3a prompt, gate3b commitment check

---

## 6. Customer 1 Onboarding — Zero Code Changes

Customer 1 ("Morning Bloc") creates `config/customers/c1.json`:

```json
{
  "customerId": "c1",
  "templates": {
    "long-form": {
      "designDefaults": {
        "chrome": {
          "name": "MORNING BLOC",
          "colors": { "primary": "#1a3a2a", "accent": "#ffffff", "text": "#ffffff", "background": "#0a1a12", "active": "#e8b400" },
          "flag": { "categoryLabel": { "news": "TODAY'S STORIES" } },
          "logo": { "asset": "assets/customers/c1/morning_bloc_logo.png", "x": 1725, "y": 910, "size": 90, "opacity": 0.85 },
          "font": { "headline": "assets/fonts/BebasNeue-Regular.ttf", "body": "assets/fonts/BarlowCondensed-SemiBold.ttf", "small": "assets/fonts/BarlowCondensed-Regular.ttf" }
        }
      }
    }
  }
}
```

Drop logo PNG at `assets/customers/c1/morning_bloc_logo.png`. Done. No code changes.

---

## 7. Font File Requirement

Required `.ttf` files (currently served from Google Fonts over HTTP — must be local):
- `assets/fonts/BebasNeue-Regular.ttf` (SIL OFL 1.1 — committable)
- `assets/fonts/BarlowCondensed-Regular.ttf` (SIL OFL 1.1 — committable)
- `assets/fonts/BarlowCondensed-SemiBold.ttf` (SIL OFL 1.1 — committable)

Fallback if missing: chrome builder logs `[WARN]` and substitutes FFmpeg built-in `DejaVu Sans`. Video renders with wrong typeface but does not fail assembly.

---

## 8. Acceptance Criteria

Two consecutive episode batches across all three c0 content types (news, clips, sports):

1. No PNG files created in `tmp/` during chrome burns
2. No Puppeteer process spawned during chrome burns
3. Flag correct on every INTRO/BODY avatar scene; hidden on COLD_OPEN, SOURCE_CLIP, OUTRO
4. Sidebar correct on every INTRO/BODY scene; active card highlighted at correct index
5. Channel name in top bar correct per content type
6. Colors match `chrome.colors` config — Gate 3a `chromeVisible: true` on all three skins
7. Logo at correct position, correct opacity
8. No alpha corruption artifacts (blue boxes, white rectangles)
9. Gate 3a `chromeVisible: true` on all sampled frames
10. Customer 1 config renders correct chrome with zero code changes

---

## 9. Out of Scope for This Spec

- Short-form (9:16) chrome — follow-on spec after long-form stabilizes
- Ticker replacement — separate Puppeteer render, separate concern
- Animated chrome elements — deferred enhancement
- Gate 3b commitment field changes — reads same `chromeVisible` from Gate 3a regardless
