# CLINE_HANDOFF_NEWS_CLIP_SCRAPING.md

**Author:** Claude Code (dispatched 2026-04-12 late evening, post-full-gap-audit)
**For:** Cline (implementation + investigation)
**Scope:** News long-form — wire up real video clip scraping from Al Jazeera articles. Fixes Gap #1 + #2 + (#3 or #4) from the full gap audit. This is Wave 1's News blocker — unblocks Gaps #6, #8, #9, #12, #14, #18 automatically when shipped.
**Ship order:** Single atomic commit (may need multiple iterations if the first path fails — each iteration should be its own commit so we can track which approach worked).
**Do NOT touch:** NBA, Twitch, short-form code paths. Fix 7 newscast chrome, Fix 8B og:image TV card — both stay as-is, Fix 8B's og:image scrape runs in parallel with whatever video scraping you build here.
**Before committing:** Re-read `COMMIT_CHECKLIST.md`. Atomic staging. STATUS.md update. LONGFORM_FIX_ROTATION.md update.

---

## Critical framing — Rob's directive

> *"pick whats best for long term no shortcuts and no bandaids"*

This is the decision criterion for picking between the four candidate paths below. **Durability over speed.** Pick the path most likely to survive Brightcove/Al Jazeera/Puppeteer upgrades for months without maintenance. Do not pick the fastest path if it has a known brittleness.

If two paths have similar durability, pick the one that matches the existing Twitch/NBA scraping patterns most closely — consistency across content types is itself a durability property.

---

## Context — what's broken, what's verified

### The gap

News long-form smoke tests #1–#4 have all produced output files named `*_{N}_avatar_0_clips_*.mp4`. **Zero source video clips across every News run since Apr 7.** Root cause: Al Jazeera's `https://www.aljazeera.com/xml/rss/all.xml` feed consumed via `api.rss2json.com` proxy (see `cwn_production.html:2985 generateNews()`) has ZERO video enclosures. The existing code at `cwn_production.html:3008` correctly checks `enclosure.type.indexOf('video') === 0` but the feed simply doesn't include video enclosures — it's a text + thumbnail feed.

**Verified tonight via live curl tests:**
- `curl https://api.rss2json.com/v1/api.json?rss_url=https%3A%2F%2Fwww.aljazeera.com%2Fxml%2Frss%2Fall.xml` returned 10 items, ALL with `enclosure.type = (none)` and `enclosure.link = (none)`
- `curl https://www.aljazeera.com/xml/rss/videos.xml` returned HTTP 404 (no dedicated video feed exists at that URL)
- `curl https://www.aljazeera.com/xml/rss/livenews.xml` returned HTTP 404

**But verified the video content IS extractable via a different path:**
- Al Jazeera articles embed video via **Brightcove player** (account IDs `665003303001` and `911432371001` confirmed from tonight's tests, possibly others)
- Articles that have video expose a **JSON-LD `VideoObject` schema.org block** in the server-rendered HTML (no JavaScript execution required to find it)
- 70% of 10 recent articles tested had a `VideoObject` block; 50% had a non-empty `embedUrl` pointing at `https://players.brightcove.net/{account}/{player}_default/index.html?videoId={videoId}`
- The `/video/newsfeed/` and `/video/inside-story/` URL subsections contain dedicated on-demand video articles

### Existing scraping patterns in the codebase (reference these when writing News scraper)

**Twitch clip resolution** — `server.js:4430 resolveTwitchClipMp4()`:
- Uses Twitch GQL API to return signed CDN URLs with `?sig=...&token=...` query params
- Called from `/generate-full-script` Twitch branch at `server.js:6440`
- Returns object: `{ mp4Url, status, ... }` consumed by `geminiAnalyzeClip(mp4Url, ...)`

**NBA ESPN scrape** — `server.js:5314 /nba/scrape-game-highlight` endpoint:
- Takes `gameId` as POST body
- Calls `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${gameId}`
- Iterates `videos[]` array, picks longest duration
- Extracts `.mp4` URL from `links.source.HD.href || links.source.mezzanine.href || ...`
- Returns `{ ok, videoUrl, thumbnail, title, duration }`
- Called from dashboard `cwn_production.html:4496` via POST

**News og:image scrape (Fix 8B, `9b78580`)** — `server.js:~6214 scrapeArticleOgImage()`:
- Takes article URL
- `axios.get` with realistic `User-Agent`, 10s timeout, 5 max redirects
- `cheerio.load(response.data)` to parse HTML
- Extracts `<meta property="og:image">` content attribute (falls back to `twitter:image`)
- Returns URL string or null
- Called from `server.js:6733` in parallel with `geminiAnalyzeClip()` in the News analysis block
- **This is the pattern to follow for `scrapeArticleVideo()`** — same structure, different extraction logic inside

### Target: a new helper `scrapeArticleVideo(articleUrl)` that mirrors `scrapeArticleOgImage()`

Same signature shape:
```javascript
async function scrapeArticleVideo(articleUrl) {
  if (!articleUrl) return null;
  try {
    // ... implementation depends on which path you pick
    return videoUrl; // string — absolute .mp4 URL ready to feed to geminiAnalyzeClip()
  } catch (e) {
    console.warn(`[news-scrape-video] ⚠️  ...: ${e.message}`);
    return null;
  }
}
```

Called in parallel with `scrapeArticleOgImage()` and `geminiAnalyzeClip()` inside the News analysis block at `server.js:~6730`:

```javascript
const [ogImages, videoUrls, analysesResult] = await Promise.all([
  Promise.all(items.map(item => scrapeArticleOgImage(item.link || item.url || ''))),
  Promise.all(items.map(item => scrapeArticleVideo(item.link || item.url || ''))), // ← NEW
  Promise.all(items.map(item => geminiAnalyzeClip(item.videoUrl || '', item.thumbnailUrl || '', 'news', item)))
]);
```

Then attach to each item:
```javascript
items.forEach((item, i) => {
  item.heroImageUrl = ogImages[i] || item.thumbnailUrl || '';
  item.videoUrl = videoUrls[i] || ''; // ← NEW — populates Fix 1's orderedClipUrls filter
});
```

**Critical:** Fix 1 (commit `e17e647`) already builds `orderedClipUrls` from `item.videoUrl`. You do NOT need to modify Fix 1. Once `item.videoUrl` is populated by your scraper, the existing filter at `server.js:6582` lets the entries through to `orderedClipUrls`, which flows into the heygen-poller at `server.js:219`, which inserts source clips between avatar segments. The downstream pipeline is unchanged.

---

## The four candidate paths — evaluate and pick ONE

### Path A — yt-dlp subprocess

**Approach:** shell out to `yt-dlp` with the article URL, parse JSON output, extract `.mp4` URL.

**Pros:**
- yt-dlp is actively community-maintained and handles hundreds of video sites including Brightcove-backed ones
- Already installed at `/opt/homebrew/bin/yt-dlp` (v2026.03.17 confirmed tonight)
- When upstream sites change their player, yt-dlp usually gets patched within days
- Most "long-term durable" option in theory — offloads brittleness to the yt-dlp community
- Pattern: `execFile('yt-dlp', ['--skip-download', '--dump-json', '--no-warnings', articleUrl], ...)` then `JSON.parse(stdout)` and read `.url` field

**Cons:**
- Tonight's test against 10 live Al Jazeera articles from the RSS feed had **0% success rate**. Errors were either `No suitable extractor (BrightcoveNew) found` or `Unsupported URL`.
- The extractor failure mode was specific to the RSS-surfaced `/news/` path articles. **Untested against `/video/newsfeed/` and `/video/inside-story/` path articles** which are dedicated video pages — those may work since yt-dlp has a generic Brightcove extractor
- Subprocess spawning adds latency (~2-5 seconds per article)
- yt-dlp's Al Jazeera support may be incomplete — one of the tonight test URLs triggered `BrightcoveNew` extractor with an empty `videoId=` param, suggesting yt-dlp is pulling the player URL correctly but the article has no video attached

**Durability score: high IF it works.** The community handles the brittleness, we just call the tool.

**First action to evaluate:** test yt-dlp against 5-10 articles from the `/video/newsfeed/` subsection of today's RSS feed. If hit rate is ≥70% on `/video/` path articles, Path A is viable. If still 0%, move to Path B.

**Test command:**
```bash
# Get a /video/newsfeed/ URL from the RSS
URL=$(curl -s "https://api.rss2json.com/v1/api.json?rss_url=$(python3 -c 'import urllib.parse; print(urllib.parse.quote("https://www.aljazeera.com/xml/rss/all.xml"))')" | python3 -c "
import sys, json
d = json.loads(sys.stdin.read())
for it in d.get('items', []):
    if '/video/newsfeed/' in (it.get('link','')) or '/video/inside-story/' in (it.get('link','')):
        print(it.get('link','')); break
")
yt-dlp --skip-download --dump-json --no-warnings "$URL" 2>&1 | head -5
```

### Path B — JSON-LD VideoObject + Brightcove Playback API

**Approach:** fetch article HTML, parse JSON-LD `<script type="application/ld+json">` blocks for `@type: VideoObject`, extract the `embedUrl` (Brightcove player URL), parse it with regex to get account ID + player ID + video ID, call Brightcove Playback API with a discovered policy key, return the `.mp4` URL from the API response.

**Pros:**
- Uses only axios + cheerio (both already in `package.json`, already used by `scrapeArticleOgImage()`)
- No subprocess overhead
- JSON-LD schema is a W3C standard — Al Jazeera is unlikely to remove it
- Brightcove Playback API is a stable public API with documented semantics
- Pattern matches the existing Fix 8B og:image scraper almost exactly — swap `og:image` extraction for `VideoObject` extraction

**Cons:**
- **The on-demand policy key problem** — tonight's testing confirmed:
  - The public player `config.json` endpoint (`https://players.brightcove.net/{account}/{player}_default/config.json`) exposes a policy key `BCpkADawqM39agLpp-...` that **only works for the live stream video**
  - On-demand video IDs return HTTP 401 `INVALID_POLICY_KEY` with that public key
  - The on-demand policy key is almost certainly loaded dynamically by the Brightcove player JS at play time, from a separate config endpoint or embedded in the player runtime
- Finding the on-demand policy key requires EITHER: (a) Puppeteer network interception to capture the player's own Playback API request, (b) reverse-engineering Brightcove's player init sequence to find the policy-key-fetching endpoint, or (c) discovering an alternative API that doesn't require the on-demand key
- **Until the on-demand policy key is solved, Path B is blocked.** If you pick this path, the first ~30 minutes of work is finding the on-demand policy key.

**Durability score: high** — standards-based extraction + public API. Low maintenance if the policy key discovery flow is stable.

**First action to evaluate:** check the Brightcove `config.json` for on-demand-specific policy keys that might be hiding in non-obvious fields. Command tested tonight:
```bash
curl -s --compressed "https://players.brightcove.net/665003303001/6tKQRAx7lu_default/config.json" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
# Recursive search for anything policy-key-like
import re
def walk(obj, path=''):
    if isinstance(obj, dict):
        for k, v in obj.items():
            if isinstance(v, str) and re.match(r'BCpk[A-Za-z0-9._-]{40,}', v):
                print(f'{path}.{k} = {v[:80]}...')
            walk(v, f'{path}.{k}')
    elif isinstance(obj, list):
        for i, v in enumerate(obj): walk(v, f'{path}[{i}]')
walk(d)
"
```

Also try pulling the player's script bundle and grepping for `BCpk`:
```bash
curl -s --compressed "https://players.brightcove.net/665003303001/6tKQRAx7lu_default/index.min.js" | strings | grep -oE 'BCpk[A-Za-z0-9._-]{40,}' | sort -u
```

### Path C — Brightcove HLS direct download

**Approach:** if the Brightcove Playback API returns HLS `.m3u8` sources that work without the on-demand policy key (or if JSON-LD `contentUrl` field exposes an HLS URL directly), download the HLS manifest and stream-convert to `.mp4` via `ffmpeg -i {m3u8} -c copy output.mp4`.

**Pros:**
- Standard HLS workflow — FFmpeg handles HLS → MP4 conversion natively
- If `contentUrl` is populated with an `.m3u8` URL, no Playback API call needed at all
- Tonight confirmed that the live stream returned HLS (`https://live-hls-web-aje-gcp.thehlive.com/AJE/index.m3u8`) — if on-demand videos also return HLS sources, this path works without the on-demand policy key problem

**Cons:**
- **Untested tonight** — I didn't get far enough to verify whether on-demand videos have `.m3u8` in their VideoObject `contentUrl` field or in the Playback API response
- Tonight's VideoObject block from the Iran-crisis article had `contentUrl: ''` (empty) — suggesting at least some articles don't populate this field
- If `contentUrl` is always empty, Path C collapses into Path B (need the Playback API, need the policy key)
- HLS-to-MP4 conversion adds FFmpeg subprocess overhead (but we already run FFmpeg subprocess heavily for assembly — not a new dependency)

**Durability score: high IF `contentUrl` is populated.** Standards-based, no policy key gymnastics.

**First action to evaluate:** test 10 live articles for non-empty `contentUrl` fields in their JSON-LD VideoObject blocks:
```bash
for URL in $(curl -s "https://api.rss2json.com/v1/api.json?rss_url=$(python3 -c 'import urllib.parse; print(urllib.parse.quote("https://www.aljazeera.com/xml/rss/all.xml"))')" | python3 -c "import sys, json; [print(it.get('link','')) for it in json.loads(sys.stdin.read()).get('items',[])[:10]]"); do
  curl -s -L -A "Mozilla/5.0 Chrome/120.0 Safari/537.36" "$URL" 2>/dev/null | python3 -c "
import re, json, sys
html = sys.stdin.read()
blocks = re.findall(r'<script[^>]*type=\"application/ld\+json\"[^>]*>(.*?)</script>', html, re.DOTALL)
for b in blocks:
    try:
        d = json.loads(b)
        if isinstance(d, dict) and d.get('@type') == 'VideoObject':
            print(f\"embedUrl={d.get('embedUrl','')[:60]} contentUrl={d.get('contentUrl','')[:60]}\")
            break
    except: pass
"
done
```

If any articles return a non-empty `contentUrl`, Path C is viable for those.

### Path D — Puppeteer network interception

**Approach:** launch headless Puppeteer, `page.goto(articleUrl)`, wait for Brightcove player to initialize, use `page.on('request', ...)` to intercept the player's own outgoing request to the Brightcove Playback API, extract the policy key from the request headers, use that key for our own Playback API call.

**Pros:**
- **Guaranteed to work** — we're literally sniffing what Brightcove's own player does
- Puppeteer is already in `package.json` and used heavily by existing code (`captureTicker()`, `generateNewscastOverlay()`, `generateIntroCardPNG()` via Canvas is separate but Puppeteer is used for ticker/overlays)
- If Brightcove changes their API in a non-breaking way (adds fields, rotates keys), our interceptor still captures whatever the real player uses
- Handles any future Al Jazeera player upgrade without code changes — as long as the player works in a browser, our scraper works

**Cons:**
- **Slowest path** — Puppeteer startup + page load + player init = ~5-10 seconds per article. For 5 stories, that's ~25-50 seconds added to News ingestion
- **Brittle to Puppeteer + Chromium upgrades** — major Chromium version bumps occasionally break Puppeteer's request interception API
- **Resource heavy** — each Puppeteer instance spawns a full Chromium process. Running 5 in parallel may hit memory limits on dev machines
- **More complex code** — request interception, race condition handling for "player hasn't loaded yet", fallback when the player errors, page close cleanup

**Durability score: very high but with a footprint cost.** Most resilient to source-site changes, but pays ongoing resource cost per run.

**First action to evaluate:** nothing to test externally — this path is guaranteed to work as long as Puppeteer + Chromium can load an Al Jazeera article. The question is whether the performance cost is acceptable.

---

## Your investigation plan

**Step 1 — Evaluate Path A (yt-dlp) on `/video/` subsection articles.** This is the fastest investigation because yt-dlp is already installed. If `/video/` path articles work with yt-dlp at ≥70% hit rate, pick Path A and move to implementation. ~5-10 minutes.

**Step 2 — If Path A fails, evaluate Path C (HLS direct).** Check the 10-article `contentUrl` test. If `contentUrl` is populated on ≥70% of articles with `.m3u8` URLs, pick Path C. ~5 minutes.

**Step 3 — If Paths A and C fail, evaluate Path B (Brightcove Playback API with policy key discovery).** Try to find on-demand policy keys in the player bundle or config.json via the commands in Path B's "First action to evaluate" section. If you find a working on-demand key, pick Path B. ~15-20 minutes.

**Step 4 — If Paths A, B, and C all fail, implement Path D (Puppeteer interception).** This is the guaranteed-to-work fallback. ~60-90 minutes to implement cleanly with proper error handling.

**Durability-first selection:** even if Path A or C works "well enough," consider whether Path D is more durable. The extra 5-10 seconds per article is acceptable if it means the scraper survives Brightcove upgrades without intervention. **Rob's directive is "no shortcuts, no bandaids" — if you're choosing between a 10-second-faster path that's brittle and a slower path that's bulletproof, pick the bulletproof one.**

---

## Implementation requirements (regardless of which path you pick)

### Required

1. **New helper function `scrapeArticleVideo(articleUrl)`** next to `scrapeArticleOgImage()` at `server.js:~6214`. Same signature style. Returns absolute `.mp4` URL string, or `null` on failure.
2. **Call it in parallel with og:image scrape and Gemini analysis** inside the News analysis block at `server.js:~6730`. Use `Promise.all` pattern matching Fix 8B.
3. **Attach result to `item.videoUrl`** so Fix 1's existing `orderedClipUrls` build at `server.js:6582` picks it up. Do NOT modify Fix 1.
4. **Graceful null handling** — if `scrapeArticleVideo()` returns null for a story, that story just skips the clip (same behavior as News stories with no video today). Do NOT fail the whole run because one story had no video.
5. **Log hit rate on each run** — after the parallel scrape completes, log `[generate-full-script] Got ${videoHits}/${items.length} news video URLs` so we can measure success in production.
6. **Per-article timeout** — 15 seconds max per article scrape. If an article hangs, skip it and log a warning. Do NOT let one slow article block the whole batch.
7. **Download the video locally to `tmp/`** and use the local path as the clip URL passed into `item.videoUrl`. Reason: Al Jazeera / Brightcove URLs may have signed query params that expire, and `orderedClipUrls` references are stored on the job card for assembly which happens minutes later. Downloading locally guarantees the clip is available at assembly time regardless of URL expiration.
   - File path pattern: `tmp/news_clip_{storyIndex}_{timestamp}.mp4`
   - Use `downloadFile()` helper at `server.js:~1470` (already handles SSRF whitelist + file size validation)
   - Clean up after the run via existing temp cleanup

### Nice to have (bonus if time allows)

8. **Video duration probing** — after download, ffprobe the file to get duration, store as `item.videoDuration`. Not required for Wave 1 but will be needed by Wave 2 (NBA-style clip duration feeding into Gemini prompt) and the News-version of the same pattern later.
9. **Hero image fallback integration** — if video scraping fails for a story, `item.heroImageUrl` from Fix 8B is still the fallback for the top-right TV card. That already works. But if video DOES scrape successfully, consider whether the TV card should now show a frame from the video instead of the og:image. **Decision: keep og:image as the TV card source for Wave 1.** Frame extraction is a future improvement, not in scope here.

### Do NOT do

- Do NOT add any new NPM dependencies. axios, cheerio, Puppeteer are all already in `package.json`.
- Do NOT modify `cwn_production.html` generateNews() function. Article URLs are already in `item.link` on the server side.
- Do NOT modify Fix 1, Fix 7, Fix 8B. They're all downstream and unchanged.
- Do NOT modify the Gemini analysis prompt. `geminiAnalyzeClip(videoUrl, thumbnailUrl, 'news', item)` already handles the case where `videoUrl` is a local file path (Twitch uses local files too).
- Do NOT build a scraper that assumes a specific Brightcove account ID. Parse it from the article HTML per-request — different Al Jazeera sections may use different Brightcove accounts.

---

## Data from tonight's Al Jazeera article probe (reference, not required re-work)

I tested 10 live RSS articles tonight. Here's what I found — use this as a baseline, don't redo unless you suspect the data has changed:

| Article | Path | VideoObject | embedUrl | yt-dlp |
|---|---|---|---|---|
| oil-prices-surge | `/economy/` | ❌ | — | MISS |
| us-military-threatens | `/news/` | ✅ | empty | MISS (Brightcove extractor found but videoId empty) |
| iran-war-live | `/news/liveblog/` | ✅ | `players.brightcove.net/665003303001/AvByVmBYDu_default/index.html?videoId=6368602483112` | MISS |
| peter-magyar-election | `/video/newsfeed/` | ✅ | `players.brightcove.net/665003303001/6tKQRAx7lu_default/index.html?videoId=6392988317112` | MISS |
| israel-killed-lebanon | `/video/newsfeed/` | ✅ | `players.brightcove.net/665003303001/6tKQRAx7lu_default/...` | MISS |
| abuse-allegations-democrat | `/news/` | ❌ | — | MISS |
| nigerian-artisans-fabric | `/gallery/` | ❌ | — | MISS |
| iran-war-food-security | `/video/inside-story/` | ✅ | `players.brightcove.net/665003303001/6tKQRAx7lu_default/...` | MISS |
| world-reacts-orban | `/news/` | ✅ | empty | MISS |
| flotilla-campaigns | `/news/` | ✅ | `https://www.youtube.com/embed/xFEBbDkyrqQ` | MISS |

**Key observations:**
- 7/10 had JSON-LD VideoObject blocks (70%)
- 5/10 had non-empty embedUrl (50%)
- 4 embedUrls were Brightcove (account `665003303001`)
- 1 embedUrl was a **direct YouTube embed** (`xFEBbDkyrqQ`) — for that one article, yt-dlp against `https://www.youtube.com/watch?v=xFEBbDkyrqQ` would work perfectly since yt-dlp's YouTube extractor is rock-solid
- yt-dlp had 0% success when given the article URL directly
- **`/video/newsfeed/` and `/video/inside-story/` URL patterns always had non-empty embedUrls** — suggests articles in those URL subsections are the highest-value targets, and future ingestion could optionally filter RSS items to only `/video/` path articles for higher hit rates. NOT in scope for Wave 1 but worth noting.

**Brightcove account ID:** `665003303001` (primary — Al Jazeera English's main account, used across `/news/`, `/video/newsfeed/`, `/video/liveblog/`, `/video/inside-story/`)

**Brightcove policy key (public, works for live stream only):** `BCpkADawqM39agLpp-TuKJ3fi2ac40ghRBmnV3-bKKuO6oZSDAbOgt4HRS5TzFxLH2NA0XQdsoWQjrOYvmD2bVLQSYjxRgHufXokniy4kOamHBQs6UIbDSYv`

**Player IDs seen tonight:**
- `AvByVmBYDu_default` — "AJE: Web - Live Streaming Player" per config.json
- `6tKQRAx7lu_default` — "AJE: Web - General Pages Player" per config.json

**Sample working Brightcove Playback API call (live stream only — returns 200):**
```bash
curl -s "https://edge.api.brightcove.com/playback/v1/accounts/665003303001/videos/6368602483112" \
  -H "Accept: application/json;pk=BCpkADawqM39agLpp-TuKJ3fi2ac40ghRBmnV3-bKKuO6oZSDAbOgt4HRS5TzFxLH2NA0XQdsoWQjrOYvmD2bVLQSYjxRgHufXokniy4kOamHBQs6UIbDSYv" \
  -H "Origin: https://www.aljazeera.com" \
  -H "Referer: https://www.aljazeera.com/" \
  -H "User-Agent: Mozilla/5.0"
# Returns: {"name": "Al Jazeera TV live", "sources": [{"src": "https://live-hls-web-aje-gcp.thehlive.com/AJE/index.m3u8", "type": "application/vnd.apple.mpegurl"}]}
```

**Sample failing call (on-demand video ID — returns 401):**
```bash
curl -s "https://edge.api.brightcove.com/playback/v1/accounts/665003303001/videos/6392988317112" \
  -H "Accept: application/json;pk=BCpkADawqM39agLpp-..." \
  -H "Origin: https://www.aljazeera.com" ...
# Returns: [{"error_code": "INVALID_POLICY_KEY", "message": "Request policy key is missing or invalid."}]
```

This 401 on on-demand is the core problem for Path B. Whatever path you pick needs to solve or sidestep this.

---

## Verification before commit

### Hit rate test

Before committing, run the scraper against 10 live Al Jazeera articles and log the hit rate:

```bash
# Quick test script — replace scrapeArticleVideo with your implementation
node -e "
const { scrapeArticleVideo } = require('./server.js'); // or inline if not exported
(async () => {
  const urls = [
    'https://www.aljazeera.com/video/newsfeed/2026/4/12/peter-magyar-...',
    // ... 9 more from today's RSS ...
  ];
  const results = await Promise.all(urls.map(u => scrapeArticleVideo(u)));
  const hits = results.filter(r => r).length;
  console.log(\`Hit rate: \${hits}/\${urls.length} (\${Math.round(hits*100/urls.length)}%)\`);
  results.forEach((r, i) => console.log(\`  [\${i+1}] \${r ? '✅ ' + r.slice(0,80) : '❌ null'}\`));
})();
"
```

**Expected hit rate target: ≥70%** per Rob's "long-term durable" criterion. If your chosen path returns <70% on the test batch, either iterate the implementation or fall back to the next Path in the priority order.

### End-to-end verification

1. `node -c server.js` → exit 0
2. Restart nodemon (auto-handled if running)
3. Run a News long-form smoke test via the dashboard with 5 stories
4. Watch nodemon log for: `[news-scrape-video] ✅ <article>... → <video URL>` lines
5. Confirm log shows `Got N/5 news video URLs` with N ≥ 3 (60%+ hit rate)
6. Confirm filename is NOT `0_clips` — should contain something like `5_clips` for a 5-story run where all scrapes succeed, or `3_clips` if 2 failed
7. Open the resulting MP4 and verify source clips actually play between STORY#_SETUP and STORY#_SUMMARY segments
8. Gate 3 should pass with `SOURCE CLIPS: PASS` (first time this check has actually been meaningful for News)

---

## Commit strategy

**Atomic commit:**

```
fix(news): wire Al Jazeera video scraping via {CHOSEN_PATH} (Fix 9 — unblocks mid-story clips)

News long-form has shipped with 0 mid-story video clips since Apr 7 because the
RSS all.xml feed has no video enclosures and Fix 1 (orderedClipUrls build) had
no source to read from. Fix 9 adds scrapeArticleVideo() helper that resolves
real video URLs from Al Jazeera articles, downloads to local tmp/, and populates
item.videoUrl which flows through Fix 1 → heygen-poller → assembly unchanged.

Chosen path: {A / B / C / D} because {durability reason per Rob's directive}.

Changes:
- server.js:~6214 — add scrapeArticleVideo(articleUrl) helper next to scrapeArticleOgImage
- server.js:~6730 — parallel scrape in News analysis block via Promise.all
- server.js:~6745 — attach item.videoUrl from scrape result (item.heroImageUrl already attached via Fix 8B)
- Per-article timeout: 15s
- Per-article fallback: null on failure, story skips clip gracefully
- Downloads to tmp/news_clip_{storyIdx}_{ts}.mp4 to avoid URL expiration during assembly

Verification:
- Hit rate on 10-article live test: X/10 ({pct}%)
- News smoke test #5: filename contains N_clips (not 0_clips), Gate 3 SOURCE CLIPS PASS

References: LONGFORM_FIX_ROTATION.md News Wave 1, gap audit Gap #1 + #2 + (#3 or #4)
```

### Commit discipline

1. **Atomic staging:** `git add server.js STATUS.md LONGFORM_FIX_ROTATION.md && git commit -m "..." && git push` in one chained command
2. **STATUS.md** — new Last Agent Action row
3. **LONGFORM_FIX_ROTATION.md** — move Fix 9 from Dispatched → Shipped with commit hash + chosen path

---

## Rollback plan

If the scraper works in isolation but News smoke test #5 fails (e.g., scraped video URLs cause Gemini analysis to fail, or downloaded files don't play correctly through assembly):

```bash
git revert HEAD && git push
```

News reverts to Fix 8B state (TV card with og:image, no mid-story clips). Not ideal but recoverable.

**If the scraper finds video URLs but assembly fails to play them:** that's a clip format mismatch problem, not a scraper problem. Check the downloaded file with ffprobe — Brightcove may return codec variants that the existing assembly pipeline doesn't handle cleanly. Log a separate issue and ship a format-normalization follow-up.

---

## What this fix does NOT solve

1. **News still uses the same Gemini prompt from Fix 6** — written for a "SETUP leads into clip, SUMMARY describes what we saw" structure. If the scraped clips don't semantically match what Gemini wrote in SETUP/SUMMARY, the script may feel disconnected from the visual. Fix 6 doesn't get adjusted here.
2. **News Gate 3 LATE-sample OUTRO false positive** — unchanged from previous runs. Still ~-10 per run. Separate Wave 0 fix.
3. **NBA long-form** — completely separate pipeline. Wave 1-NBA is the prompt rewrite (see `CLINE_HANDOFF_NBA_PROMPT_REWRITE.md`).

---

## Why this matters (teaching section)

Tonight's News smoke test audit surfaced that News has never shipped with real video clips because the RSS feed doesn't include them. The archived handoff `docs/archive/CLINE_HANDOFF_TWITCH_INTRO_CARD_TO_TV_DESIGN.md` line 57 described News as "Open Graph scraped article image + headline + source" — implying News is image-only by design. But Rob's directive is that News should have video clips from Al Jazeera, same as Twitch has clips from Twitch and NBA has clips from ESPN. All three sources have real video; News just never had a working scraper to extract it.

**The four candidate paths all reach the same destination** — a real `.mp4` URL per story that Fix 1 can feed into the existing pipeline. The question is which path is most durable long-term. Rob's directive is to pick the durable one, even if it's slower or more complex to implement than a quick Brightcove API hack.

**The core architectural insight** is that Fix 1 + Fix 8B already did ALL the downstream work. The scraper is the last missing piece. Once it ships and `item.videoUrl` is populated, everything from heygen-poller onward works unchanged — Fix 1's filter lets the entries through, segmentData gets built with source_clip segments interleaved between avatars, assembly concat demuxer handles the mixed content, Gate 3 sees real clips playing and passes cleanly. **The scraper is a ~100-line additive change that unlocks ~6 cascading auto-resolves.**

---

## Checklist for Cline

- [ ] Investigation complete — chosen path and rationale documented in handoff doc
- [ ] `scrapeArticleVideo(articleUrl)` helper written at `server.js:~6214`
- [ ] Parallel invocation wired into News analysis block at `server.js:~6730`
- [ ] `item.videoUrl` populated from scrape result
- [ ] Per-article timeout 15s
- [ ] Graceful null fallback (story skips clip if scrape fails, run continues)
- [ ] Local download to `tmp/news_clip_{i}_{ts}.mp4` to survive URL expiration
- [ ] Hit rate logged on every run
- [ ] 10-article test run before commit shows ≥70% hit rate
- [ ] `node -c server.js` exit 0
- [ ] Nodemon clean restart
- [ ] STATUS.md updated
- [ ] LONGFORM_FIX_ROTATION.md updated (move Fix 9 from Dispatched → Shipped)
- [ ] Atomic commit via chained `git add && git commit && git push`
- [ ] Rob can run News smoke test #5 and see real clips playing for the first time
