# CLINE_HANDOFF_GATE0_NEWS_SCRAPER.md
→ Agent: Cline-A

**Author:** Claude Code, 2026-04-15
**Size:** M — `server.js` (2 new functions + 1 endpoint replacement) + `lib/assembly.js` (1 download-phase edit)
**Blocked by:** Nothing — no active locks on server.js or assembly.js at time of writing (check STATUS.md before starting)

---

## Problem

The current news clip pipeline is architecturally backwards:

1. **Operator picks articles → system tries to find clips for them** — Dashboard sends specific article URLs in `items[]`. Then `scrapeArticleVideo()` hunts for a Brightcove video in each article (static HTML, low hit rate). Gate 0 fails when 1-2 articles have no video.
2. **Wrong source:** `GET /news/us-canada-videos` was scraping AJ `/video/newsfeed/` — 9:16 vertical social clips, wrong for 16:9 long-form.
3. **Wrong scraper:** Static HTML can't see Brightcove — AJ renders the player client-side via JavaScript. Only Puppeteer with network interception can capture HLS URLs.

**Correct architecture — pool-first:**

```
scrapeAjNewsVideos() → 8-12 confirmed-video topics
  ↓
Gemini receives confirmed pool as "available today's stories"
  ↓
Gemini writes episode from pool topics only
  ↓
Gate 0 (Gemini QA): confirms each story in the script has a clip from the pool
  ↓  PASS → proceed
  ↓  FAIL → Gemini rewrites with pool topics that do have clips
```

Gemini never writes about a story it doesn't have a clip for — because the pool is all it's given. Gate 0 is a Gemini QA check ("did you use clips from the pool?"), not a clip-hunting step.

**Validated approach:** `scripts/test_aj_puppeteer_scrape.js` confirmed: sitemap-driven Puppeteer scraper → 20 candidates → 11 with video (6 native 16:9 + 5 portrait 9:16). Tested 2026-04-15.

---

## What to Build

### Overview

| Step | What | Where |
|------|------|-------|
| 1 | `fetchAjSitemapUrls(date, topicKeywords)` — axios sitemap fetch + filter | `server.js` |
| 2 | `scrapeAjNewsVideos(topicKeywords, maxCheck)` — Puppeteer browser + Brightcove intercept | `server.js` |
| 3 | `buildAjPillarboxFilter(w, h)` — FFmpeg filter for 9:16 clips | `server.js` |
| 4 | Replace `GET /news/us-canada-videos` — run Puppeteer scraper, return confirmed-video pool only | `server.js` |
| 5 | Wire `scrapeAjNewsVideos()` at `/generate-full-script` start; pass pool to `handleGenerateFullScript`; Gemini receives pool as the story list — **not** `items[]` from dashboard | `server.js` + `lib/script_gen.js` |
| 6 | Gate 0 Gemini QA — validate each script story has a pool clip assigned; fail+rewrite if not | `lib/script_gen.js` or `lib/qa.js` |
| 7 | Apply `pillarboxFilter` in assembly download phase if portrait clip | `lib/assembly.js` |

**Note on Step 5:** The `items[]` input from the dashboard (selected article URLs) is bypassed for news. The Puppeteer pool becomes `items`. Dashboard only needs to send `type: 'news'` and `count: 5` — the server builds the story list from today's confirmed clips.

---

## Implementation

### Locate insertion point in server.js

All 6 new functions go in a new block just **before** the `GET /news/us-canada-videos` endpoint (currently at line 2051). Add a section header comment to keep it findable.

---

### Step 1 — `fetchAjSitemapUrls()`

Add after the existing news helper functions, before `app.get('/news/us-canada-videos', ...)`:

```javascript
// ── AJ Sitemap-driven article discovery ──────────────────────────────────────
// Fetches Al Jazeera's per-day sitemap XML, filters to US-topic news articles.
// Excludes: /liveblog/ /video/ /longform/ /podcasts/ (no video or wrong format)
// Returns array of article URL strings.
const US_KEYWORDS = [
  'us-', '-us-', 'trump', 'america', 'american', 'washington', 'congress',
  'senate', 'white-house', 'pentagon', 'canada', 'mexico', 'nato', 'iran-us',
  'us-iran', 'tariff', 'fentanyl', 'deportation', 'immigration', 'border',
  'fbi', 'cia', 'doge'
];

async function fetchAjSitemapUrls(date = new Date(), topicKeywords = US_KEYWORDS) {
  const yyyy = date.getFullYear();
  const mm   = String(date.getMonth() + 1).padStart(2, '0');
  const dd   = String(date.getDate()).padStart(2, '0');
  const sitemapUrl = `https://www.aljazeera.com/sitemap.xml?yyyy=${yyyy}&mm=${mm}&dd=${dd}`;

  console.log(`[fetchAjSitemapUrls] Fetching ${sitemapUrl}`);
  const resp = await axios.get(sitemapUrl, {
    timeout: 15000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CWN/1.0)' }
  });

  const xml = resp.data || '';
  // Extract all <loc> URLs from the sitemap XML
  const locMatches = xml.match(/<loc>([^<]+)<\/loc>/g) || [];
  const allUrls = locMatches
    .map(m => m.replace(/<\/?loc>/g, '').trim())
    .filter(u => u.startsWith('https://www.aljazeera.com/'));

  // Exclude non-article paths
  const EXCLUDE_PATHS = ['/liveblog/', '/video/', '/longform/', '/podcasts/', '/program/'];
  const articleUrls = allUrls.filter(u => !EXCLUDE_PATHS.some(p => u.includes(p)));

  // Filter to topic-matching articles by keyword overlap on the URL slug
  const matching = articleUrls.filter(u => {
    const slug = u.toLowerCase();
    return topicKeywords.some(kw => slug.includes(kw));
  });

  console.log(`[fetchAjSitemapUrls] ${allUrls.length} total → ${articleUrls.length} articles → ${matching.length} topic-matching`);
  return matching;
}
```

---

### Step 2 — `scrapeAjNewsVideos()`

Add immediately after `fetchAjSitemapUrls`. This is the core Puppeteer function.

```javascript
// ── AJ Puppeteer video scraper ────────────────────────────────────────────────
// Opens a Puppeteer browser, loads up to maxCheck articles, intercepts Brightcove
// API network responses to capture HLS URLs directly, checks manifest dimensions.
// Returns array of { articleUrl, videoId, hlsUrl, orientation, pillarboxFilter }
// orientation: 'landscape' (16:9) | 'portrait' (9:16)
// pillarboxFilter: null for landscape, FFmpeg filter string for portrait
//
// Brightcove account: 665003303001
// HLS served at manifest.prod.boltdns.net
async function scrapeAjNewsVideos(topicKeywords = US_KEYWORDS, maxCheck = 20) {
  const puppeteer = require('puppeteer');
  const results = [];

  // Fetch today's and yesterday's sitemap URLs
  const today     = new Date();
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);

  let candidateUrls = [];
  try {
    const [todayUrls, yestUrls] = await Promise.all([
      fetchAjSitemapUrls(today, topicKeywords),
      fetchAjSitemapUrls(yesterday, topicKeywords)
    ]);
    candidateUrls = [...todayUrls, ...yestUrls];
  } catch (e) {
    console.warn(`[scrapeAjNewsVideos] Sitemap fetch error: ${e.message}`);
    return [];
  }

  if (candidateUrls.length === 0) {
    console.warn('[scrapeAjNewsVideos] No candidate URLs from sitemap');
    return [];
  }

  const toCheck = candidateUrls.slice(0, maxCheck);
  console.log(`[scrapeAjNewsVideos] Checking ${toCheck.length} articles with Puppeteer...`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  try {
    for (const articleUrl of toCheck) {
      let capturedHls   = null;
      let capturedVideoId = null;

      const page = await browser.newPage();
      try {
        // Intercept Brightcove API calls to capture HLS manifests
        await page.setRequestInterception(true);
        page.on('request', req => req.continue());

        page.on('response', async resp => {
          const url = resp.url();
          // Brightcove playback API returns JSON with HLS sources
          if (url.includes('edge.api.brightcove.com') ||
              url.includes('/accounts/665003303001/videos/')) {
            try {
              const json = await resp.json();
              const sources = json.sources || [];
              // Prefer HLS manifest (application/x-mpegURL or .m3u8)
              const hls = sources.find(s =>
                (s.type === 'application/x-mpegURL' ||
                 (s.src && s.src.includes('.m3u8'))) &&
                s.src && s.src.includes('manifest.prod.boltdns.net')
              );
              if (hls && hls.src && !capturedHls) {
                capturedHls = hls.src;
                capturedVideoId = json.id || url.match(/videos\/(\d+)/)?.[1] || null;
                console.log(`[scrapeAjNewsVideos] Captured HLS for ${articleUrl.slice(-60)}: ${hls.src.slice(0, 80)}`);
              }
            } catch (_) {}
          }
        });

        await page.goto(articleUrl, { waitUntil: 'networkidle2', timeout: 20000 });
        // Scroll to trigger lazy-loaded players
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
        await new Promise(r => setTimeout(r, 2000));

      } catch (e) {
        console.warn(`[scrapeAjNewsVideos] Page error on ${articleUrl.slice(-60)}: ${e.message}`);
      } finally {
        await page.close();
      }

      if (!capturedHls) continue;

      // Check manifest dimensions to determine orientation
      let orientation   = 'landscape';
      let pillarboxFilter = null;
      let manifestWidth  = 1920;
      let manifestHeight = 1080;
      try {
        const manifestResp = await axios.get(capturedHls, { timeout: 10000 });
        const manifestText = manifestResp.data || '';
        // HLS master manifests include RESOLUTION=WxH in variant lines
        const resMatches = [...manifestText.matchAll(/RESOLUTION=(\d+)x(\d+)/g)];
        if (resMatches.length > 0) {
          // Use the largest variant for dimension check
          const dims = resMatches.map(m => ({ w: parseInt(m[1]), h: parseInt(m[2]) }));
          dims.sort((a, b) => (b.w * b.h) - (a.w * a.h));
          manifestWidth  = dims[0].w;
          manifestHeight = dims[0].h;
          if (manifestHeight > manifestWidth) {
            orientation = 'portrait';
            pillarboxFilter = buildAjPillarboxFilter(manifestWidth, manifestHeight);
          }
        }
      } catch (e) {
        console.warn(`[scrapeAjNewsVideos] Manifest check failed: ${e.message}`);
      }

      results.push({
        articleUrl,
        videoId:        capturedVideoId,
        hlsUrl:         capturedHls,
        orientation,
        pillarboxFilter,
        sourceWidth:    manifestWidth,
        sourceHeight:   manifestHeight
      });

      console.log(`[scrapeAjNewsVideos] ✅ ${orientation.toUpperCase()} ${manifestWidth}x${manifestHeight}: ${articleUrl.slice(-60)}`);
    }
  } finally {
    await browser.close();
  }

  const landscape = results.filter(r => r.orientation === 'landscape').length;
  const portrait  = results.filter(r => r.orientation === 'portrait').length;
  console.log(`[scrapeAjNewsVideos] Done: ${results.length} with video (${landscape} landscape, ${portrait} portrait)`);
  return results;
}
```

---

### Step 3 — `buildAjPillarboxFilter()`

Add immediately after `scrapeAjNewsVideos`:

```javascript
// ── AJ pillarbox filter builder ───────────────────────────────────────────────
// Builds an FFmpeg complex filter string that:
//   1. Scale-pads a 9:16 portrait clip to 1920x1080 16:9 frame
//   2. Fills side bars with Navy #22304b
//   3. Draws 4px Gold #c7af4f seam borders between content and bars
// w/h = source clip dimensions (e.g. 1080x1920)
// Output: ready to pass as -vf value in ffmpeg call
function buildAjPillarboxFilter(w, h) {
  // Target output: 1920x1080 16:9
  const targetW = 1920;
  const targetH = 1080;

  // Scale to fit height, then pad width with navy sides
  // scale height to 1080, compute scaled width, center in 1920
  const filter = [
    // Step 1: scale to target height, preserve aspect
    `scale=-2:${targetH}`,
    // Step 2: pad to target width with navy background
    `pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2:color=0x22304b`,
    // Step 3: gold seam left border (4px, full height)
    `drawbox=x='(${targetW}-iw)/2-4':y=0:w=4:h=${targetH}:color=0xc7af4f@1.0:t=fill`,
    // Step 4: gold seam right border (4px, full height)
    `drawbox=x='(${targetW}+iw)/2':y=0:w=4:h=${targetH}:color=0xc7af4f@1.0:t=fill`
  ].join(',');

  return filter;
}
```

**Note on drawbox expressions:** The `(${targetW}-iw)/2-4` and `(${targetW}+iw)/2` expressions use FFmpeg's `iw` variable which refers to the video stream width AFTER the pad step. This works correctly because drawbox is applied as a chain filter after pad.

---

### Step 4 — Replace `GET /news/us-canada-videos` endpoint

**CRITICAL ARCHITECTURE NOTE:** The endpoint must run `scrapeAjNewsVideos()` (Puppeteer with Brightcove interception) and return **ONLY articles that have confirmed HLS video**. The dashboard shows these to Rob — if the endpoint returns text-only articles, Rob picks them, Gate 0 fails. The sitemap alone is not enough. Puppeteer confirmation is required.

The existing endpoint (lines 2051-2151) scrapes `/video/newsfeed/` URLs. Replace the **entire try-block body** with `scrapeAjNewsVideos()`. Remove Track C validation entirely (Track C ran yt-dlp on /news/ article pages — it always failed on JS-rendered Brightcove pages; it was already removed).

Find the block starting at line 2051:
```javascript
app.get('/news/us-canada-videos', async (req, res) => {
  try {
    const resp = await axios.get(NEWS_SOURCE_URL, {
```

Replace the **entire endpoint** with:

```javascript
app.get('/news/us-canada-videos', async (req, res) => {
  try {
    // ── Puppeteer-confirmed AJ video pool ────────────────────────────────────
    // Runs scrapeAjNewsVideos(): sitemap discovery → Puppeteer → Brightcove intercept.
    // Returns ONLY articles with confirmed HLS video URLs.
    // The dashboard shows these to the operator — text-only articles are excluded.
    // Typical results: 6-12 confirmed videos from today+yesterday's sitemap.
    console.log('[news/us-canada-videos] Running Puppeteer AJ scraper...');
    const ajVideos = await scrapeAjNewsVideos(US_KEYWORDS, 20);
    console.log(`[news/us-canada-videos] Scraped ${ajVideos.length} confirmed video articles`);

    // Convert to the video object shape the dashboard expects
    const videos = ajVideos.map(v => {
      const dateMatch = v.articleUrl.match(/\/(\d{4})\/(\d{1,2})\/(\d{1,2})\//);
      let publishedAt = new Date().toISOString();
      if (dateMatch) {
        const [_, yyyy, mm, dd] = dateMatch;
        publishedAt = new Date(`${yyyy}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}T23:59:59Z`).toISOString();
      }
      const slug = v.articleUrl.split('/').filter(Boolean).pop() || '';
      const title = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

      return {
        url:          v.articleUrl,
        href:         v.articleUrl.replace('https://www.aljazeera.com', ''),
        title:        title || '(untitled)',
        thumbnail:    null,
        publishedAt,
        hlsUrl:       v.hlsUrl,
        orientation:  v.orientation,       // 'landscape' | 'portrait'
        pillarboxFilter: v.pillarboxFilter  // null or FFmpeg filter string
      };
    });

    videos.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

    return res.json({
      videos,
      recentCount: videos.length,
      source: 'AJ sitemap (today+yesterday) — Puppeteer Brightcove confirmed',
      landscape: videos.filter(v => v.orientation === 'landscape').length,
      portrait:  videos.filter(v => v.orientation === 'portrait').length
    });
  } catch (err) {
    console.error('[news/us-canada-videos] Error:', err.message);
    return res.status(500).json({ error: err.message, videos: [], recentCount: 0 });
  }
});
```

**Note:** This replaces the entire endpoint body including Track C. Track C validation (`yt-dlp` on /news/ article pages) was removed in a prior fix — it always failed on JS-rendered Brightcove pages and produced false negatives. The Puppeteer `scrapeAjNewsVideos()` call IS the validation now — if Brightcove API fires, the clip is real.

---

### Step 5 — Wire `scrapeAjNewsVideos()` at news script gen start

In `lib/script_gen.js`, the news branch of `handleGenerateFullScript` starts at line 1415:

```javascript
} else {
  // News: prioritize stories by urgency before Gemini analysis
  if (type === 'news' || type === 'news-short') {
```

**Problem:** `scrapeAjNewsVideos` lives in `server.js` — it cannot be directly called from `lib/script_gen.js` without a circular dep. The correct wiring is: call `scrapeAjNewsVideos()` from **server.js** in the `/generate-full-script` route handler, then pass the resulting `ajVideoPool` into `handleGenerateFullScript` as an option.

**Current `handleGenerateFullScript` signature (server.js line 139):**
```javascript
handleGenerateFullScript(req, res, saveJobCard, startHeyGenPoller)
```

**New signature:**
```javascript
handleGenerateFullScript(req, res, saveJobCard, startHeyGenPoller, ajVideoPool = [])
```

**In server.js route handler (line 2405):**
```javascript
// Before:
app.post('/generate-full-script',
  (req, res) => handleGenerateFullScript(req, res, saveJobCard, startHeyGenPoller)
);

// After:
app.post('/generate-full-script', async (req, res) => {
  const { type } = req.body;
  let ajVideoPool = [];
  if (type === 'news' || type === 'news-short') {
    try {
      console.log('[/generate-full-script] Pre-scraping AJ Puppeteer video pool...');
      ajVideoPool = await scrapeAjNewsVideos(US_KEYWORDS, 20);
      console.log(`[/generate-full-script] ajVideoPool: ${ajVideoPool.length} videos (${ajVideoPool.filter(v=>v.orientation==='landscape').length} landscape, ${ajVideoPool.filter(v=>v.orientation==='portrait').length} portrait)`);
    } catch (e) {
      console.warn(`[/generate-full-script] AJ pre-scrape failed (non-fatal): ${e.message}`);
    }
  }
  handleGenerateFullScript(req, res, saveJobCard, startHeyGenPoller, ajVideoPool);
});
```

**In `lib/script_gen.js`, update `handleGenerateFullScript` signature:**
```javascript
// Line 1103 — change:
async function handleGenerateFullScript(req, res, saveJobCard, startHeyGenPoller) {
// To:
async function handleGenerateFullScript(req, res, saveJobCard, startHeyGenPoller, ajVideoPool = []) {
```

**In the news analysis block (around line 1449), add video pool matching after `scrapedVideoUrls`:**

```javascript
// After existing attachment block (lines 1444-1452):
items.forEach((item, i) => {
  item.heroImageUrl = ogImages[i] || item.thumbnailUrl || '';
  if (scrapedVideoUrls[i]) {
    item.videoUrl = scrapedVideoUrls[i];
  }
});

// ADD: Override with Puppeteer-scraped AJ video pool if available and better
// matchStoryToAjVideo() is exported from server.js — pass it in via opts, OR
// inline the match logic here using ajVideoPool directly.
if (ajVideoPool && ajVideoPool.length > 0) {
  items.forEach(item => {
    const match = matchStoryToAjVideo(item.title || item.link || '', ajVideoPool);
    if (match) {
      item.videoUrl         = match.hlsUrl;
      item.pillarboxFilter  = match.pillarboxFilter || null; // null for landscape
      item.sourceOrientation = match.orientation;
      console.log(`[news-video-match] "${(item.title||'').slice(0,40)}" → ${match.orientation} HLS from ${match.articleUrl.slice(-60)}`);
    }
  });
  const poolHits = items.filter(i => i.sourceOrientation).length;
  console.log(`[news-video-match] ${poolHits}/${items.length} stories matched to AJ Puppeteer pool`);
}
```

**Important:** `matchStoryToAjVideo` must be importable in `lib/script_gen.js`. Since it's a pure utility function with no server deps, add it to `lib/script_gen.js` directly (not exported from `server.js`). See Step 6.

---

### Step 6 — `matchStoryToAjVideo()`

Add to `lib/script_gen.js` (anywhere before `handleGenerateFullScript`, e.g. near the top with other helpers):

```javascript
// ── AJ video pool keyword matcher ────────────────────────────────────────────
// Matches a news story title/URL to the best video in the AJ Puppeteer pool.
// Scoring: 1 point per shared keyword between storyTopic and article URL slug.
// Returns the highest-scoring pool entry, or null if no overlap found.
function matchStoryToAjVideo(storyTopic, ajVideoPool) {
  if (!ajVideoPool || ajVideoPool.length === 0) return null;

  const topicWords = (storyTopic || '').toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .split(/[\s-]+/)
    .filter(w => w.length > 3); // ignore short stop-words

  if (topicWords.length === 0) return null;

  let bestMatch = null;
  let bestScore = 0;

  for (const entry of ajVideoPool) {
    const slug = (entry.articleUrl || '').toLowerCase();
    let score = 0;
    for (const word of topicWords) {
      if (slug.includes(word)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestMatch = entry;
    }
  }

  // Require at least 2 keyword overlaps to consider it a match
  // (prevents false positives on common words like "said", "new", "says")
  return bestScore >= 2 ? bestMatch : null;
}
```

Export it alongside the other exports at the bottom of `lib/script_gen.js`:

```javascript
// Add to module.exports:
matchStoryToAjVideo,
```

---

### Step 7 — Apply `pillarboxFilter` in assembly download phase

In `lib/assembly.js`, the news clip re-scrape block is at lines 1148-1164. The `pillarboxFilter` needs to be applied during the **normalize step** — not at download time, because the normalize step is where per-clip FFmpeg processing already happens.

Find the normalize step. It is after the download loop — search for `normalizeAudio` or the per-clip FFmpeg normalize command. Add pillarbox application as a pre-normalize video filter when `seg.pillarboxFilter` is set.

The exact insertion point depends on how normalize is structured in your version. The pattern to follow:

```javascript
// In the per-clip normalize loop, after downloading url → localPath:
// Check if this segment has a pillarbox filter (portrait 9:16 AJ clip)
if (seg.pillarboxFilter && localPath) {
  const pillarboxedPath = localPath.replace(/\.mp4$/, '_pillarboxed.mp4');
  log(asmId, `🖼️  Applying pillarbox to portrait clip: ${label}`);
  try {
    await new Promise((resolve, reject) => {
      const args = [
        '-i', localPath,
        '-vf', seg.pillarboxFilter,
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
        '-c:a', 'copy',
        '-y', pillarboxedPath
      ];
      execFile(ffmpegPath, args, { timeout: 120000 }, (err) => {
        if (err) reject(err); else resolve();
      });
    });
    localPath = pillarboxedPath; // use pillarboxed version for normalize + concat
    log(asmId, `✅ Pillarbox applied: ${label}`);
  } catch (e) {
    log(asmId, `⚠️  Pillarbox failed for ${label}: ${e.message} — using original (may have bars)`);
  }
}
```

Place this block **after** the `freshHls` re-scrape block (lines 1152-1164) and **before** the Twitch GQL refresh block (line 1166). The `localPath` variable must already be assigned at this point — verify by reading a few lines of context above.

---

## Files to Modify

| File | Change |
|------|--------|
| `server.js` | Add `US_KEYWORDS` const, `fetchAjSitemapUrls()`, `scrapeAjNewsVideos()`, `buildAjPillarboxFilter()` functions; replace body of `GET /news/us-canada-videos`; update `/generate-full-script` route to pre-scrape `ajVideoPool` |
| `lib/script_gen.js` | Update `handleGenerateFullScript` signature; add `ajVideoPool` wiring in news branch; add `matchStoryToAjVideo()` helper; export it |
| `lib/assembly.js` | Add pillarbox FFmpeg pass in download phase when `seg.pillarboxFilter` is set |

**Do NOT modify:**
- `lib/script_gen.js` `scrapeArticleVideo()` (lines 786-860) — leave as fallback for re-scraping at assembly time

---

## Do Not Break

1. `scrapeArticleVideo()` in `lib/script_gen.js` must remain unchanged — it is the fallback at assembly time for refreshing expired Brightcove tokens (lib/assembly.js lines 1152-1164 call it)
2. The Track C validation pass inside `GET /news/us-canada-videos` must stay intact — only the upstream fetch/parse changes
3. `item.videoUrl` assignment precedence: Puppeteer pool match > `scrapedVideoUrls[i]` > RSS enclosure URL. Never downgrade a URL that already exists.
4. `pillarboxFilter` is nullable — `null` for landscape clips, filter string for portrait. Assembly code must guard with `if (seg.pillarboxFilter)`.
5. `ajVideoPool` defaults to `[]` — if pre-scrape fails (non-fatal), script gen continues without it (falls back to `scrapeArticleVideo()` static HTML method)

---

## Testing

```bash
# 1. Test sitemap fetch directly
node -e "
const axios = require('axios');
const d = new Date();
const mm = String(d.getMonth()+1).padStart(2,'0');
const dd = String(d.getDate()).padStart(2,'0');
axios.get('https://www.aljazeera.com/sitemap.xml?yyyy='+d.getFullYear()+'&mm='+mm+'&dd='+dd)
  .then(r => console.log('sitemap length:', r.data.length, 'chars'))
  .catch(e => console.error(e.message));
"

# 2. Test endpoint — runs Puppeteer, takes 30-45s, returns ONLY video-confirmed articles
# (no jq timeout issues — just wait for the Puppeteer scrape to complete)
curl -s --max-time 120 http://localhost:3000/news/us-canada-videos | jq '.recentCount, .landscape, .portrait, (.videos[0] | {title, orientation})'
# Expected: recentCount: 6-12, landscape: 4-9, portrait: 2-5

# 3. Full news script gen (triggers Puppeteer pre-scrape)
# Use dashboard: Generate Full Script → News → select 5+ stories → Generate
# Watch server logs for:
#   [/generate-full-script] Pre-scraping AJ Puppeteer video pool...
#   [scrapeAjNewsVideos] Checking N articles with Puppeteer...
#   [news-video-match] X/N stories matched to AJ Puppeteer pool
```

**Expected log flow:**
```
[/generate-full-script] Pre-scraping AJ Puppeteer video pool...
[fetchAjSitemapUrls] Fetching https://www.aljazeera.com/sitemap.xml?yyyy=2026&mm=04&dd=15
[fetchAjSitemapUrls] 87 total → 64 articles → 18 topic-matching
[scrapeAjNewsVideos] Checking 18 articles with Puppeteer...
[scrapeAjNewsVideos] Captured HLS for .../trump-tariffs...: https://manifest.prod.boltdns.net/...
[scrapeAjNewsVideos] ✅ LANDSCAPE 1920x1080: .../trump-tariffs...
[scrapeAjNewsVideos] ✅ PORTRAIT 1080x1920: .../us-border-immigration...
[scrapeAjNewsVideos] Done: 11 with video (8 landscape, 3 portrait)
[/generate-full-script] ajVideoPool: 11 videos (8 landscape, 3 portrait)
[news-video-match] "Trump Tariff Policy Reversal" → landscape HLS from ...
[news-video-match] 4/5 stories matched to AJ Puppeteer pool
```

---

## STATUS.md Update (Required)

Before committing, update STATUS.md → `🤖 Last Agent Action` table:

```
| Cline-A | feat(news): Gate-0 sitemap-driven AJ Puppeteer scraper — fetchAjSitemapUrls() + scrapeAjNewsVideos() + buildAjPillarboxFilter() in server.js; matchStoryToAjVideo() in lib/script_gen.js; pillarbox FFmpeg pass in lib/assembly.js download phase; GET /news/us-canada-videos now uses sitemap instead of /video/newsfeed/ | server.js, lib/script_gen.js, lib/assembly.js, STATUS.md | [commit hash] | [timestamp] |
```

Also check `docs/INDEX.md` — update the entry for this handoff to `COMPLETE`.

---

## Background: Why Puppeteer Is Required

AJ's article pages use Brightcove's JavaScript player SDK. The video player is initialized client-side — the `<video>` tag and Brightcove API calls only happen after the page's JS bundle runs. Static HTML scrapers (`axios` + `cheerio`) see the HTML shell but never see the XHR to `/accounts/665003303001/videos/` that returns the signed HLS manifest URL.

The Brightcove Playback API response contains a `sources` array with one or more HLS entries:
```json
{
  "sources": [
    { "type": "application/x-mpegURL", "src": "https://manifest.prod.boltdns.net/..." },
    { "type": "video/mp4", "src": "https://house-cloudfront.eu.brightcove.com/..." }
  ]
}
```

The `manifest.prod.boltdns.net` HLS URL is **preferred** — it includes multi-bitrate variants with RESOLUTION tags in the master manifest, letting us detect 16:9 vs 9:16 without downloading the full clip.
