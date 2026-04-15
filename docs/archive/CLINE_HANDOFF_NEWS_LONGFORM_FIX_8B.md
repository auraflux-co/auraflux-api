# CLINE_HANDOFF_NEWS_LONGFORM_FIX_8B.md

**Author:** Claude Code (dispatched 2026-04-12 late evening, post Fix 7 + code audit)
**For:** Cline (implementation)
**Scope:** News long-form — build the News TV card code that was spec'd in `docs/archive/CLINE_HANDOFF_TWITCH_INTRO_CARD_TO_TV_DESIGN.md` but never actually written. Adds Al Jazeera OG image scraping + per-story TV card generation + second FFmpeg overlay burn for News in the assembly pipeline.
**Ship order:** Single atomic commit.
**Do NOT touch:** NBA, Twitch, short-form code paths. Fix 7's newscast chrome burn (lines 3824-3948) — Fix 8B adds a SECOND burn after the chrome burn completes, the chrome burn itself stays unchanged.
**Before committing:** Re-read `COMMIT_CHECKLIST.md`. Atomic staging (single `git add + commit + push`). STATUS.md update. LONGFORM_FIX_ROTATION.md update.

---

## Context — what's broken, what the real root cause is

Across every News long-form smoke test from Apr 7 through tonight's smoke test #4, Rob has fed back the same complaint: **"no TV card."** I kept misreading this as "the lower-third headline banner inside the Fix 7 newscast chrome" — but that was wrong. When Rob says "TV card" he means the **cross-content top-right `OVERLAY_ZONE` card** that Twitch and NBA use — the 520×293 16:9 rectangle at `{x:1360, y:60}` that displays streamer info (Twitch) or game data (NBA) during each `#_INTRO` scene.

**News was never wired up to use this card, despite the archived handoff `docs/archive/CLINE_HANDOFF_TWITCH_INTRO_CARD_TO_TV_DESIGN.md` asserting at line 57 that "News cards: Open Graph scraped article image + headline + source, formatted as a 640×360 rectangle, burned at `OVERLAY_ZONE`. Both NBA and News use the same burn-in path in /assemble."**

That assertion was aspirational, not descriptive of shipped code. Grep verification:
- `grep -n "generateNewsStory\|generateNewsCard\|generateNewsIntroCard" server.js` → **0 hits**. The function does not exist.
- `grep -n "OVERLAY_ZONE" server.js` → hits only in Twitch and NBA branches. **No News branch invokes OVERLAY_ZONE for a TV card burn.**
- Reading `server.js:3824-3948` (the News assembly branch) end-to-end → only the Fix 7 newscast chrome burn runs. There is zero code that generates or burns a second TV card overlay. The News code path is missing the entire concept.

**Root cause:** the News TV card code was documented as "already working" in the Apr 11 archived handoff, but was never actually implemented in code. The archived doc's sentence misled me across four smoke test diagnoses before I verified it against the actual code tonight.

**Also separately broken, but not in scope for Fix 8B:** Al Jazeera's `all.xml` RSS feed has no video enclosures (verified via live curl against the live feed). So News fundamentally cannot have real video clips via the current ingestion path. `[CLIP PLAYS HERE]` markers in the script will continue to produce no clip insertion. Fix 8B gives each story a visible TV card with the article's OG image, which is the best available per-story visual from Al Jazeera alone. A true "full-bleed image-as-clip" replacement for the `[CLIP PLAYS HERE]` beats is a separate future scope — Fix 8B addresses ONLY the top-right TV card, not the full-bleed mid-story visual.

---

## What Fix 8B builds

Five pieces, in implementation order:

### Piece 1 — Al Jazeera OG image scraper helper

New function `scrapeArticleOgImage(articleUrl)` in `server.js`. Purpose: fetch an article URL via `axios` (already in `package.json`, verified), parse HTML with `cheerio` (already in `package.json`, verified), extract `<meta property="og:image">` content, return the image URL string.

**Verification that Al Jazeera articles have `og:image`:** I tested this directly. `curl`-ing a live Al Jazeera article URL and grepping the response confirms `<meta property="og:image" content="...">` is present with a full-resolution image URL (example: `https://www.aljazeera.com/wp-content/uploads/2026/04/.../IRAN-CRISIS-HORMUZ-1776037765.jpg?resize=1920%2C1440`). Works reliably.

**Function signature:**

```javascript
/**
 * Scrape the Open Graph image URL from an article page.
 * Used for News TV card generation — each Al Jazeera article's og:image
 * becomes the hero image on that story's top-right TV card.
 *
 * @param {string} articleUrl - absolute URL to the article (e.g. https://www.aljazeera.com/...)
 * @returns {Promise<string|null>} - the og:image URL, or null if scraping fails
 */
async function scrapeArticleOgImage(articleUrl) {
  if (!articleUrl) return null;
  try {
    const axios = require('axios');
    const cheerio = require('cheerio');
    const resp = await axios.get(articleUrl, {
      timeout: 10000,
      maxRedirects: 5,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
      }
    });
    const $ = cheerio.load(resp.data);
    // Try og:image first, fall back to twitter:image
    let imgUrl = $('meta[property="og:image"]').attr('content')
              || $('meta[name="twitter:image"]').attr('content')
              || $('meta[name="twitter:image:src"]').attr('content')
              || null;
    if (imgUrl) {
      console.log(`[og-scrape] ✅ ${articleUrl.slice(0, 60)}... → ${imgUrl.slice(0, 80)}`);
    } else {
      console.warn(`[og-scrape] ⚠️  No og:image found: ${articleUrl.slice(0, 60)}...`);
    }
    return imgUrl;
  } catch (e) {
    console.warn(`[og-scrape] ⚠️  Scrape failed for ${articleUrl.slice(0, 60)}...: ${e.message}`);
    return null;
  }
}
```

Place this function near `geminiAnalyzeClip()` at around `server.js:6077` so related helpers live together.

### Piece 2 — Invoke the scraper during News analysis to populate `item.heroImageUrl`

Modify the News analysis block at `server.js:6554-6584` (currently the `else if (type === 'news')` branch inside `/generate-full-script`) to scrape each story's article URL in parallel BEFORE the `geminiAnalyzeClip()` call. Store the result as `item.heroImageUrl`.

**Edit at `server.js:6554-6566` area:**

```javascript
} else {
  // News: prioritize stories by urgency before Gemini analysis
  if (type === 'news' || type === 'news-short') {
    const prioritized = prioritizeNewsStories(items);
    const priorityChange = prioritized.map((s, i) => `${i+1}. ${(s.title||'').slice(0, 40)}`).join(', ');
    console.log(`[generate-full-script] Story priority order: ${priorityChange}`);
    items.splice(0, items.length, ...prioritized);
  }

  // ── NEW (Fix 8B): Scrape og:image per story for TV card background ──
  // Populates item.heroImageUrl on each News item. Used later by assembly-time
  // generateNewsStoryCardPNG() to render the top-right OVERLAY_ZONE TV card.
  // Runs in parallel with Gemini analysis for speed.
  console.log(`[generate-full-script] Scraping og:image for ${items.length} news articles...`);
  const ogImagePromises = items.map(item => scrapeArticleOgImage(item.link || ''));

  // News: try video URL from RSS enclosure first, then thumbnail + full article text
  console.log(`[generate-full-script] Analyzing ${items.length} news stories...`);
  const [ogImages, analysesResult] = await Promise.all([
    Promise.all(ogImagePromises),
    Promise.all(items.map(item => geminiAnalyzeClip(item.videoUrl||'', item.thumbnailUrl||'', 'news', item)))
  ]);
  analyses = analysesResult;

  // Attach scraped og:image URLs to items
  items.forEach((item, i) => {
    item.heroImageUrl = ogImages[i] || item.thumbnailUrl || '';
  });
  const heroHits = items.filter(i => i.heroImageUrl).length;
  console.log(`[generate-full-script] Got ${heroHits}/${items.length} og:image URLs (hero images for TV cards)`);

  const newsHits = analyses.filter(a => a && a.length > 50).length;
  console.log(`[generate-full-script] Got ${newsHits}/${items.length} news analyses`);

  // Build orderedClipUrls for News — unchanged from Fix 1
  if (type === 'news') {
    orderedClipUrls = items.map((item, i) => ({
      // ... unchanged ...
    })).filter(c => c.url);
    console.log(`[generate-full-script] Built News orderedClipUrls: ${orderedClipUrls.length}/${items.length} stories have clip URLs`);
  }
}
```

**Parallelization note:** The `Promise.all([Promise.all(ogImagePromises), Promise.all(analyses)])` pattern runs the OG scraper and the Gemini analysis in parallel so you don't add sequential latency. For 5 stories, this means ~10s for OG scraping concurrently with ~30s for Gemini analysis, total ~30s wall time (not 40s).

### Piece 3 — Persist `heroImageUrl` on the News item job card

Modify the job card save at `server.js:~7192` to include `heroImageUrl` in the persisted `newsItems` array, so the assembly-time code can access it from `card.newsItems[i].heroImageUrl`:

```javascript
newsItems: type === 'news' ? items.map(s => ({
  title:        s.title || '',
  source:       s.source || '',
  category:     s.category || 'WORLD NEWS',
  thumbnailUrl: s.thumbnailUrl || s.imageUrl || '',
  heroImageUrl: s.heroImageUrl || '',  // ← NEW (Fix 8B)
  videoUrl:     s.videoUrl || s.clipUrl || '',
  link:         s.link || s.url || ''
})) : [],
```

### Piece 4 — Wire `heroImageUrl` into `cardData` in the heygen-poller

The heygen-poller attaches `cardData` to `STORY#_INTRO` segments around `server.js:221` (the cardData construction logic added by Fix 2 in batch 1). Extend the cardData object to include `heroImageUrl` so the assembly branch can access it:

```javascript
// Find the existing "cardData" construction for News STORY#_INTRO segments.
// Currently builds: { title, category, storyId, imageUrl, source }
// Add: heroImageUrl from card.newsItems[storyIdx].heroImageUrl
segmentData[segmentData.length - 1].cardData = {
  title:        storyItem.title || `Story ${storyIdx + 1}`,
  category:     storyItem.category || storyItem.source || 'WORLD NEWS',
  storyId:      `story_${storyIdx + 1}`,
  imageUrl:     storyItem.thumbnailUrl || storyItem.imageUrl || null,
  heroImageUrl: storyItem.heroImageUrl || storyItem.thumbnailUrl || null,  // ← NEW
  source:       storyItem.source || ''
};
```

If the existing cardData construction is in more than one place (Fix 2 in batch 1 may have touched heygen-poller in multiple spots), update all of them.

### Piece 5 — Build `generateNewsStoryCardPNG()` Canvas function

New function modeled after `generateIntroCardPNG()` (Twitch) at `server.js:500+`. Places a downloaded hero image as background, overlays story headline + source + gold border. Dimensions match current `OVERLAY_ZONE` at 2× resolution for sharpness.

**Current `OVERLAY_ZONE` from `lib/config.js:55`:** `{x: 1360, y: 60, w: 520, h: 293}`. So the 2× Canvas target is `1040 × 586`.

**Function spec:**

```javascript
/**
 * Generate a News TV card PNG for a single story.
 * Renders at 2× resolution (1040×586) to match OVERLAY_ZONE 520×293 after lanczos scale.
 * Uses the scraped og:image as background, story headline as foreground text, gold border.
 *
 * @param {Object} storyData - { title, category, source, heroImageUrl }
 * @param {string} outputPath - absolute path to write the PNG
 */
async function generateNewsStoryCardPNG(storyData, outputPath) {
  const { createCanvas, loadImage } = require('canvas');
  const axios = require('axios');
  const path = require('path');

  // ── Dimensions (2× of current OVERLAY_ZONE 520×293) ──
  const W = 1040, H = 586;
  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext('2d');

  // Sanitize text
  const title = (storyData.title || 'Breaking News').replace(/\\s+/g, ' ').trim();
  const source = (storyData.source || 'AL JAZEERA').toUpperCase();
  const heroUrl = storyData.heroImageUrl || '';

  // ── Paint background (navy fallback if no image) ──
  ctx.fillStyle = '#0d1424';  // matches --dark CSS variable from clipzworld_newscast.html
  ctx.fillRect(0, 0, W, H);

  // ── Load and draw hero image (scale-to-cover, clipped to canvas) ──
  if (heroUrl) {
    try {
      // Download image to a temp file OR pass the URL directly to loadImage
      // (node-canvas's loadImage supports http URLs natively)
      const heroImg = await loadImage(heroUrl);
      const iw = heroImg.width;
      const ih = heroImg.height;
      // Scale-to-cover: find the scale factor that covers the canvas
      const scaleW = W / iw;
      const scaleH = H / ih;
      const scale = Math.max(scaleW, scaleH);
      const sw = iw * scale;
      const sh = ih * scale;
      const sx = (W - sw) / 2;
      const sy = (H - sh) / 2;
      ctx.drawImage(heroImg, sx, sy, sw, sh);
    } catch (e) {
      console.warn(`[news-card] ⚠️  Failed to load hero image ${heroUrl.slice(0,60)}: ${e.message}`);
      // Fall through with navy background
    }
  }

  // ── Semi-transparent navy gradient at bottom (for headline readability) ──
  const gradY = H * 0.45;  // gradient starts ~45% down
  const grad = ctx.createLinearGradient(0, gradY, 0, H);
  grad.addColorStop(0, 'rgba(13, 20, 36, 0)');      // transparent top
  grad.addColorStop(0.3, 'rgba(13, 20, 36, 0.7)');  // 70% opacity mid
  grad.addColorStop(1, 'rgba(13, 20, 36, 0.95)');   // 95% opacity bottom
  ctx.fillStyle = grad;
  ctx.fillRect(0, gradY, W, H - gradY);

  // ── Source tag (top-left, gold) ──
  ctx.fillStyle = '#c7af4f';
  ctx.font = 'bold 36px Arial';
  ctx.textAlign = 'left';
  ctx.shadowColor = 'rgba(0,0,0,0.8)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 2;
  ctx.fillText(source, 40, 60);
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  // ── Headline text (bottom half, white, word-wrapped) ──
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 56px Arial';
  ctx.textAlign = 'left';
  ctx.shadowColor = 'rgba(0,0,0,0.9)';
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = 4;
  fillTextWrapped(ctx, title, 40, gradY + 80, W - 80, 68);
  ctx.shadowColor = 'transparent';

  // ── Gold border (10px at 2× = 5px final) ──
  ctx.strokeStyle = '#c7af4f';
  ctx.lineWidth = 10;
  ctx.strokeRect(5, 5, W - 10, H - 10);

  // ── Save PNG ──
  const buf = canvas.toBuffer('image/png');
  await require('util').promisify(require('fs').writeFile)(outputPath, buf);

  console.log(`[news-card] ✅ TV card written: ${path.basename(outputPath)} (${title.slice(0,40)})`);
}
```

**`fillTextWrapped()` helper:** reuse the existing one from `generateIntroCardPNG()` (archived handoff lines 222-237 show the signature). If it's not already extracted to a shared helper, either extract it or inline the wrap logic.

### Piece 6 — Invoke `generateNewsStoryCardPNG()` from the assembly branch and add a second FFmpeg overlay burn

Modify the News assembly branch at `server.js:3824-3948`. **The existing Fix 7 newscast chrome burn stays exactly as-is.** Add a second burn step AFTER the chrome burn completes, only on `isStoryIntro === true` segments (not on cold open INTRO or OUTRO).

**Edit inside the `if (isStoryIntro)` block, after the existing two-state burn that ends at `log(asmId, '  📰 NEWS two-state overlay burned...')`:**

```javascript
// ── NEW Fix 8B: Second overlay burn — News TV card at OVERLAY_ZONE ──
// After the chrome burn updates inputForTS to burnedPath, do a second pass
// that adds the story-specific TV card (hero image + headline) in the top-right.
// Matches Twitch/NBA pattern. Only runs on STORY#_INTRO segments.
if (cardData.heroImageUrl || cardData.imageUrl) {
  try {
    const newsCardPngPath = path.join(TMP_DIR, `news_story_card_${Date.now()}.png`);
    const storyCardData = {
      title: cardData.title || 'Breaking News',
      category: cardData.category || 'WORLD NEWS',
      source: cardData.source || 'AL JAZEERA',
      heroImageUrl: cardData.heroImageUrl || cardData.imageUrl
    };
    await generateNewsStoryCardPNG(storyCardData, newsCardPngPath);

    const cardBurnedPath = inputForTS.replace('.mp4', '_news_card_burned.mp4');
    const zone = CONFIG.VISUAL_LAYOUTS.LONG_FORM.OVERLAY_ZONE;
    const burnArgs = [
      '-i', inputForTS,
      '-i', newsCardPngPath,
      '-filter_complex',
      `[1:v]scale=${zone.w}:${zone.h}:flags=lanczos[card];[0:v][card]overlay=x=${zone.x}:y=${zone.y}:enable='lte(t,${introDur})'[out]`,
      '-map', '[out]', '-map', '0:a',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ar', '44100', '-y', cardBurnedPath
    ];

    await new Promise((res, rej) => {
      const proc = execFile(ffmpegPath(), burnArgs, { maxBuffer: 50 * 1024 * 1024 });
      let stderr = '';
      proc.stderr && proc.stderr.on('data', d => { stderr += d.toString(); });
      proc.on('close', code => {
        if (code === 0) res();
        else {
          console.error(`[news-card-burn] FFmpeg exit ${code}: ${stderr.slice(-300)}`);
          rej(new Error(`News TV card burn failed: ${code}`));
        }
      });
      proc.on('error', rej);
    });

    if (fs.existsSync(cardBurnedPath) && fs.statSync(cardBurnedPath).size > 10000) {
      inputForTS = cardBurnedPath;
      log(asmId, `  📺 NEWS TV card burned at OVERLAY_ZONE: ${cardData.title?.slice(0,40) || 'story'}`);
    }

    // Cleanup temp PNG
    try { if (fs.existsSync(newsCardPngPath)) fs.unlinkSync(newsCardPngPath); } catch(e) {}
  } catch (e) {
    log(asmId, `  ⚠️  News TV card burn failed (non-fatal): ${e.message}`);
    // Non-fatal — the chrome burn already ran, just no TV card this time
  }
}
```

**Key design points:**

1. **The TV card burn runs AFTER the chrome burn**, not before. `inputForTS` is already pointing at `burnedPath` from the chrome burn when this code runs. The chain is: HeyGen segment → chrome burn → TV card burn → TS conversion → concat.
2. **Time-gated to match `introDur`** — TV card appears during the first `CONFIG.INTRO_CARD.DURATION_SECONDS` (10s) of each STORY#_INTRO, then hides. Same timing as the Fix 7 lower-third. Viewer sees both the lower-third chrome element AND the top-right TV card during the first 10 seconds.
3. **Scales 1040×586 canvas → 520×293 via `flags=lanczos`** — same pattern Twitch/NBA use for their 1280×720 → 640×360 scaling.
4. **Non-fatal failure handling** — if the TV card burn fails (OG image fetch failed, Canvas error, FFmpeg error), log a warning and skip this segment's card. Chrome burn already applied, so the segment is still visually acceptable, just without the extra card.
5. **Only runs on STORY#_INTRO segments** — the surrounding `if (isStoryIntro)` block is the existing Fix 7 two-state burn branch. Don't add a card to SETUP / SUMMARY / REACTION / cold INTRO / OUTRO.

---

## Files to modify

1. `server.js` — Pieces 1, 2, 3 (heygen-poller if separate), 5, 6 all live in server.js
2. `cwn_production.html` — **probably NOT touched**. The dashboard already populates `item.link` (confirmed via earlier code read). Fix 8B consumes `item.link` server-side, no dashboard changes needed. Verify by grepping for `link:` in the generateNews function and confirming it writes the article URL.
3. `STATUS.md` — Last Agent Action row (pre-commit hook enforces this)
4. `LONGFORM_FIX_ROTATION.md` — move Fix 8B from Dispatched → Shipped with commit hash

---

## Verification (must run before commit)

### 1. Node syntax check

```bash
node -c server.js
```

Expected: exit 0.

### 2. Grep checks

```bash
grep -n "scrapeArticleOgImage\|generateNewsStoryCardPNG\|heroImageUrl" server.js
```

Expected:
- `scrapeArticleOgImage` — at least 2 hits (function definition + caller)
- `generateNewsStoryCardPNG` — at least 2 hits (function definition + caller)
- `heroImageUrl` — at least 4-5 hits (item assignment, newsItems save, heygen-poller cardData, assembly branch read, TV card data object)

### 3. Live endpoint smoke test for the scraper

Before running the full pipeline, verify `scrapeArticleOgImage()` works in isolation:

```bash
node -e "
const s = require('./server.js');
// If scrapeArticleOgImage is not exported, inline the test below instead.
" 2>&1
```

**Inline alternative** (doesn't require exporting the function):

```bash
node -e "
const axios = require('axios');
const cheerio = require('cheerio');
(async () => {
  const url = 'https://www.aljazeera.com/news/2026/4/13/us-military-threatens-to-blockade-all-iranian-ports-starting-on-monday';
  const r = await axios.get(url, {
    timeout: 10000,
    headers: { 'User-Agent': 'Mozilla/5.0 Chrome/120.0 Safari/537.36' }
  });
  const \$ = cheerio.load(r.data);
  const img = \$('meta[property=\"og:image\"]').attr('content');
  console.log('og:image:', img);
})();
" 2>&1
```

Expected: prints a real Al Jazeera image URL starting with `https://www.aljazeera.com/wp-content/uploads/...`. If it doesn't, the scraper won't work in production either — investigate cheerio/axios issues before shipping.

### 4. Generate a single News story card PNG in isolation

After the function is written, add a one-off test command:

```bash
node -e "
const { generateNewsStoryCardPNG } = require('./server.js'); // if exported
generateNewsStoryCardPNG({
  title: 'US military threatens to blockade all Iranian ports starting on Monday',
  category: 'WORLD NEWS',
  source: 'AL JAZEERA',
  heroImageUrl: 'https://www.aljazeera.com/wp-content/uploads/2026/04/2026-04-12T105733Z_2123040405_RC2GNKA77QI7_RTRMADP_3_IRAN-CRISIS-HORMUZ-1776037765.jpg?resize=1920%2C1440'
}, '/tmp/news_card_test.png').then(() => {
  console.log('Wrote /tmp/news_card_test.png');
});
" 2>&1
file /tmp/news_card_test.png
```

Expected: `PNG image data, 1040 x 586, 8-bit/color RGB`. Open in Preview to visually inspect. If `generateNewsStoryCardPNG` is not exported from server.js, skip this step and rely on the full smoke test verification.

### 5. Nodemon clean restart

After saving files, watch nodemon output. Expected: no errors, server boots cleanly on port 3000 within ~2 seconds.

---

## Commit strategy

**Single atomic commit.**

```
fix(news): Fix 8B — build News TV card (og:image scrape + OVERLAY_ZONE burn)

Implements the News TV card functionality that the archived handoff
docs/archive/CLINE_HANDOFF_TWITCH_INTRO_CARD_TO_TV_DESIGN.md described as
"already working" but never actually existed in code. Rob has fed back "no
TV card" on every News smoke test from Apr 7 through #4 — verified tonight
via grep audit that no generateNewsStoryCardPNG function exists and no News
branch in /assemble invokes OVERLAY_ZONE for a second TV card burn.

Fix 8B adds five pieces:

1. scrapeArticleOgImage(articleUrl) helper — fetches article via axios, parses
   HTML with cheerio, returns og:image URL. Verified against live Al Jazeera
   article (og:image tag present and valid).

2. News analysis block (server.js:~6554) — runs og:image scraping in parallel
   with Gemini analysis, attaches result as item.heroImageUrl on each story.

3. Job card save (server.js:~7192) — persists heroImageUrl in newsItems.

4. heygen-poller cardData construction — extends cardData for STORY#_INTRO
   segments to include heroImageUrl so assembly can access it.

5. generateNewsStoryCardPNG(storyData, outputPath) — Canvas renderer at 2×
   resolution (1040×586 for OVERLAY_ZONE 520×293). Scales hero image to cover,
   draws gradient for readability, overlays source tag + headline + gold
   border. Modeled on generateIntroCardPNG (Twitch) pattern.

6. Assembly branch (server.js:3824-3948) — inside the existing Fix 7
   isStoryIntro block, adds a second FFmpeg overlay burn AFTER the chrome
   burn completes. Generates story-specific card PNG, burns at OVERLAY_ZONE
   with enable='lte(t,introDur)' time-gating to match the lower-third timing.
   Non-fatal on failure — logs warning and skips the card, chrome burn still
   applies.

What this does NOT fix:
- News still has no video clips in [CLIP PLAYS HERE] beats between SETUP and
  SUMMARY. Al Jazeera RSS/HTML contains no video content, verified via live
  curl + grep. The TV card with og:image is the best available per-story
  visual from the single locked source (Al Jazeera). A full-bleed image-as-
  clip replacement for the clip beats is separate future scope.
- Gate 3 LATE-sample outro false positive — unchanged, still -10.
- NBA long-form live-narration rework — separate rotation item.

Verification:
- node -c server.js exit 0
- Live og:image scrape against Al Jazeera article returns valid URL
- Grep confirms new function names present + heroImageUrl field plumbed

References: LONGFORM_FIX_ROTATION.md News batch 5, archived handoff
docs/archive/CLINE_HANDOFF_TWITCH_INTRO_CARD_TO_TV_DESIGN.md line 57 for the
target design pattern.
```

Per `COMMIT_CHECKLIST.md`:

1. **Atomic staging:**
   ```bash
   git add server.js STATUS.md LONGFORM_FIX_ROTATION.md && git commit -m "..." && git push
   ```
   Do NOT split `git add` and `git commit` across tool calls.

2. **Update `STATUS.md`** 🤖 Last Agent Action table with this task + commit hash + timestamp.

3. **Update `LONGFORM_FIX_ROTATION.md`** — move Fix 8B from `📤 Dispatched to Cline` → `✅ Shipped` with commit hash. Add rotation log entry.

---

## Testing checklist (Cline runs BEFORE committing)

- [ ] `node -c server.js` exit 0
- [ ] Grep: `scrapeArticleOgImage` + `generateNewsStoryCardPNG` + `heroImageUrl` all show expected hit counts
- [ ] Inline node test of og:image scraper returns a valid Al Jazeera URL
- [ ] Optional: generate one test News card PNG and visually inspect at /tmp
- [ ] Nodemon restart is clean
- [ ] `git diff` review shows only the 5 pieces above, no unrelated changes
- [ ] STATUS.md + LONGFORM_FIX_ROTATION.md both updated
- [ ] Atomic commit via chained && command

Rob will then run News long-form smoke test #5 from the dashboard to verify the TV card is finally visible.

---

## Rollback plan

If Fix 8B causes any regression:

```bash
git revert HEAD && git push
```

Chrome burn (Fix 7) stays working because it's the first pass and completes before the TV card burn runs. If TV card burn fails, the segment has the chrome but no card — which is exactly the state that shipped on smoke test #4 today. So even a failed revert-scenario is no worse than current production.

---

## What this fix does NOT solve

1. **News still has no source video clips** in `[CLIP PLAYS HERE]` beats between SETUP and SUMMARY. Al Jazeera RSS/HTML genuinely does not contain video. The TV card with og:image is the per-story visual. If you want full-bleed image-as-clip (Ken Burns animated image replacing the missing video clip), that's a separate future fix — not in Fix 8B.
2. **Gate 3 LATE-sample outro false positive** — still -10 points per run. Separate Gate 3 prompt fix needed eventually. Not test-blocking.
3. **NBA long-form live-narration rework** — completely separate rotation item. Fix 8B is News-only.
4. **Per-story segment-tag category** — the top-right `.segment-tag` element in `clipzworld_newscast.html` was supposed to update per active story. Fix 7 wired that in via the `activeCategory` param. Fix 8B does not touch it. If the segment tag is not visually updating, that's a Fix 7 issue to debug separately.

---

## Why this works (teaching section)

**The key realization:** the "News TV card" feedback Rob kept giving was not about the Fix 7 lower-third inside the newscast chrome. It was about the same cross-content `OVERLAY_ZONE` TV card that Twitch and NBA have had all along. I misread "TV card" as "the lower-third headline" across four smoke tests before tonight's code audit, because the archived handoff asserted News already had the card wired up when it actually didn't.

**The lesson for future agents:** when a handoff doc describes a feature as "already working" and user feedback consistently contradicts that, the doc is probably wrong. Verify with `grep` on the function names the doc references before trusting it as the spec. Tonight's grep: `generateNewsStoryCardPNG` returns 0 hits in `server.js`. If I'd run that grep on Apr 7 when the first News feedback came in, Fix 8B could have shipped a week ago instead of tonight.

**Fix 8B uses the same pattern three times over:** Twitch has `generateIntroCardPNG()`, NBA has `generateGameStoryCardPNG()`, News now has `generateNewsStoryCardPNG()`. All three produce 2×-resolution Canvas PNGs that get scaled down via FFmpeg `lanczos` to the `OVERLAY_ZONE` dimensions during burn. Fully consistent architecture across content types, finally.

**The og:image scraping approach is the right call because:**
- It's constrained to Al Jazeera per Rob's directive ("the only search is on Al Jazeera for news")
- Al Jazeera articles reliably expose `og:image` (verified tonight)
- No third-party APIs, no API keys, no rate limits
- No copyright questions — we're showing the article's own official image
- Works tonight with zero new dependencies (axios + cheerio already in package.json)

**The `[CLIP PLAYS HERE]` gap is real but acceptable for now** because Fix 8B gives each story a visible per-story visual (the TV card) during the intro beat. The SETUP/SUMMARY clip beats still don't play any visual content, but that's a Gemini prompt issue (Fix 6 can be tuned later to not reference "the clip" in SETUP/SUMMARY narration) rather than a pipeline issue. One step at a time.
