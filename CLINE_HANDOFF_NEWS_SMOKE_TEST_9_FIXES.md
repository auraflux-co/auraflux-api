# CLINE_HANDOFF_NEWS_SMOKE_TEST_9_FIXES.md

**Author:** Claude Code, drafted 2026-04-13 afternoon after test #8 review + upstream root-cause investigation
**For:** Cline
**Scope:** Fix the ROOT CAUSE of News long-form's clip-coverage problem — the scrape source is wrong. Switch from the global Al Jazeera RSS feed (mostly text articles, ~20-30% video hit rate) to the Al Jazeera US/Canada HTML section page (filter to `/video/newsfeed/` paths, 100% video hit rate). Ship upstream hard gate that blocks episode production when fewer than N video-backed stories are available in the last 24 hours. Delete unreliable post-hoc audit tool.
**Do NOT touch:** NBA, Twitch, short-form. Any non-News code path. NBA voiceover V2 handoff is still parked behind News lock.
**Before each commit:** Re-read `COMMIT_CHECKLIST.md`. Atomic staging. STATUS.md update. `LONGFORM_FIX_ROTATION.md` update.

---

## Why this handoff exists

Test #8 shipped with all 10 fixes from `CLINE_HANDOFF_NEWS_SMOKE_TEST_7_FIXES.md`. Smoke test #8 ran and produced `news_monday_april_13_2026_22_avatar_5_clips__1776105542092.mp4`. Everything visually appeared fine, Bobby G looked good, chrome rendered correctly, Gate 2 passed 98/100 with the new regex (Fix 8 verified), assembly was clean.

**But: only 1 of 5 stories had a source clip.**

Rob reviewed the output in VLC and flagged "missing videos threw half the video off." Claude Code ran a Gemini-based clip audit that reported "all 5 clips present." Frame-by-frame extraction via ffmpeg proved Gemini hallucinated 4 of the 5 clips — only the Lafarge clip at 03:45 was real. The other 4 timestamps (00:48, 01:39, 02:26, 03:06) all show Bobby G, not clip footage.

**Two root causes found:**

1. **Upstream source problem.** The dashboard's News fetch hits `https://www.aljazeera.com/xml/rss/all.xml` via rss2json. That RSS feed is dominated by `/news/` path text articles that don't have embedded video. Only rare `/video/newsfeed/` path articles have the JSON-LD VideoObject that Fix 9's `scrapeArticleVideo()` can extract. Hit rate on the global RSS feed is 20-30% by design — it's a text news feed, not a video feed.

2. **Gemini hallucinates clip presence.** When prompted "there should be 5 clips, one per story, with this structure," Gemini 2.5 Flash confidently reports 5 clips with plausible timestamps and descriptions even when only 1 exists. Temperature 0.1 does not prevent this. Gemini fabricates plausible content by inferring from the narration audio what each clip "should be about" and reports those inferences as if it saw them in the video.

**Consequence:** every prior News smoke test has been producing videos with 20-30% clip coverage, and the QA pipeline has been unreliably catching the problem. Sometimes Gate 3's `clipsExpectedButMissing` guard fires (test #8), sometimes it doesn't (tests #4, #6, #7 all auto-proceeded with incomplete clip coverage).

**Rob's decision: no clips, no production.** This handoff ships the upstream fix that makes "no clips" impossible by construction.

---

## Rob's direction (verbatim)

> "news is going to be the easies to pull from so there are always clips whatever is selected from generate will do the math on expected clip count. should be intro and outro of entire episode so 2 * 5 stories * story intro, story setup, clip, story summary, story reaction"

> "we shouldnt need a backup but anything in 24h and exhaust everything here first https://www.aljazeera.com/us-canada/ there are like 15 to choose from but i dont know where the script looks"

> "what is the audit script doing its all about match qa tools with the work prior to end of gate, you cant get by the gate until you pass"

> "we lost 2 hrs with heygen down so we gotta make it back with passing tests through every gate"

Translation:
1. News source is abundant — 15+ stories per day in the US/Canada section. Pull from there.
2. 24-hour lookback window. Older stories are stale.
3. Exhaust all available US/Canada stories before considering any backup source.
4. If fewer than N video-backed stories exist in the window, hard-abort with a clear error — don't silently produce a 1-clip episode.
5. QA tooling has to BLOCK at the gate, not audit after the fact.
6. No more smoke test runs until the fixes land and we're confident every gate passes.

---

## Verified evidence

### The dashboard source URL is wrong

- `cwn_production.html:2989` — `aljazeera: 'https://api.rss2json.com/v1/api.json?rss_url='+encodeURIComponent('https://www.aljazeera.com/xml/rss/all.xml')`
- `cwn_production.html:4356, 4612, 6152, 6259` — same URL, 5 separate references

This RSS feed returns a flat chronological list of everything Al Jazeera publishes globally. Mostly `/news/` path text articles (Middle East news, politics, analysis pieces). Only occasionally includes `/video/newsfeed/` path articles — those are where the actual video lives.

### Test #8's exact scrape results from `data/jobs.json`

```json
"orderedClipUrls": [
  {"pageUrl": ".../news/.../trumps-threat-to-blockade-hormuz...",          "url": null},
  {"pageUrl": ".../news/.../israeli-forces-kill-three-palestinians...",    "url": null},
  {"pageUrl": ".../news/.../pakistan-eyes-narrow-window...",               "url": null},
  {"pageUrl": ".../news/.../at-least-six-killed-in-israeli-strikes...",    "url": null},
  {"pageUrl": ".../video/newsfeed/.../cement-company-lafarge...",          "url": "https://manifest.prod.boltdns.net/..."}
]
```

4 `/news/` paths returned null. 1 `/video/newsfeed/` path returned a real Brightcove HLS URL. **The scraper is working correctly** — `/news/` articles genuinely don't have embedded video. The scraper is being fed the wrong kind of URL.

### The us-canada page is scrapeable and full of video URLs

Verified 2026-04-13 16:15 ET via direct curl:

```bash
$ curl -s https://www.aljazeera.com/us-canada/ | grep -oE 'href="/video/newsfeed/[^"]*"'
```

Returns (today's snapshot):
```
/video/newsfeed/2026/4/12/these-are-people-israel-killed-in-lebanon-on-a-single-day
/video/newsfeed/2026/4/13/eu-no-peace-possible-while-lebanon-is-in
/video/newsfeed/2026/4/13/trump-doubles-down-in-pope-feud-refuses-to-apologise
/video/newsfeed/2026/4/13/trump-says-iran-wants-peace-deal-but-insists-on-no
/video/newsfeed/2026/4/13/what-are-the-pros-and-cons-of-trumps-iranian-naval-blockade
```

**5 unique `/video/newsfeed/` URLs visible on a single fetch of the us-canada section.** Every one of these has a Brightcove embed video by design. The existing `scrapeArticleVideo()` helper will succeed on all 5 because Fix 9's JSON-LD + yt-dlp path is exactly right for `/video/newsfeed/` articles.

Plus 18 additional `/news/` text articles on the same page (Hormuz, Gaza, Pakistan, Lebanon, etc) — those are text articles that don't have video, and they should be ignored.

### RSS.app custom feed — better long-term path, not ready for this handoff

Rob surfaced 2026-04-13 PM that RSS.app can generate custom per-section RSS feeds for Al Jazeera us-canada that update every 15 minutes. This is a **cleaner architecture than HTML scraping** for 4 reasons:

1. **Stable contract:** RSS XML format doesn't change; Al Jazeera's HTML markup might
2. **15-min refresh cadence:** fresh content every 15 min, perfect for a "last 24h" lookback
3. **External scraping:** RSS.app does the scrape, our Node process just parses XML
4. **Less blockable:** Al Jazeera is less likely to block RSS.app's user-agent than ours if we hit the HTML page repeatedly

**Tradeoff:** adds a third-party dependency. If RSS.app goes down, news fetch dies. HTML scrape is self-contained but fragile to Al Jazeera UI changes.

**Decision for this handoff:** ship HTML scraping TODAY as the working baseline. It unblocks test #9 immediately. The RSS.app migration is **Fix 30**, a follow-up after News locks. The two coexist cleanly:

```javascript
const NEWS_SOURCE_URL = process.env.NEWS_RSS_URL  // preferred if set
  || 'https://www.aljazeera.com/us-canada/';       // fallback to HTML scrape
```

When Rob configures RSS.app and sets `NEWS_RSS_URL` in `.env`, the endpoint switches to RSS parsing. No code change required at that time — just restart nodemon.

**For this handoff, implement ONLY the HTML scrape path.** The `.env` fallback pattern is documented below so the future RSS.app swap is a one-line change, but RSS.app integration itself is out of scope until Rob sets up the account.

### Al Jazeera does NOT publish a per-section RSS feed (native)

Verified 2026-04-13 16:10 ET via curl, all returned 404:

```
https://www.aljazeera.com/xml/rss/us-canada.xml
https://www.aljazeera.com/rss/us-canada.xml
https://www.aljazeera.com/xml/rss/us_canada.xml
https://www.aljazeera.com/us-canada/feed/
https://www.aljazeera.com/us-canada/rss/
https://www.aljazeera.com/feed/us-canada
https://www.aljazeera.com/xml/rss/americas.xml
https://www.aljazeera.com/xml/rss/north-america.xml
```

The only Al Jazeera RSS is the global `all.xml`. The us-canada section is HTML-only. This handoff scrapes the HTML page directly.

---

## The 5 fixes in ship order

| # | Fix | File | Effort |
|---|-----|------|--------|
| 25a | New server endpoint `GET /news/us-canada-videos` that scrapes `https://www.aljazeera.com/us-canada/` for `/video/newsfeed/` article URLs, filters to 24h lookback, returns JSON | `server.js` (new endpoint) | 30-45 min |
| 25b | Dashboard switches from rss2json global feed → new `/news/us-canada-videos` endpoint | `cwn_production.html` (5 locations) | 15 min |
| 25c | Pre-Gate-0 hard gate in `/generate-full-script` News block: if `actualClipCount < N`, hard-abort with error before any Gemini/Claude/HeyGen spend | `server.js` News analysis block (~line 6700-6800) | 20 min |
| 28 | Filename metadata bug: `_clips` count in output filename should count REAL `.ts` clip files in tmp, not intended slots | `server.js` filename generator | 10 min |
| 27 | Delete `scripts/audit_news_clips.js` (unreliable Gemini-based audit) + document the Gemini hallucination finding in `GATED_PIPELINE_ARCHITECTURE.md` as a process rule (Gap 29) | delete + doc update | 15 min |

**Total estimated effort: 1.5-2 hours.** Single atomic commit per fix, or bundle 25a+25b+25c as one commit since they're tightly coupled.

---

## Fix 25a — New server endpoint `/news/us-canada-videos`

**File:** `server.js`
**Effort:** 30-45 minutes

### What to build

New Express endpoint that scrapes the Al Jazeera us-canada HTML page, extracts `/video/newsfeed/` article URLs from the last 24 hours, and returns them as JSON.

### Implementation sketch

Near the existing `/news/generate-intro-card` endpoint (around `server.js:4615`, or wherever News-related endpoints are grouped):

```javascript
const cheerio = require('cheerio'); // already in package.json

// Env var override for future RSS.app custom feed (Fix 30 — follow-up handoff)
// When NEWS_RSS_URL is set in .env, the endpoint can switch to RSS parsing.
// For now, only the HTML scrape path is implemented. The env check is here
// so the future RSS.app swap is a one-line change: detect the env var,
// branch to RSS parsing, same JSON output shape.
const NEWS_SOURCE_URL = process.env.NEWS_RSS_URL || 'https://www.aljazeera.com/us-canada/';
const NEWS_LOOKBACK_HOURS = 24;

app.get('/news/us-canada-videos', async (req, res) => {
  try {
    // TODO Fix 30: branch on process.env.NEWS_RSS_URL to parse RSS instead of HTML
    // if (process.env.NEWS_RSS_URL) { return parseRssToVideoList(...); }

    // Fetch the us-canada section HTML page
    const resp = await axios.get(NEWS_SOURCE_URL, {
      timeout: 15000,
      maxRedirects: 5,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
      }
    });
    const html = resp.data || '';
    const $ = cheerio.load(html);

    // Extract all /video/newsfeed/ article URLs
    // Exclude /video/live (livestream) and bare /video/newsfeed/ (section root)
    const videoUrls = new Set();
    $('a[href^="/video/newsfeed/"]').each((i, el) => {
      const href = $(el).attr('href');
      if (!href || href === '/video/newsfeed/' || href === '/video/newsfeed') return;
      if (href.includes('/live')) return;
      // Extract date from URL path pattern /video/newsfeed/YYYY/M/D/slug
      const dateMatch = href.match(/\/video\/newsfeed\/(\d{4})\/(\d{1,2})\/(\d{1,2})\//);
      if (!dateMatch) return;
      videoUrls.add(href);
    });

    // For each unique URL, extract metadata (title, thumbnail, published date)
    const videos = [];
    for (const href of videoUrls) {
      const absoluteUrl = `https://www.aljazeera.com${href}`;
      const dateMatch = href.match(/\/video\/newsfeed\/(\d{4})\/(\d{1,2})\/(\d{1,2})\//);
      const [_, yyyy, mm, dd] = dateMatch;
      const publishedAt = new Date(`${yyyy}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}T00:00:00Z`);

      // Find the title — usually the anchor text or a nearby heading
      // Look for anchors with this href and try to get the associated headline
      let title = '';
      $(`a[href="${href}"]`).each((i, el) => {
        if (title) return;
        // Try anchor text first
        const anchorText = $(el).text().trim();
        if (anchorText && anchorText.length > 10) {
          title = anchorText;
          return;
        }
        // Try parent heading
        const parentHeading = $(el).closest('article, div').find('h3, h2, h1').first().text().trim();
        if (parentHeading) title = parentHeading;
      });

      // Find the thumbnail image (og:image or first img tag near the anchor)
      let thumbnail = null;
      $(`a[href="${href}"]`).each((i, el) => {
        if (thumbnail) return;
        const img = $(el).find('img').first();
        if (img.length) {
          thumbnail = img.attr('src') || img.attr('data-src') || null;
        }
      });

      videos.push({
        url: absoluteUrl,
        href,
        title: title || '(untitled)',
        thumbnail,
        publishedAt: publishedAt.toISOString(),
        dateString: `${yyyy}/${mm}/${dd}`
      });
    }

    // Filter to 24-hour lookback window
    const cutoff = new Date(Date.now() - NEWS_LOOKBACK_HOURS * 60 * 60 * 1000);
    const recent = videos.filter(v => new Date(v.publishedAt) >= cutoff);

    // Sort by published date descending (newest first)
    recent.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

    console.log(`[news/us-canada-videos] Found ${videos.length} video URLs, ${recent.length} within ${NEWS_LOOKBACK_HOURS}h lookback`);

    res.json({
      ok: true,
      source: 'https://www.aljazeera.com/us-canada/',
      lookbackHours: NEWS_LOOKBACK_HOURS,
      totalFound: videos.length,
      recentCount: recent.length,
      videos: recent
    });
  } catch (e) {
    console.error(`[news/us-canada-videos] Fetch failed: ${e.message}`);
    res.status(500).json({ ok: false, error: e.message });
  }
});
```

### Verification

```bash
# After nodemon restart:
curl -s http://localhost:3000/news/us-canada-videos | python3 -m json.tool
```

Expected: JSON with `totalFound >= 5` and `recentCount >= 3` for today's snapshot. Each video entry has an absolute `url` starting with `https://www.aljazeera.com/video/newsfeed/`.

**Important:** do NOT call `scrapeArticleVideo()` from this endpoint. That's the expensive yt-dlp + JSON-LD extraction step. Per-article video scraping happens later in the `/generate-full-script` flow for each story the user actually selected. This endpoint is just a listing discovery layer — it returns article URLs, not Brightcove HLS URLs.

### Commit message

```
feat(news): new endpoint GET /news/us-canada-videos — scrape Al Jazeera us-canada page for /video/newsfeed/ articles (Fix 25a)

Replaces the dashboard's rss2json global feed source which returned
mostly /news/ path text articles (~20-30% video hit rate by design).
The new endpoint scrapes https://www.aljazeera.com/us-canada/ HTML,
extracts all /video/newsfeed/ hrefs (which ARE video articles by
construction), filters to 24h lookback window, and returns JSON with
title + thumbnail + publish date per video.

100% video hit rate expected — every /video/newsfeed/ article has a
Brightcove embed. Per-article Brightcove HLS scraping still happens in
the /generate-full-script flow via the existing scrapeArticleVideo()
helper, unchanged.

No per-section RSS exists for us-canada — Al Jazeera only publishes
global all.xml. Verified 8 candidate URLs all return 404. Direct HTML
scrape is the only viable path.

References: News smoke test #8 post-mortem, Rob directive 2026-04-13
"we shouldnt need a backup but anything in 24h and exhaust everything
here first"
```

---

## Fix 25b — Dashboard switches to new endpoint

**File:** `cwn_production.html`
**Effort:** 15 minutes

### Current state

5 locations in `cwn_production.html` reference the rss2json global feed:

```javascript
// Line 2989, 2992 — NEWS_FEEDS config map
aljazeera: 'https://api.rss2json.com/v1/api.json?rss_url=' + encodeURIComponent('https://www.aljazeera.com/xml/rss/all.xml'),

// Line 4356 — fetchNewsStories helper fallback
var feedUrl = 'https://api.rss2json.com/v1/api.json?rss_url=' + encodeURIComponent('https://www.aljazeera.com/xml/rss/all.xml');

// Line 4612 — main fetchNewsStories() function
var feedUrl = 'https://api.rss2json.com/v1/api.json?rss_url=' + encodeURIComponent('https://www.aljazeera.com/xml/rss/all.xml');

// Line 6152, 6259 — another fallback path
feedUrl = feedUrl || 'https://api.rss2json.com/v1/api.json?rss_url=' + encodeURIComponent('https://www.aljazeera.com/xml/rss/all.xml');
```

### The fix

Replace all 5 references with a single `fetch('/news/us-canada-videos')` call. Update the response parsing to match the new endpoint's JSON shape (which is different from rss2json's shape).

**rss2json response shape (old):**
```json
{
  "status": "ok",
  "items": [
    { "title": "...", "link": "...", "pubDate": "...", "thumbnail": "...", "description": "..." }
  ]
}
```

**New endpoint response shape:**
```json
{
  "ok": true,
  "source": "https://www.aljazeera.com/us-canada/",
  "lookbackHours": 24,
  "totalFound": 5,
  "recentCount": 5,
  "videos": [
    { "url": "https://www.aljazeera.com/video/newsfeed/...", "href": "/video/newsfeed/...",
      "title": "...", "thumbnail": "...", "publishedAt": "2026-04-13T...", "dateString": "2026/4/13" }
  ]
}
```

**Adapter layer in the dashboard** — wrap the new response in the old shape so downstream code doesn't need to change:

```javascript
async function fetchNewsStories() {
  try {
    const resp = await fetch('http://localhost:3000/news/us-canada-videos');
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || 'Failed to fetch');

    // Adapter: convert new shape to the old rss2json shape downstream code expects
    const items = data.videos.map(v => ({
      title: v.title,
      link: v.url,           // was .link in rss2json, is .url in new endpoint
      pubDate: v.publishedAt,
      thumbnail: v.thumbnail,
      description: ''        // new endpoint doesn't return description, ok to leave empty
    }));

    // ... rest of existing code that renders items to the UI ...
  } catch (e) {
    console.error('fetchNewsStories failed:', e);
    // UI error state
  }
}
```

Replace all 5 `feedUrl = ...` references with this pattern.

### Verification

1. Dashboard News section: hit "FETCH TODAY'S STORIES" button
2. Expected: 5+ stories appear, all from Al Jazeera `/video/newsfeed/` path, all within 24h
3. Each story card shows a title, publish date, and thumbnail (if available)
4. Select 5 stories → generate → the next section (Gemini analysis + script gen) fires

### Commit message

```
feat(dashboard): switch News fetch from rss2json global feed → /news/us-canada-videos (Fix 25b)

Five references to api.rss2json.com + aljazeera.com/xml/rss/all.xml
replaced with a single fetch to the new /news/us-canada-videos endpoint.

The global RSS feed was dominated by /news/ path text articles with no
embedded video. The us-canada page lists /video/newsfeed/ articles
which are 100% video by construction.

Adapter layer converts new response shape to the old rss2json shape
downstream code expects, minimizing dashboard-side changes. No impact
on the News analysis block, Gemini script gen, or Gate 1 flow.

Depends on: Fix 25a (/news/us-canada-videos endpoint)

References: News smoke test #8 post-mortem
```

---

## Fix 25c — Pre-Gate-0 hard gate

**File:** `server.js` News analysis block (around line 6700-6800, wherever `items[]` is built with video URLs)
**Effort:** 20 minutes

### What to add

After the News scrape block (where `scrapeArticleVideo()` is called on each item and `item.videoUrl` is populated or left null), add a hard-abort check:

```javascript
// ── Pre-Gate-0: Hard gate on clip count ──────────────────────────
// Rob's rule 2026-04-13: no clips, no production.
// Before any Gemini script generation, Claude Gate 1, or HeyGen token
// spend, verify that EVERY selected story has a valid scraped video URL.
// If the scraper failed on any story, hard-abort with a clear error.
const expectedClipCount = items.length;
const actualClipCount = items.filter(i => i.videoUrl && typeof i.videoUrl === 'string').length;

if (actualClipCount < expectedClipCount) {
  const missingStories = items.filter(i => !i.videoUrl).map(i => i.title || i.link || '(unknown)');
  const errorMsg = `NEWS_CLIP_GATE_FAIL: ${actualClipCount} of ${expectedClipCount} selected stories have video. Missing: ${missingStories.join(' | ')}. Retry with a different selection or wait for fresh content.`;
  console.error(`[news-clip-gate] ${errorMsg}`);
  return res.status(400).json({
    ok: false,
    error: errorMsg,
    errorCode: 'NEWS_CLIP_GATE_FAIL',
    expectedClipCount,
    actualClipCount,
    missingStories
  });
}

console.log(`[news-clip-gate] ✅ PASS — ${actualClipCount}/${expectedClipCount} stories have video, proceeding to Gemini analysis`);
```

### Where exactly to place it

Find the News block in `/generate-full-script` (grep for `contentType === 'news'` or `scrapeArticleVideo`). Place the gate AFTER the scrape loop completes and BEFORE any Gemini/Claude API calls.

### Why this is cheaper than letting it run

Current cost per failed News episode (1 of 5 clips present):
- ~1 Gemini script gen call (~$0.02)
- ~3 Claude Gate 1 QA calls on retries (~$0.05)
- ~22 HeyGen segment renders (~$0.84 at $0.038/segment)
- Gemini Gate 2 review (~$0.01)
- FFmpeg assembly compute (cheap but time)
- Gemini Gate 3 review (~$0.02)
- **Total: ~$0.94 per wasted episode**

Gate 25c catches it before ANY of that spend. Cost to run the gate: 0 additional API calls (just counts an array).

### Error UX on the dashboard

When the dashboard receives a 400 with `errorCode: NEWS_CLIP_GATE_FAIL`, show a clear error message to Rob (operator) in the dashboard UI:

> "Not enough video coverage for today's News batch. X of Y selected stories have video. Missing: [story list]. Refresh story list and try different selections."

Rob can then hit "FETCH TODAY'S STORIES" again, get a fresh list (which now only pulls from `/video/newsfeed/` so this scenario is much less likely), and retry.

**Note:** after Fix 25a + 25b ship, the dashboard should ONLY ever surface `/video/newsfeed/` stories to Rob. Every one of those should pass `scrapeArticleVideo()` successfully. The gate is defensive against edge cases (scrape timeout, yt-dlp failure, Brightcove URL expired, etc) — it shouldn't fire often in practice.

### Verification

Test the gate locally by manually editing one of the items to have `videoUrl: null` before the gate runs:

```javascript
// DEBUG ONLY — do not commit
items[0].videoUrl = null;
// gate should fire, endpoint returns 400
```

Then fire a `/generate-full-script` with that modification. Expected: 400 response with `NEWS_CLIP_GATE_FAIL`. Remove the debug line before committing.

### Commit message

```
feat(news): pre-Gate-0 hard gate blocks episode production when any selected story lacks video (Fix 25c)

Rob's rule 2026-04-13: no clips, no production. Before any Gemini/Claude/
HeyGen spend, verify that every user-selected News story has a valid
scraped videoUrl. If not, hard-abort with NEWS_CLIP_GATE_FAIL error
code and list the missing stories.

Prevents wasted spend on 1-clip-out-of-5 episodes that have been the
consistent failure mode of News smoke tests #4, #6, #7, #8. Rough savings
per prevented episode: ~$0.94 (1 Gemini script gen + 3 Claude QA retries
+ 22 HeyGen renders + Gate 2/3 review).

Error surface: dashboard receives 400 with errorCode and missing-story
list, displays clear message to operator asking them to retry with
fresh selections. The gate is defensive — with Fix 25a+25b shipping
/video/newsfeed/-only stories, this scenario should rarely fire in
practice.

Depends on: Fix 25a + Fix 25b (dashboard source change)

References: News smoke test #8 post-mortem, Rob rule "you cant get
by the gate until you pass"
```

---

## Fix 28 — Filename metadata accurate clip count

**File:** `server.js` filename generator (grep for `_clips_` or filename template)
**Effort:** 10 minutes

### Current state

Test #8 produced `news_monday_april_13_2026_22_avatar_5_clips__1776105542092.mp4`. The `5_clips` metadata is wrong — only 1 actual clip file (`story5_clip_5_.ts`) was assembled. The filename counts intended slots (`orderedClipUrls.length`), not actual `_clip_*.ts` files in tmp.

### The fix

Find the filename generator. After assembly completes but before the final MP4 is named, count the actual `_clip_*.ts` files matching the current `asmId` in the tmp directory:

```javascript
// BEFORE building the final filename:
const actualClipCount = fs.readdirSync(TMP_DIR)
  .filter(f => f.startsWith(`${asmId}_`) && f.includes('_clip_') && f.endsWith('.ts'))
  .length;

// Use actualClipCount in the filename instead of expectedClipCount
const finalFilename = `news_${dateSlug}_${avatarCount}_avatar_${actualClipCount}_clips__${Date.now()}.mp4`;
```

### Why this matters

Accurate filenames make triage faster. When reviewing `output/`, a filename with `_0_clips_` or `_1_clips_` instantly signals a broken run without opening the file. With the current wrong count, every run claims the intended N regardless of actual content.

After Fix 25c ships, this metadata should always match expectation (the gate blocks runs where they don't match). But the filename fix is still useful as a defensive check and for legacy runs.

### Commit message

```
fix(news): filename metadata counts real _clip_*.ts files in tmp, not intended slots (Fix 28)

Test #8 produced 'news_..._22_avatar_5_clips__....mp4' but only 1 actual
clip file existed in the assembly (story5_clip_5_.ts). The filename was
lying — the 5 came from orderedClipUrls.length (intended slots), not
from counting real _clip_*.ts files after assembly.

Fix: count real files matching {asmId}_*_clip_*.ts in the tmp directory
before naming the output. Legacy runs with null clip slots no longer
produce misleading filenames.

After Fix 25c ships, expected and actual counts should always match (the
pre-Gate-0 gate blocks mismatches). This fix is defensive for edge cases
and legacy runs.

References: News smoke test #8 post-mortem (filename '5_clips' was
actually 1 clip)
```

---

## Fix 27 — Delete unreliable audit script + document Gemini hallucination rule

### Part A: Delete the script

**File:** `scripts/audit_news_clips.js`

Delete the file entirely. It was built this afternoon to run Gemini against an assembled MP4 and verify clip presence. Frame-by-frame extraction proved Gemini hallucinates 4 of 5 clips when prompted with "there should be 5 clips." The script is not just useless — it's **actively misleading** because it returns confidently-formatted reports with plausible timestamps that are fabricated.

```bash
git rm scripts/audit_news_clips.js
```

### Part B: Document the Gemini hallucination finding in `GATED_PIPELINE_ARCHITECTURE.md`

Add a new section under the QA gate principles:

```markdown
## Gemini video analysis — known reliability limits

Gemini 2.5 Flash's video analysis has a well-documented failure mode:
when the prompt strongly implies "there should be N things in the video
at Y times with Z structure," Gemini will confidently report those N
things exist and fabricate plausible timestamps + descriptions, even
when they do not exist.

### Evidence (News smoke test #8, 2026-04-13)

Prompt: "This episode covers 5 news stories. Each story follows this
structure: STORY_INTRO → STORY_SETUP → SOURCE CLIP → STORY_SUMMARY →
STORY_REACTION. There should be 5 source clips total, one per story."

Video: 22 avatar segments + 1 real source clip (Lafarge story only).

Gemini's response: confidently reported 5 clips at 00:48, 01:39, 02:26,
03:06, 03:45 with unique content descriptions matching each story's
narration topic.

Ground truth (via ffmpeg frame extraction): only 03:45 had a real clip.
The other 4 timestamps show Bobby G. The 4 "clip descriptions" Gemini
provided were inferred from the Bobby G narration audio content, not
from actual video frames.

### Temperature 0.1 does NOT prevent this

Temperature affects creativity variance in text generation, not factual
grounding in multimodal perception. A temperature-0.1 hallucination is
just a more-reliably-repeatable hallucination.

### The rule

**Any Gemini claim about visual PRESENCE, COUNT, or TIMING must be
cross-checked with deterministic file-level evidence (ffprobe, frame
extraction, tmp file listing).**

Gemini is reliable for:
- Content-level judgments ("is the script tone flat?")
- Audio quality (speech clarity, lip sync)
- Subjective scoring within a rubric ("how professional does it look?")

Gemini is UNRELIABLE for:
- Counting things visible in video
- Verifying presence ("is X in the frame at timestamp Y")
- Temporal claims ("when did X happen in the video")

### Applied to the gates

- **Gate 2 (segment QA):** Gemini's lip-sync and audio-quality judgments
  are trustworthy. Its "segment count" claims must be cross-checked
  against the actual tsFiles array.
- **Gate 3 (assembly QA):** Gemini's freeze detection is semi-reliable
  (bitrate analysis via ffprobe is more reliable). Its "clip presence"
  and "TV card visible" claims must be cross-checked against tmp file
  listings and PNG generator logs.
- **Future gates:** any claim of the form "X is present at timestamp Y"
  must be paired with a programmatic verification step before trusting
  the claim.
```

### Commit message

```
chore(qa): delete scripts/audit_news_clips.js, document Gemini hallucination rule in GATED_PIPELINE_ARCHITECTURE.md (Fix 27)

Deletes the post-hoc audit script that used Gemini to verify clip
presence in assembled MP4s. Frame-by-frame extraction during News smoke
test #8 review proved Gemini hallucinates clip presence when prompted
with "there should be N clips" — fabricating plausible timestamps and
content descriptions by inferring from narration audio instead of
actually checking video frames.

Temperature 0.1 did not prevent the hallucination. Deterministic
extraction via ffmpeg at the claimed timestamps showed Bobby G in 4
of 5 reported clip timestamps.

Also adds a "Gemini video analysis — known reliability limits" section
to GATED_PIPELINE_ARCHITECTURE.md documenting the failure mode and
establishing a rule: any Gemini claim about visual presence, count, or
timing must be cross-checked with deterministic file-level evidence.

Applies to Gate 2 (segment count) and Gate 3 (clip presence, TV card
visibility). Gemini is still trusted for subjective judgments
(lip sync, audio quality, tone assessment).

References: News smoke test #8 post-mortem 2026-04-13, Rob rule
"QA tools match work prior to end of gate, you cant get by the gate
until you pass"
```

---

## Ship order summary

1. **Fix 25a** — new endpoint `GET /news/us-canada-videos` (server.js)
2. **Fix 25b** — dashboard switches to new endpoint (cwn_production.html, 5 references)
3. **Fix 25c** — pre-Gate-0 hard gate (server.js News block)
4. **Fix 28** — filename metadata accurate clip count (server.js filename generator)
5. **Fix 27a** — delete `scripts/audit_news_clips.js`
6. **Fix 27b** — document Gemini hallucination rule in `GATED_PIPELINE_ARCHITECTURE.md`

Bundle 25a + 25b + 25c as one commit if the test flow is clean (they're tightly coupled). Fix 28 can be a separate commit or bundled. Fix 27a + 27b should bundle together.

**Minimum: 2 commits. Maximum: 6 commits.** Cline's call based on how the fixes naturally group.

---

## Test plan after all fixes ship

Do NOT fire a full News smoke test until ALL fixes land. Then:

1. **Endpoint test:** `curl http://localhost:3000/news/us-canada-videos` returns JSON with 5+ `/video/newsfeed/` URLs
2. **Dashboard test:** hit "FETCH TODAY'S STORIES" button, verify stories appear from us-canada section, select 5, generate
3. **Gate 0 test:** (this should pass automatically since all 5 selected stories are `/video/newsfeed/` which have 100% scrape rate). Verify no hard-abort.
4. **Full smoke test #9:** Gate 1 → HeyGen → Gate 2 → assembly → Gate 3 → publish
5. **Visual verify in YouTube Studio / VLC:** all 5 stories have visible source clips at the correct timestamps
6. **Frame extraction cross-check:** use ffmpeg to extract a frame from each expected clip slot, confirm clip content (not Bobby G)

**Rob's rule:** you cannot get by the gate until you pass. If smoke test #9 still has any clip gaps, the gate failed. Do not publish. Do not mark News as locked. Ship another handoff.

---

## Fix 30 — RSS.app custom feed migration (FOLLOW-UP, not this handoff)

**Deferred from Fix 25a.** Ship this as a separate handoff AFTER News smoke test #9 passes and Rob confirms the HTML scrape path is stable.

### What to build

Replace the HTML scrape in `GET /news/us-canada-videos` with an RSS parser that reads from a Rob-configured RSS.app custom feed. Same JSON output shape, different data source.

### Prerequisites (Rob's action, not Cline's)

1. Rob signs up for RSS.app (free tier or paid, Rob's call)
2. Rob creates a custom RSS feed pointed at `https://www.aljazeera.com/us-canada/`
3. Rob configures the feed to filter for `/video/newsfeed/` URLs only (if RSS.app supports URL pattern filtering) or accepts the full section feed
4. Rob sets refresh interval to 15 minutes
5. Rob copies the generated RSS feed URL into `.env` as `NEWS_RSS_URL`
6. Rob restarts nodemon

### What Cline does

After Rob completes prerequisites, ship a small commit:

1. Add RSS parsing branch inside `GET /news/us-canada-videos`:
   - If `process.env.NEWS_RSS_URL` is set, fetch that URL, parse XML, extract `<item>` elements, filter to `<link>` matching `/video/newsfeed/` pattern, return in the same JSON shape as the HTML scrape path
   - If unset, fall back to HTML scrape (existing Fix 25a path)
2. Add `NEWS_RSS_URL` to `.env.example` with a comment explaining the RSS.app setup
3. Test with and without the env var to confirm both paths work

### Why this is a follow-up, not in this handoff

- RSS.app account setup is a Rob-manual step that can't be automated
- HTML scrape works TODAY with zero external dependencies
- News smoke test #9 should validate the core pipeline before adding a new dependency
- If HTML scrape proves flaky in production, Fix 30 becomes high priority; if stable, Fix 30 is nice-to-have

### Commit message (for the future commit)

```
feat(news): add RSS.app custom feed branch to /news/us-canada-videos (Fix 30)

Adds optional RSS parsing path when process.env.NEWS_RSS_URL is set.
Falls back to HTML scrape (Fix 25a) when unset. Same JSON output
shape — dashboard code unchanged.

Setup: Rob configures RSS.app custom feed for Al Jazeera us-canada
with 15-minute refresh, copies generated URL into .env as NEWS_RSS_URL.
Restart nodemon, endpoint automatically uses RSS instead of HTML scrape.

Benefits: stable XML contract, 15-min refresh cadence, external scraping
offloads CPU. Tradeoff: third-party dependency (RSS.app availability).

References: News smoke test #9 follow-up, Rob surfaced RSS.app pattern
2026-04-13 PM
```

---

## What's NOT in this handoff (stays parked)

- **Gap 2** — Bobby G double-pronunciation diagnosis (still waiting on timestamped examples)
- **Gap 12** — LATE sample window math for short videos (separate Gate 3 refinement)
- **Gap 13** — Kill stuck jobs after 2h dependency outage (infrastructure resilience, ships after News lock)
- **Gap 14** — Al Jazeera bottom-right watermark logo during clip playback (visual cleanup, post-lock)
- **Gap 18** — Manual ASSEMBLE recovery path doesn't chain publish (operator tool refinement)
- **Gap 21** — Ticker visibility during clips (spec question, needs Rob decision)
- **Gap 24** — Reference-episode process gap (roadmap-level, not handoff-level)
- **Gap 26** — Gate 3 frame-extraction clip presence (supersceded by Fix 25c which catches it upstream)
- **Gap 29** — Process rule documentation (merged into Fix 27b)
- **NBA voiceover V2** — still parked behind News lock
- **Twitch** — no active gaps
- **Short-form anything** — parked behind long-form lock

---

## Commit hygiene

- Re-read `COMMIT_CHECKLIST.md` before each commit
- Atomic staging
- Update `STATUS.md` → 🤖 Last Agent Action table on every commit
- Update `LONGFORM_FIX_ROTATION.md` → move Fix 25/27/28 to ✅ Shipped with commit hashes
- `node -c server.js` exit 0 before each commit
- Push to `origin/main` after each commit
- Ping Rob when all 5 fixes are shipped so he can fire News smoke test #9

---

## Expected outcome

After this handoff ships and Rob fires News smoke test #9:

- Dashboard shows 5+ video-backed US/Canada stories from Al Jazeera
- Rob selects 5, hits generate
- Gate 25c passes (5 of 5 have video, no abort)
- Gemini script gen + Claude Gate 1 pass
- HeyGen renders 22 avatar segments (assuming no outage)
- Gate 2 passes (Fix 8 already shipped)
- Assembly builds 22 avatar + 5 real source clips
- Gate 3 runs on the assembled MP4 (which genuinely has 5 clips now)
- Gate 3 passes (real clips present, no false-positive `clipsExpectedButMissing`)
- Auto-publish to Drive + Upload-Post
- YouTube Studio draft has 5 clips visible in the correct slots

**If this outcome happens, News is genuinely locked.** News locks unblocks NBA voiceover V2 dispatch, which unblocks NBA smoke tests, which unblocks the shared-set migration.

If it doesn't happen, we ship another handoff and iterate.
