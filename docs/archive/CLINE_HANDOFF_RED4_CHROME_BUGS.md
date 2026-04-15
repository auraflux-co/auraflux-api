# CLINE_HANDOFF_RED4_CHROME_BUGS.md

**Author:** Claude Code, drafted 2026-04-14 ~01:00 ET after reviewing the first end-to-end Red 4 directive-burn assembly (`asm_1776140626023`, MP4 `news_apr_13_22_avatar_5_clips__5clips_1776140696488.mp4`).
**For:** Cline
**Scope:** Fix four bugs in the Red 4 chrome directive pipeline that were exposed by tonight's first real assembly. The legacy Fix 5/7 News chrome path was replaced by Red 4 directive burns, but the Gemini prompt, the Zod schema, and the directive consumer (`directiveToOverlayParams`) were never aligned to a single shape — so the burned overlay falls back to placeholder fixture data and the TV card never renders. Plus a bonus: source clip aspect ratio is wrong for portrait-source Al Jazeera videos.
**Ship as:** ONE commit (all four are entangled — fixing the prompt without fixing the consumer leaves the same bugs in a different place).
**Do NOT touch:** Twitch or NBA chrome paths, the legacy Fix 5/7 fallback at server.js:4211+, `lib/chromeDirectives.js` schema (it's already correct — the bugs are upstream and downstream of the schema, not in it).
**Before the commit:** Re-read `COMMIT_CHECKLIST.md`. Update `STATUS.md` 🤖 Last Agent Action table. Hard refresh dashboard before smoke testing.

---

## Evidence — the screenshot from `news_apr_13_22_avatar_5_clips__5clips_1776140696488.mp4`

Rob reviewed the first assembled MP4 from Red 4 directive burns. Bobby G delivery + scene transitions + audio = good. The chrome layer is broken across multiple dimensions:

1. **Lower-third flag (top-left)** says literally `"Breaking News Story"` — the CSS placeholder text from `clipzworld_newscast.html`. Should say the actual story headline (e.g. "Trump says Iran wants 'peace deal' but insists on 'no nukes'").
2. **Story sidebar (right side)** shows hardcoded fixture data: "Global Markets React to Fed Decision", "UN Security Council Emergency Session", "UConn Stuns Duke in Half-Court Buzzer Beater", "AI Regulation Bill Advances in Congress". These are placeholder strings baked into `clipzworld_newscast.html` HTML. **None of tonight's actual stories appear.** Tonight's were Trump/Iran/Pope/Hormuz/Lebanon — completely absent from the sidebar.
3. **TV card (top-right)** missing entirely. The 720×405 article-image card that should sit in OVERLAY_ZONE at x=1240 is not rendered at all.
4. **Source clips appear "size of a short"** — Al Jazeera clips are landscape-canvas with massive navy side bars instead of filling the frame. Looks like a portrait video stuffed into a 16:9 container with letterbox padding.

---

## Root cause analysis

### Bugs 1, 2, 3 — schema/prompt/consumer triple mismatch

`lib/chromeDirectives.js` defines a Zod schema for the Red 4 directive format. The schema is **correct and rich**: `ChromeDirectiveSchema` has nested `flag`, `tvCard`, `sidebar`, `ticker`, `logo` objects, and the top-level `ScriptSchema` requires `scriptVersion: 1`, `contentType`, `clientId`, `brandConfig: {primaryHex, accentHex, showName, episodeNumber}`, `estimatedTotalDurationSec`, `storyList: [{index, title, source}, ...]`, and per-scene `storyIndex`, `estimatedDurationSec`, etc.

But:

**(a) The Gemini prompt at server.js:7715-7748 asks for a totally different shape.** It tells Gemini to emit:
- `storyList: ["Story 1 headline", "Story 2 headline", ...]` ← **strings, not objects**
- `brandConfig: {primaryHex, accentHex}` ← missing `showName` and `episodeNumber`
- Per-scene `chrome: {layout, showLowerThird, hideSidebar, activeStoryIndex, activeCategory}` ← **flat boolean fields**, not nested `flag`/`tvCard`/`sidebar` objects
- No `scriptVersion`, no `contentType`, no `clientId`, no `estimatedTotalDurationSec`, no per-scene `storyIndex`, no per-scene `estimatedDurationSec`
- No `tvCard` directive on any scene — the prompt doesn't mention TV cards at all

**(b) The Zod validator `validateScript()` is imported at server.js:7 but NEVER CALLED anywhere in server.js.** Grep confirms: `validateChromeScript` appears exactly once in server.js, at the import statement. So Gemini emits whatever shape it likes, and the parser at server.js:4193 just calls `JSON.parse(cleanedRaw)` and accepts the result blindly. There is no schema enforcement at all — meaning bugs (a) and (c) compound silently with no error.

**(c) The directive consumer `directiveToOverlayParams()` at lib/chromeDirectives.js:140 reads from yet a third shape.** It expects:
- `storyList` of objects with `.title`, `.source`, `.index`
- `directive.flag?.text`, `directive.flag?.source`, `directive.flag?.visible`
- `directive.sidebar?.activeIndex`, `directive.sidebar?.visible`

So when Gemini emits `chrome.activeStoryIndex: 0` (per the prompt), the consumer reads `directive.sidebar?.activeIndex` → `undefined` → defaults to `0`. When Gemini emits `chrome.showLowerThird: true`, the consumer reads `directive.flag?.visible` → `undefined` → defaults to `false`. **The lower-third never shows because the consumer never sees the prompt's flat field.** Even when it does briefly try `directive.flag?.text` for the headline, that field doesn't exist in Gemini's output, so it falls through to `(allStories[activeIndex]?.title)` — and `allStories` is built from a `storyList` of strings (not objects), so `s.title` is `undefined` for every story.

Then in `generateNewscastOverlay()` at server.js:11492, the guard `if (data.allStories && data.allStories.length > 0)` — if Gemini emitted `storyList: []` or omitted it entirely (likely, since the prompt doesn't mention storyList in the scene examples), `allStories.length === 0`, the guard is false, and **the existing fixture HTML in `clipzworld_newscast.html` is left untouched.** That's why Rob saw "Global Markets React to Fed Decision" and not tonight's stories.

**The fix is to align all three to one shape.** The schema is the source of truth (it's the most thorough and was designed deliberately in `CHROME_DIRECTIVE_ARCHITECTURE.md`). The prompt and consumer should both conform to it. Then enable `validateScript()` so future drift is caught immediately instead of silently degrading to fixture data.

### Bug 4 — Source clip aspect ratio (separate code path)

server.js:4517-4519 normalizes source_clip segments with:

```javascript
const vfFilter = isAvatarSeg
  ? 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,fps=fps=30'
  : 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x0d1424,fps=fps=30' + ...
```

This is **letterbox-fit** — scale to fit, pad with navy. If the source is 480×854 (a portrait Al Jazeera video, which they do publish for mobile-first content), this scales to 608×1080 with 656px navy bars on each side. Visually it looks like "a short stuffed into a landscape canvas." The comment at server.js:4514 explicitly says letterbox-fit "preserves framing on broadcast video" — but that assumption breaks when the source is portrait-oriented from the start.

The line 4516 NOTE references that lines 3800/3834 (short-form split-screen slots) legitimately use zoom-to-fill. **News long-form source clips should also use zoom-to-fill** (or at least: detect portrait input and switch to zoom-to-fill for those). The right call is "fill the frame, crop overflow at edges" — Al Jazeera content is editorial broadcast video, the slight edge crop is fine, and full-frame video is much better than navy-bar-padded shorts.

---

## Fix 1 — Rewrite the Gemini News prompt to match `lib/chromeDirectives.js` schema

**File:** `server.js`
**Location:** Around line 7715-7748 (the JSON CHROME DIRECTIVE FORMAT block in the News Gemini prompt)

### Before (current — wrong)

```javascript
── Red 4: JSON CHROME DIRECTIVE FORMAT ──────────────────────────────────────
Output your ENTIRE script as a single JSON object (no markdown fences, no plain text outside the JSON).

Top-level structure:
{
  "storyList": ["Story 1 headline", "Story 2 headline", ...],
  "brandConfig": { "primaryHex": "#22304b", "accentHex": "#c7af4f" },
  "scenes": [ ... ]
}

Each scene object:
{
  "id": "scene_label_matching_assembly",
  "type": "avatar" | "source_clip",
  "spokenText": "The exact words the anchor speaks (empty string for source_clip scenes)",
  "chrome": {
    "layout": "COLD_OPEN" | "STORY_INTRO" | "STORY_BODY" | "OUTRO",
    "showLowerThird": true | false,
    "hideSidebar": true | false,
    "activeStoryIndex": 0,
    "activeCategory": "BREAKING" | "POLITICS" | "BUSINESS" | "SPORTS" | "TECH" | "ENTERTAINMENT" | "WORLD" | "HEALTH" | "SCIENCE" | "WEATHER"
  }
}

Layout rules:
- Scene 1 (cold open / intro): layout="COLD_OPEN", showLowerThird=false, hideSidebar=true
- First avatar scene of each story: layout="STORY_INTRO", showLowerThird=true, hideSidebar=false
- Subsequent avatar scenes of same story: layout="STORY_BODY", showLowerThird=false, hideSidebar=false
- source_clip scenes: layout="STORY_BODY", showLowerThird=false, hideSidebar=true
- Final outro scene: layout="OUTRO", showLowerThird=false, hideSidebar=true
- activeStoryIndex: 0-based index of the current story (0 for cold open/outro)
- The "id" field must exactly match the scene label used in assembly (e.g. "scene_01", "scene_02", etc.)

IMPORTANT: The JSON must be valid and parseable. Do not include any text before or after the JSON object.
```

### After (rewritten to match lib/chromeDirectives.js ScriptSchema exactly)

```javascript
── Red 4: JSON CHROME DIRECTIVE FORMAT ──────────────────────────────────────
Output your ENTIRE script as a single JSON object (no markdown fences, no plain text outside the JSON).
This output is validated against a strict Zod schema — any field mismatch will reject the script.

Top-level structure:
{
  "scriptVersion": 1,
  "contentType": "news",
  "clientId": "cwn",
  "brandConfig": {
    "primaryHex": "#22304b",
    "accentHex": "#c7af4f",
    "showName": "ClipzWorld News",
    "episodeNumber": ${newsEpNum}
  },
  "estimatedTotalDurationSec": 660,
  "storyList": [
    { "index": 0, "title": "Full headline of story 1, sentence case", "source": "Al Jazeera" },
    { "index": 1, "title": "Full headline of story 2", "source": "Al Jazeera" },
    ... one entry per story you cover, in the order they appear ...
  ],
  "scenes": [ ... see Each scene object below ... ]
}

Each AVATAR scene object:
{
  "id": "scene_01",
  "type": "avatar",
  "storyIndex": 0,
  "spokenText": "The exact words the anchor speaks. Plain text, no markdown, no [beat] markers — those are added downstream.",
  "estimatedDurationSec": 14.5,
  "chrome": {
    "flag": {
      "visible": true,
      "text": "TRUMP IRAN PEACE DEAL",
      "source": "Al Jazeera"
    },
    "tvCard": {
      "visible": true,
      "imageUrl": "https://www.aljazeera.com/.../og-image.jpg",
      "headline": "Trump says Iran wants 'peace deal' but insists on 'no nukes'",
      "sourceName": "Al Jazeera"
    },
    "sidebar": {
      "visible": true,
      "activeIndex": 0,
      "cap": 5
    },
    "ticker": { "visible": true },
    "logo":   { "visible": true }
  }
}

Each SOURCE_CLIP scene object:
{
  "id": "scene_04",
  "type": "source_clip",
  "storyIndex": 0,
  "clipUrl": "https://exact-clip-url-from-orderedClipUrls.mp4",
  "clipMaxDurationSec": 25,
  "chrome": {
    "flag":    { "visible": false },
    "tvCard":  { "visible": false },
    "sidebar": { "visible": false, "activeIndex": 0, "cap": 5 },
    "ticker":  { "visible": true },
    "logo":    { "visible": true }
  }
}

Required fields per scene type:
- AVATAR scenes need: id, type="avatar", storyIndex, spokenText (non-empty string), estimatedDurationSec (positive number), chrome.
- SOURCE_CLIP scenes need: id, type="source_clip", storyIndex, clipUrl (valid URL), clipMaxDurationSec (positive number, default 25), chrome. spokenText is OMITTED for source_clip — do NOT include an empty spokenText field on source_clip scenes.

Chrome layout rules per scene type:
- COLD OPEN (scene_01, INTRO): flag.visible=false, tvCard.visible=false, sidebar.visible=false, storyIndex=-1
- STORY_INTRO (first avatar scene of each story): flag.visible=true with the story's UPPERCASE 2-4 word punchy summary as flag.text and the publisher as flag.source; tvCard.visible=true with that story's og:image URL, full sentence-case headline, and source name; sidebar.visible=true with activeIndex matching this story's position in storyList
- STORY_SETUP / STORY_SUMMARY / STORY_REACTION (subsequent avatar scenes for the same story): flag.visible=true (carries the story flag), tvCard.visible=false (only on STORY_INTRO), sidebar.visible=true with activeIndex still pointing at this story
- SOURCE_CLIP scenes: flag.visible=false, tvCard.visible=false, sidebar.visible=false (clip plays full-screen, no overlay clutter)
- OUTRO (final scene): flag.visible=false, tvCard.visible=false, sidebar.visible=false, storyIndex=-1

flag.text guidance: 2-4 UPPERCASE words, punchy, news-ticker-style (e.g. "TRUMP IRAN PEACE", "POPE FEUD ESCALATES", "STRAIT OF HORMUZ", "EU LEBANON CRISIS"). NOT the full sentence-case headline — that goes in tvCard.headline.

storyList ordering: index field must match the order of the stories in the scenes[] array. Story 0 in storyList = first story Bobby G covers = scenes with storyIndex=0.

Scene id format: "scene_01", "scene_02", ... matching the order in scenes[]. Use 2-digit zero-padded numbers.

IMPORTANT:
- The JSON must be valid and parseable. No text before or after.
- Every field listed as required above must be present, even if its value is empty/false (use { "visible": false } for hidden chrome elements rather than omitting the object).
- This output is validated by lib/chromeDirectives.js validateScript() — schema mismatches will hard-fail Gate 1 with the specific Zod error path so you can see exactly what was wrong.
```

**Why this works:** every field name and shape now exactly matches `lib/chromeDirectives.js` ScriptSchema. The new prompt explicitly mentions Zod validation as the enforcement mechanism so Gemini knows it can't free-form. The `tvCard` block tells Gemini what `imageUrl` to populate (the og:image scraped during the News fetch flow — same URL the legacy `OVERLAY_ZONE` filter used). The `flag` and `sidebar` shapes match exactly what `directiveToOverlayParams()` reads.

**Note on tvCard.imageUrl:** Gemini needs access to the og:image URLs for each selected story. These are already scraped during `/news/us-canada-videos` (Fix 8B/Fix 9 added `scrapeArticleOgImage()` and `scrapeArticleVideo()`). Make sure the data passed into the prompt includes per-story `ogImage` so Gemini can copy it into `tvCard.imageUrl`. If the existing News data flow doesn't already pass `ogImage` into the prompt context, add it — search for where `items` or the News story array is built before the userPrompt is constructed (likely in the News branch of `/generate-full-script`).

**Note on episodeNumber template:** the prompt uses `${newsEpNum}` from a `data/episode_counters.json` read. There's already a similar read at server.js:11366. Add the same read at the top of the News prompt-building branch and inject `episodeNumber` into the template literal.

---

## Fix 2 — Enable `validateScript()` in the Gate 1 / parse path

**File:** `server.js`
**Location:** Wherever the parsed JSON script is first available after Gemini returns it (likely the News branch of `/generate-full-script` immediately after `JSON.parse` of Gemini's output, AND/OR at server.js:4193 in the assembly directive parse path as a defensive second-line check).

### What to add

```javascript
// Red 4 hotfix 11: validate Gemini's directive script against the strict Zod
// schema. Without this, schema drift between the prompt and the consumer is
// silent and degrades to placeholder fixture data on the rendered overlay.
// See: lib/chromeDirectives.js ScriptSchema for the canonical shape.
const validation = validateChromeScript(parsedScript);
if (!validation.ok) {
  const errorList = validation.errors.join('\n  - ');
  const msg = `Red 4 directive script failed Zod validation:\n  - ${errorList}`;
  console.error(`[gate1-directive] ${msg}`);
  // Hard-fail Gate 1 with the Zod errors as the deduction reason
  return res.status(400).json({
    ok: false,
    error: 'directive_validation_failed',
    qaResult: {
      outcome: 'fail',
      score: 0,
      deductions: validation.errors.map(e => ({ points: 100, reason: e })),
      validatorErrors: validation.errors
    }
  });
}
console.log(`[gate1-directive] ✅ Zod validation passed (${parsedScript.scenes.length} scenes, ${parsedScript.storyList.length} stories)`);
```

**Where exactly:** the call site is wherever Gemini's output gets parsed for the first time in the News flow. Search for `JSON.parse` near `geminiScriptGeneration` calls in the News branch. There are at most 2-3 candidate sites; pick the one immediately after `parsedScript = JSON.parse(...)` and before `res.json({...})` returns the script to the dashboard.

**Defensive copy at the assembly directive parse path:** at server.js:4193 (`parsedDirectiveScript = ... JSON.parse(cleanedRaw)`), add the same `validateScript()` call. If the script somehow made it past Gate 1 with an invalid shape (e.g. an old job restored from `data/jobs.json` written before this fix), don't burn garbage chrome — log the error and fall through to the legacy Fix 5/7 path, which the existing code already handles via the `_directiveHandled` flag at line 4186-4209.

---

## Fix 3 — Wire the TV card into the directive consumer + chrome burn

**File:** `lib/chromeDirectives.js` AND `server.js`
**Location:** `directiveToOverlayParams()` in lib/chromeDirectives.js, and `generateChromeOverlayFromDirective()` + `generateNewscastOverlay()` in server.js around line 11400-11510.

### The current state

`directiveToOverlayParams()` only returns fields used by `generateNewscastOverlay()` — it doesn't expose `tvCard` at all. `generateNewscastOverlay()` only renders the newscast HTML (flag + sidebar + episode number), not the TV card. The TV card was historically a separate FFmpeg overlay step in the legacy News chrome path; in the Red 4 path that step is gone.

Two options for fixing this:

**Option A (cleaner): Render the TV card inside the same Puppeteer overlay PNG.** Add a `.tv-card` element to `clipzworld_newscast.html` (or detect if it exists), and have `generateNewscastOverlay()` populate its image src + headline text from the directive. One overlay PNG, one FFmpeg burn step. Keeps the chrome architecturally unified.

**Option B (faster to ship, more surface area): Add a second FFmpeg overlay step in `burnSceneChromeFromDirective()`.** After the newscast overlay PNG is composited, do a second `overlay=1240:40` step with the TV card PNG (separately rendered). Two overlay steps per scene = double the FFmpeg work but the existing newscast HTML doesn't need changes.

**Recommendation:** Option A. The newscast HTML already has the layout grid for it (you can verify by checking `clipzworld_newscast.html` for any `.tv-card` or similar element — if not present, add one in the top-right area at the OVERLAY_ZONE coordinates). The Puppeteer page.evaluate already has access to inject HTML, so adding a `.tv-card img` + `.tv-card h3` selector + populate them from `data.tvCard` is straightforward.

### Changes to `directiveToOverlayParams()` in lib/chromeDirectives.js

```javascript
function directiveToOverlayParams(directive, context) {
  const { storyList = [], episodeNumber = 'Episode 1' } = context;

  const allStories = storyList.map(s => ({
    title:    s.title,
    category: s.source || 'WORLD NEWS',
    storyId:  `story_${s.index}`
  }));

  const activeIndex = directive.sidebar?.activeIndex ?? 0;

  return {
    storyData: {
      title:      directive.flag?.text || (allStories[activeIndex]?.title) || 'Breaking News',
      category:   directive.flag?.source || 'WORLD NEWS',
      allStories,
      // Red 4 hotfix 11: pass tvCard data through to the overlay renderer
      tvCard: {
        visible:    directive.tvCard?.visible ?? false,
        imageUrl:   directive.tvCard?.imageUrl || null,
        headline:   directive.tvCard?.headline || '',
        sourceName: directive.tvCard?.sourceName || ''
      }
    },
    storyIndex:    activeIndex,
    showLowerThird: directive.flag?.visible ?? false,
    hideSidebar:   !(directive.sidebar?.visible ?? true),
    episodeNumber,
    activeCategory: directive.flag?.source || 'WORLD NEWS'
  };
}
```

### Changes to `generateNewscastOverlay()` in server.js around line 11439-11507

Add to the `page.evaluate` block (after the existing story-list rendering, before the screenshot):

```javascript
// ── Red 4 hotfix 11: TV card render ────────────────────────────
// directiveToOverlayParams passes tvCard data through on storyData.tvCard.
// If visible, populate the .tv-card element with image + headline + source.
// If not visible, hide the element entirely so it doesn't show on
// non-STORY_INTRO scenes.
const tvCard = data.tvCard || {};
const tvCardEl = document.querySelector('.tv-card');
if (tvCardEl) {
  if (tvCard.visible && tvCard.imageUrl) {
    tvCardEl.style.display = '';
    const img = tvCardEl.querySelector('img');
    if (img) img.src = tvCard.imageUrl;
    const headline = tvCardEl.querySelector('.tv-card-headline');
    if (headline) headline.textContent = tvCard.headline || '';
    const source = tvCardEl.querySelector('.tv-card-source');
    if (source) source.textContent = tvCard.sourceName || '';
  } else {
    tvCardEl.style.display = 'none';
  }
}
```

### Changes to `clipzworld_newscast.html`

If the file doesn't already have a `.tv-card` element, add one in the top-right area:

```html
<div class="tv-card" style="position:absolute; top:40px; right:40px; width:720px; height:405px; background:#0d1424; border:5px solid #c7af4f; border-radius:6px; box-shadow:0 8px 32px rgba(0,0,0,0.6); display:none; overflow:hidden;">
  <img src="" alt="" style="width:100%; height:75%; object-fit:cover; display:block;">
  <div style="padding:14px 18px; height:25%; box-sizing:border-box; background:#0d1424;">
    <div class="tv-card-headline" style="color:#fff; font-size:18px; font-weight:700; line-height:1.3; margin-bottom:6px; overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical;"></div>
    <div class="tv-card-source" style="color:#c7af4f; font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:0.5px;"></div>
  </div>
</div>
```

(Coordinates: top:40, right:40 in a 1920×1080 viewport puts the right edge at 1880 — leaving 40px of right margin. Width 720 means the left edge is at 1160. If you want it exactly at x=1240 per the OVERLAY_ZONE convention from the legacy path, change `right:40` to `left:1240` and adjust width to 640 to match the original OVERLAY_ZONE w:640.)

**Match the legacy OVERLAY_ZONE coordinates exactly to preserve brand consistency:** OVERLAY_ZONE is `{x:1240, y:40, w:640, h:360}` per CLAUDE.md gotcha #6. Use `position:absolute; left:1240px; top:40px; width:640px; height:360px;` to match.

---

## Fix 4 — Source clip aspect ratio (zoom-to-fill for News portrait sources)

**File:** `server.js`
**Location:** Around line 4517-4523 (the `vfFilter` ternary inside the source_clip branch of TS normalize)

### Before

```javascript
const vfFilter = isAvatarSeg
  ? 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,fps=fps=30'
  : 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x0d1424,fps=fps=30' +
    // Red 2: mask Al Jazeera bottom-right corner watermark with CWN navy box
    (contentType === 'news' && !isAvatarSeg ? ',drawbox=x=1780:y=960:w=120:h=80:color=0x0d1424@1.0:t=fill' : '');
```

### After

```javascript
// Red 4 hotfix 11: News source clips use ZOOM-TO-FILL crop (not letterbox-fit).
// Previously letterbox-fit produced "portrait stuffed in landscape with navy
// side bars" when Al Jazeera served portrait-oriented mobile videos. Zoom-to-
// fill scales to cover the full 1920x1080 frame and crops overflow at edges
// — slight horizontal/vertical edge loss on widescreen sources is acceptable;
// massive navy bars on portrait sources are not. Avatar segments still
// letterbox-fit because HeyGen output is always clean 16:9 and never needs
// cropping.
const vfFilter = isAvatarSeg
  ? 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,fps=fps=30'
  : 'scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080:(iw-1920)/2:(ih-1080)/2,fps=fps=30' +
    // Red 2: mask Al Jazeera bottom-right corner watermark with CWN navy box
    // 120x80 region at (1780, 960) covers logo + 20px safety padding
    // Matches the cropped-to-fill frame so the mask sits at the right pixel position
    (contentType === 'news' && !isAvatarSeg ? ',drawbox=x=1780:y=960:w=120:h=80:color=0x0d1424@1.0:t=fill' : '');
```

**Key change:** `force_original_aspect_ratio=decrease,pad=...` → `force_original_aspect_ratio=increase,crop=1920:1080:(iw-1920)/2:(ih-1080)/2`. This is the same zoom-to-fill pattern that lines 3800/3834 use for short-form split-screen slots (per the NOTE at line 4516), now applied to News long-form source clips.

**Why it's safe for landscape sources:** if the source is already 1920×1080 or wider 16:9, the crop is `1920:1080:(0)/2:(0)/2 = 1920:1080:0:0` which is a no-op. If the source is wider (e.g. 2560×1080), crops 320px from each side. If the source is taller (portrait 480×854 → scaled to 1920×3414), crops 1167px from top and bottom — losing the top/bottom but filling the frame with the visually important center band, which is the right tradeoff for editorial broadcast video.

**Bonus:** the Red 2 watermark mask drawbox at x=1780, y=960 still works because the canvas is now exactly 1920×1080 (no padding offsets to worry about).

---

## Verification

After shipping the commit, hard-refresh the dashboard and run a News smoke test. Expected results:

1. **Gate 1 directive validation log line:** `[gate1-directive] ✅ Zod validation passed (27 scenes, 5 stories)` in server console
2. **Lower-third flag** shows tonight's actual story headline (e.g. "TRUMP IRAN PEACE DEAL"), not "Breaking News Story"
3. **Story sidebar** shows the 5 stories Rob selected, with the "▶ ON AIR" indicator moving as Bobby G walks through them. NO Global Markets / UN Security / UConn / AI Regulation fixture stories.
4. **TV card top-right** shows the Al Jazeera article image + sentence-case headline + "AL JAZEERA" source label, visible only on STORY_INTRO scenes
5. **Source clips fill the frame** — no portrait-with-navy-bars; clips are landscape and full-frame even when Al Jazeera served a 9:16 source
6. **Al Jazeera bottom-right watermark** still masked by the navy drawbox (Red 2 still works under the new crop)

If Gate 1 directive validation hard-fails on the first attempt, that's the new fail-loud behavior working correctly — read the Zod error path, fix the Gemini prompt to emit the missing field, and re-run. **Do not silently fall back to fixture data ever again.**

---

## Commit message

```
fix(news): Red 4 chrome directive bugs — schema/prompt/consumer alignment + source clip crop (hotfix 11)

First end-to-end Red 4 directive burn assembly (asm_1776140626023, MP4
news_apr_13_22_avatar_5_clips__5clips_1776140696488.mp4) exposed four
bugs in the chrome directive pipeline that were invisible until a real
script flowed through the burn step.

ROOT CAUSE — schema/prompt/consumer triple mismatch:
- lib/chromeDirectives.js ScriptSchema is correct and rich (nested
  flag/tvCard/sidebar/ticker/logo objects, full storyList objects with
  index/title/source, scriptVersion + clientId + episodeNumber, etc.)
- The Gemini prompt at server.js:7715 asked for a totally different
  shape (flat storyList of strings, flat chrome.layout/showLowerThird
  fields, no tvCard mention at all)
- The directive consumer directiveToOverlayParams() reads a third
  shape (directive.flag.text, directive.sidebar.activeIndex) that
  matches the schema but not the prompt
- validateScript() was imported but NEVER CALLED, so schema drift was
  silent — degraded to placeholder fixture data with no error

VISIBLE SYMPTOMS in the assembled MP4:
- Lower-third flag said literally "Breaking News Story" (CSS
  placeholder text from clipzworld_newscast.html)
- Story sidebar showed hardcoded fixture data (Global Markets, UN
  Security, UConn buzzer beater, AI Regulation Bill) — none of
  tonight's actual Trump/Iran/Pope/Hormuz/Lebanon stories
- TV card (top-right article image + headline) missing entirely
- Al Jazeera source clips appeared at portrait aspect with navy side
  bars instead of filling the frame

FIXES (one commit, four changes — all entangled, partial would leave
the pipeline broken in a different place):

1. Rewrite the Gemini News prompt at server.js:7715 to match
   ScriptSchema exactly: scriptVersion=1, contentType="news", clientId,
   brandConfig with showName + episodeNumber, storyList of objects
   (not strings), per-scene storyIndex + estimatedDurationSec, nested
   chrome.flag/tvCard/sidebar/ticker/logo objects with full field
   shapes. Tells Gemini it's validated by Zod so schema mismatches
   hard-fail Gate 1.

2. Enable validateChromeScript() in the News branch of
   /generate-full-script immediately after JSON.parse of Gemini's
   output. Hard-fail Gate 1 with the specific Zod error path on
   schema violation. Defensive copy in the assembly directive parse
   path at server.js:4193 falls through to legacy Fix 5/7 chrome on
   validation failure (don't burn garbage).

3. Wire tvCard through directiveToOverlayParams() →
   generateNewscastOverlay() page.evaluate → clipzworld_newscast.html
   .tv-card element. New element matches OVERLAY_ZONE coordinates
   (left:1240, top:40, width:640, height:360) for brand consistency
   with the legacy News chrome path.

4. Source clip TS normalize at server.js:4517 switches from
   letterbox-fit (decrease+pad) to zoom-to-fill (increase+crop) for
   News source clips only. Avatar segs still letterbox-fit because
   HeyGen output is always clean 16:9. Red 2 watermark mask drawbox
   at (1780, 960) still works under the new crop.

Verification: hard refresh dashboard, run News smoke test, expected
[gate1-directive] ✅ Zod validation passed log line, real story
headlines in flag + sidebar, TV card visible on STORY_INTRO scenes
with og:image + sentence-case headline, source clips full-frame
landscape with no navy bars, watermark mask still visible.

References: lib/chromeDirectives.js ScriptSchema (canonical),
CHROME_DIRECTIVE_ARCHITECTURE.md (design doc), 2026-04-14 review of
asm_1776140626023 by Rob + Claude Code chrome bug audit.
```

---

## Not covered by this handoff (explicitly deferred)

- **Migrating the Gate 1 News scoring rubric** to validate against the new schema fields (currently it counts scene markers and clip counts via regex; those checks still work because the new prompt preserves scene IDs in the same `scene_NN` format).
- **Adding `tvCard` directives to NBA or Twitch chrome** — Red 4 currently only powers News. NBA and Twitch still use legacy intro card burns.
- **Per-story og:image scrape robustness** — if Al Jazeera removes an og:image between fetch and Gemini call, `tvCard.imageUrl` ends up null and the TV card hides itself. Acceptable degraded mode; no fallback image needed for now.
- **Gemini emitting `flag.text` in 2-4 word punchy form** — the prompt instructs this clearly, but Gemini may sometimes return full sentences. If observed in the next test, add a server-side post-process at the validateScript step that uppercases and truncates `flag.text` to 4 words max.
- **Schema migration tool** for older `data/jobs.json` cards written before this fix — they'll fail Zod validation on assembly restore. Acceptable: those jobs are tonight's broken run and don't need to survive.

---

## Priority

**Ship before the next News smoke test.** All four bugs need to land together. Tonight's MP4 is unshippable as a creative review — Rob confirmed Bobby G + audio + scene transitions are good, so the pipeline mechanics work; only the chrome layer needs rebuilding to match the schema that was already written.

Expected ship time: 60-90 minutes including the smoke test verification.
