# CLINE HANDOFF: Al Jazeera News Video Scraper (Puppeteer)

**Agent:** Cline-A (Claude Sonnet)  
**Priority:** High — blocks News long-form smoke test  
**Date:** 2026-04-15  
**Prereqs:** `puppeteer` already installed; `axios`, `cheerio` already in package.json

---

## Context

The current news clip source (`scrapeArticleVideo()` in `server.js`) uses static axios+cheerio HTML parsing. It returns 0 usable videos because Al Jazeera's Brightcove player is **JavaScript-rendered** — the `data-video-id` attribute does not exist in raw HTML. It only appears after the page JS runs and the user scrolls to the player.

Additionally, scraping only `/us-canada/` limits discovery to ~10-12 articles. AJ publishes US-relevant content across `/economy/`, `/politics/`, `/sports/`, and `/features/` that never appears on the section page.

**Validated approach (test results from `scripts/test_aj_puppeteer_scrape.js`):**
- Sitemap discovery: `aljazeera.com/sitemap.xml?yyyy=YYYY&mm=MM&dd=DD` — today + yesterday = ~70 articles
- After US-keyword filter: ~20 topic-relevant candidates
- After Puppeteer scroll + Brightcove intercept: 11/20 have video
- 6 confirmed 16:9 native (1080p) — used as-is
- 5 confirmed 9:16 portrait — **kept and pillarboxed** with CWN brand colors (not discarded)
- **Total usable: 11 clips** vs 4 from the old `/us-canada/` page-scrape approach
- HLS manifests at `manifest.prod.boltdns.net` — no policy key needed (browser auth captured via network interception)

**CWN brand pillarbox spec:**
- Navy `#22304b` side bars (primary brand background)
- Gold `#c7af4f` 4px vertical border lines at each seam
- FFmpeg filter: `scale=608:1080,pad=1920:1080:656:0:0x22304b,drawbox=x=656:y=0:w=4:h=1080:color=0xc7af4f@1.0:t=fill,drawbox=x=1260:y=0:w=4:h=1080:color=0xc7af4f@1.0:t=fill`
- Applied at download/normalize time, before assembly concat

---

## What To Build

Replace/extend `scrapeArticleVideo()` in `server.js` with a Puppeteer-based scraper. The scraper is called during news script generation when we need source clip URLs per story.

### New Flow

```
AJ sitemap (today + yesterday)
  → filter: no liveblogs, no /video/, no longform, no podcasts
  → filter: US topic keywords (caller-supplied or default list)
  → Puppeteer: load each article, scroll, waitForSelector('[data-video-id]')
  → intercept network → capture HLS URL from Brightcove API response
  → check HLS manifest for dimensions
      → 16:9: use as-is
      → 9:16: apply FFmpeg pillarbox (Navy #22304b + Gold #c7af4f border)
  → return pool of { hlsUrl, videoIds, articleUrl, orientation, pillarboxFilter? }
```

---

## Implementation Steps

### Step 0: Add sitemap discovery + pillarbox helpers to `server.js`

Add these two helpers near the top of the news scraping section (before `scrapeAjNewsVideos`):

```javascript
// CWN brand colors for pillarbox treatment on portrait clips
const BRAND_NAVY = '0x22304b';
const BRAND_GOLD = '0xc7af4f';

/**
 * Fetch AJ sitemap for a given date and return US-relevant article URLs.
 * No Puppeteer needed — plain HTTP, fast.
 * @param {Date} date
 * @param {string[]} topicKeywords
 */
async function fetchAjSitemapUrls(date, topicKeywords) {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const url = `https://www.aljazeera.com/sitemap.xml?yyyy=${yyyy}&mm=${mm}&dd=${dd}`;

  const resp = await axios.get(url, {
    timeout: 10000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CWN/1.0)' },
  });

  const allUrls = [...resp.data.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);

  return allUrls.filter(u => {
    if (u.includes('/liveblog/') || u.includes('/video/') || u.includes('/longform/') || u.includes('/podcasts/')) return false;
    return topicKeywords.some(kw => u.toLowerCase().includes(kw));
  });
}

/**
 * Build FFmpeg pillarbox filter for a portrait clip → 1920x1080.
 * Navy #22304b fill, Gold #c7af4f 4px seam borders.
 */
function buildAjPillarboxFilter(inputWidth, inputHeight) {
  const targetW = 1920, targetH = 1080;
  const scaledW = Math.round((inputWidth / inputHeight) * targetH);
  const padX = Math.round((targetW - scaledW) / 2);
  return [
    `scale=${scaledW}:${targetH}`,
    `pad=${targetW}:${targetH}:${padX}:0:${BRAND_NAVY}`,
    `drawbox=x=${padX}:y=0:w=4:h=${targetH}:color=${BRAND_GOLD}@1.0:t=fill`,
    `drawbox=x=${targetW - padX - 4}:y=0:w=4:h=${targetH}:color=${BRAND_GOLD}@1.0:t=fill`,
  ].join(',');
}
```

### Step 1: Add `scrapeAjNewsVideo()` to `server.js`

Add this function near the existing `scrapeArticleVideo()` function. It replaces that function for the `news` content type.

```javascript
/**
 * Scrape Al Jazeera for US-relevant articles with Brightcove video.
 * Uses sitemap for discovery (fast, no Puppeteer), Puppeteer for extraction.
 * Accepts both 16:9 native and 9:16 portrait clips (pillarboxed with brand colors).
 *
 * @param {string[]} topicKeywords - Keywords to filter sitemap URLs (default: US_KEYWORDS)
 * @param {number} maxCheck - Max articles to Puppeteer-check (default 20)
 * @returns {Promise<Array>} Array of { articleUrl, videoIds, hlsUrl, orientation, pillarboxFilter? }
 */
async function scrapeAjNewsVideos(topicKeywords = AJ_US_KEYWORDS, maxCheck = 20) {
  const puppeteer = require('puppeteer');

  // Step A: Sitemap discovery — today + yesterday, no Puppeteer needed
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setUTCDate(today.getUTCDate() - 1);

  const [todayUrls, yesterdayUrls] = await Promise.all([
    fetchAjSitemapUrls(today, topicKeywords),
    fetchAjSitemapUrls(yesterday, topicKeywords),
  ]);

  const candidateUrls = [...new Set([...todayUrls, ...yesterdayUrls])];
  logger.info({ count: candidateUrls.length }, '[AJ] Sitemap candidates after topic filter');

  if (candidateUrls.length === 0) return [];

  // Step B: Puppeteer extraction — scroll each article, intercept Brightcove API
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const results = [];

  try {
    for (const articleUrl of candidateUrls.slice(0, maxCheck)) {
      if (results.length >= 10) break;

      const page = await browser.newPage();
      const capturedHlsUrls = [];

      await page.setRequestInterception(true);
      page.on('request', req => req.continue());
      page.on('response', async resp => {
        if (resp.url().includes('edge.api.brightcove.com/playback/v1')) {
          try {
            const body = await resp.json();
            (body.sources || []).forEach(s => {
              if (s.type === 'application/x-mpegURL' || (s.src && s.src.includes('.m3u8'))) {
                capturedHlsUrls.push(s.src);
              }
            });
          } catch (_) {}
        }
      });

      try {
        await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
        await page.goto(articleUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

        for (let i = 0; i < 5; i++) {
          await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
          await new Promise(r => setTimeout(r, 400));
        }
        try { await page.waitForSelector('[data-video-id]', { timeout: 4000 }); } catch (_) {}

        const videoIds = await page.evaluate(() => {
          const ids = new Set();
          document.querySelectorAll('[data-video-id]').forEach(el => {
            const id = el.getAttribute('data-video-id');
            if (id && /^\d+$/.test(id)) ids.add(id);
          });
          return [...ids];
        });

        if (capturedHlsUrls.length === 0) { await page.close(); continue; }

        const hlsUrl = capturedHlsUrls[0];

        // Check dimensions — keep both 16:9 and 9:16, tag appropriately
        let orientation = 'landscape'; // default assumption
        let pillarboxFilter = null;
        try {
          const manifResp = await axios.get(hlsUrl, { timeout: 6000, responseType: 'text' });
          const resMatches = [...manifResp.data.matchAll(/RESOLUTION=(\d+)x(\d+)/g)];
          if (resMatches.length > 0) {
            const dims = resMatches.map(m => ({ w: parseInt(m[1]), h: parseInt(m[2]) }));
            const max = dims.reduce((a, b) => (a.w > b.w ? a : b));
            if (max.w < max.h) {
              orientation = 'portrait';
              pillarboxFilter = buildAjPillarboxFilter(max.w, max.h);
            }
          }
        } catch (_) {}

        results.push({
          articleUrl,
          videoIds,
          hlsUrl,
          orientation,
          pillarboxFilter, // null for 16:9 native, FFmpeg filter string for 9:16
          title: articleUrl.split('/').filter(Boolean).pop().replace(/-/g, ' '),
        });

        logger.info({ articleUrl, orientation, videoIds }, '[AJ] Found usable video');

      } catch (e) {
        logger.warn({ articleUrl, err: e.message }, '[AJ] Article check failed');
      } finally {
        await page.close();
      }

      await new Promise(r => setTimeout(r, 300));
    }
  } finally {
    await browser.close();
  }

  return results;
}

// Default US topic keywords — passed to fetchAjSitemapUrls
const AJ_US_KEYWORDS = [
  'us-', '-us-', 'trump', 'america', 'american', 'washington', 'congress',
  'senate', 'white-house', 'pentagon', 'canada', 'mexico', 'nato',
  'iran-us', 'us-iran', 'tariff', 'fentanyl', 'deportation', 'immigration',
  'border', 'fbi', 'cia', 'doge',
];
```

### Step 2: Wire into news script generation

In `server.js`, find the news script generation section where `scrapeArticleVideo()` is called per story. Replace with a single pre-scrape call at the top of the news generation path:

```javascript
// At the start of news script gen (before geminiScriptGeneration call):
if (contentType === 'news') {
  logger.info('[News] Pre-scraping AJ sitemap for usable video clips...');
  const ajVideos = await scrapeAjNewsVideos(); // uses AJ_US_KEYWORDS + today+yesterday
  logger.info({ count: ajVideos.length, landscape: ajVideos.filter(v => v.orientation === 'landscape').length, portrait: ajVideos.filter(v => v.orientation === 'portrait').length }, '[News] AJ video scrape complete');

  if (ajVideos.length > 0) {
    ajVideoPool = ajVideos;
  }
}
```

### Step 3 (assembly): Apply pillarbox filter for portrait clips

When downloading/normalizing news source clips in `lib/assembly.js`, check `clip.pillarboxFilter`:

```javascript
// In the normalize step, after downloading the HLS clip:
if (clip.pillarboxFilter) {
  // Re-encode with pillarbox filter applied
  await execFileAsync(ffmpegPath, [
    '-i', downloadedPath,
    '-vf', clip.pillarboxFilter,
    '-c:v', 'libx264', '-crf', '20', '-preset', 'fast',
    '-c:a', 'aac', '-ar', '44100',
    pillarboxedPath,
  ]);
  // Use pillarboxedPath in the concat list instead of downloadedPath
} else {
  // 16:9 native — normalize as usual
}
```

Then, when assigning clips to stories, pull from `ajVideoPool` instead of calling `scrapeArticleVideo()` per story. Match by keyword overlap between story headline and article slug.

### Step 3: Clip assignment logic

```javascript
/**
 * Match news story topics to scraped AJ video articles by keyword overlap.
 * @param {string} storyTopic - The story headline/topic from the script
 * @param {Array} ajVideoPool - Pre-scraped AJ videos
 * @returns {object|null} Best matching video or null
 */
function matchStoryToAjVideo(storyTopic, ajVideoPool) {
  if (!ajVideoPool || ajVideoPool.length === 0) return null;

  const topicWords = storyTopic.toLowerCase().split(/\s+/).filter(w => w.length > 3);

  let bestMatch = null;
  let bestScore = 0;

  for (const video of ajVideoPool) {
    const slugWords = video.articleUrl.toLowerCase().split(/[-/]/).filter(w => w.length > 3);
    const score = topicWords.filter(w => slugWords.includes(w)).length;
    if (score > bestScore) {
      bestScore = score;
      bestMatch = video;
    }
  }

  return bestScore >= 1 ? bestMatch : null;
}
```

### Step 4: Browser instance reuse (performance)

For news jobs with 5 stories, we don't want 5 separate browser launches. The `scrapeAjNewsVideos()` function above already handles this — it opens one browser, checks up to 20 articles, then closes. This single call happens once per news job at script gen time.

**Estimated timing:** ~30-45 seconds for 10-15 articles (Puppeteer is ~2-3s per page with scrolling).

---

## Testing

Run the test script first to confirm the approach still works:
```bash
node scripts/test_aj_puppeteer_scrape.js
```

Expected: `✅ CONFIRMED: AJ /us-canada/ /news/ articles contain 4+ usable 16:9 Brightcove videos`

Then run a news long-form smoke test via the dashboard. Verify:
1. Gate 1 script shows clip URLs assigned to each story
2. Assembly uses HLS URLs (not old article page URLs)
3. Gate 3 video shows actual news footage (not placeholder)

---

## Files to Modify

| File | Change |
|------|--------|
| `server.js` | Add `scrapeAjNewsVideos()`, add `matchStoryToAjVideo()`, wire both into news script gen path |

Do NOT modify `lib/` files for this — this is a self-contained scraper addition to `server.js`.

---

## Known Constraints

1. **Puppeteer timing:** ~30-45s for a full scrape (20 articles). Sitemap fetch is instant. Acceptable at script gen time.
2. **Sitemap is authoritative:** Today's sitemap may have only a few articles early in the day — `today + yesterday` lookback gives ~70 total articles, ~20 US-relevant.
3. **No policy key needed:** HLS URLs captured via Puppeteer network interception. The browser session handles Brightcove auth transparently.
4. **9:16 portrait clips are KEPT:** ~50% of AJ video articles are portrait. Apply `buildAjPillarboxFilter()` at normalize time. Do NOT discard them.
5. **Pillarbox is brand-correct:** Navy `#22304b` (primary brand bg) + Gold `#c7af4f` (primary accent) 4px seam borders. These are the same values used in the newscast chrome.
6. **Do NOT use `/video/newsfeed/` URLs:** These are social-clip-only, always 9:16, lower quality. The sitemap filter already excludes `/video/` paths.
7. **Pool ceiling:** Typically 8-12 usable clips per 2-day window. For a 5-story episode, this is sufficient with room for topic mismatches.

---

## Commit Strategy

Single commit: `feat(news): Puppeteer scraper for AJ 16:9 news video clips`

Update `STATUS.md → 🤖 Last Agent Action` table in the same commit.

---

## Reference

- Test script: `scripts/test_aj_puppeteer_scrape.js`
- AJ Brightcove account: `665003303001`
- HLS base: `manifest.prod.boltdns.net/manifest/v1/hls/v3/clear/665003303001/`
- Sample video IDs confirmed working: `6393159122112`, `6393152133112`, `6393163954112`
