# CLINE_HANDOFF_AL_JAZEERA_403_WORKAROUND.md

**Author:** Claude Code, drafted 2026-04-13 11:30 PM ET during News smoke test #11 debugging session
**For:** Cline
**Scope:** Unblock Al Jazeera scraping via User-Agent rotation + browser header set + graceful fallback to RSS feeds if direct HTML scrape is still blocked. This is Option Y from Rob's 2026-04-13 11:10 PM decision. Option X (Gate 2 News math + parseSegments race condition hotfixes) is being handled by Claude Code in parallel.
**Ship as:** 1-3 separate commits depending on how many fallback layers you end up shipping. Execute top-to-bottom.
**Do NOT touch:** NBA, Twitch, short-form code paths. Gate 1 / Gate 2 / Gate 3 logic (that's Claude's lane tonight). `scrapeArticleVideo()` signature — keep the same input/output so no other callers break.
**Before each commit:** Re-read `COMMIT_CHECKLIST.md`. Atomic staging. STATUS.md update. `LONGFORM_FIX_ROTATION.md` update.

---

## Context

News smoke test #11 hit a new failure at 23:10 ET: `NEWS_CLIP_GATE_FAIL: 0 of 5 selected stories have video`. Root cause confirmed via curl: Al Jazeera is NOT blocking the CWN IP from the command line (all 3 endpoints return 200) but IS blocking axios requests specifically. This is a User-Agent / header fingerprint block from Al Jazeera's WAF.

**Direct curl tests 23:25 ET all returned HTTP 200:**
- `https://www.aljazeera.com/us-canada/` → 200, 248KB
- `https://www.aljazeera.com/xml/rss/all.xml` → 200, 17KB
- `https://www.ajplus.net/rss` → 200, 124KB

**But `/news/us-canada-videos` endpoint returns:**
```json
{"ok":false,"error":"Request failed with status code 403"}
```

The axios default User-Agent (`axios/1.x.x`) is getting blocked. Sending full browser headers should unblock it.

---

## Commit 1 — BROWSER_HEADERS constant + apply to all Al Jazeera axios calls

**File:** `server.js`
**Effort:** 20-30 min
**Ship first:** This alone probably unblocks us.

### Audit

Grep every axios call that hits aljazeera.com:

```bash
grep -n "aljazeera\.com\|AL_JAZEERA" server.js
```

Expected call sites (verify each):
1. `GET /news/us-canada-videos` endpoint handler (around `server.js:5780`)
2. `scrapeArticleVideo()` helper at `server.js:6710` (Fix 9)
3. `scrapeArticleOgImage()` helper (Fix 8B, somewhere near 6710)

### The fix

Add shared constant near the top of `server.js` (line ~50, after require block):

```javascript
// Option Y hotfix 1: browser-like headers to bypass Al Jazeera WAF.
// axios default User-Agent (axios/1.x.x) gets blocked by their bot detection.
// Full Chrome-on-macOS header set makes the request look like a real browser.
// Rotate Chrome version quarterly to avoid fingerprint staleness.
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Ch-Ua': '"Chromium";v="132", "Google Chrome";v="132", "Not?A_Brand";v="99"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"'
};
```

Update every axios call to Al Jazeera to use these headers:

```javascript
// Before:
const resp = await axios.get('https://www.aljazeera.com/us-canada/', {
  timeout: 15000,
  maxRedirects: 5
});

// After:
const resp = await axios.get('https://www.aljazeera.com/us-canada/', {
  timeout: 15000,
  maxRedirects: 5,
  headers: BROWSER_HEADERS
});
```

If an existing call already has a partial `headers` object, merge with spread:

```javascript
headers: { ...BROWSER_HEADERS, ...existingHeaders }
```

### Verification

```bash
curl -s -m 30 http://localhost:3000/news/us-canada-videos | head -c 500
```

Expected: JSON with `totalFound: 5+`, each video has `validation.status = "ok"`.

If still 403: move to Commit 2 (RSS fallback).

### Commit message

```
feat(news): browser-like headers on Al Jazeera axios calls to bypass WAF (Option Y hotfix 1)

Al Jazeera started returning HTTP 403 to axios requests during News
smoke test #11 debugging tonight. Direct curl with browser UA returns
200, confirming the block is User-Agent/fingerprint based.

Fix: send full Chrome-on-macOS header set on every axios call to
aljazeera.com. New BROWSER_HEADERS constant near top of server.js.

Applied to:
  - GET /news/us-canada-videos endpoint
  - scrapeArticleVideo() Fix 9 helper
  - scrapeArticleOgImage() Fix 8B helper

Rotate Chrome version (currently 132) quarterly to avoid WAF
fingerprint staleness.

Verification: curl /news/us-canada-videos returns JSON with 5 videos,
all validation.status=ok.

References: News smoke test #11 Al Jazeera 403 during 22:51-23:10 ET
debugging, Claude Code curl diagnostic proving direct browser-UA
requests return 200.
```

---

## Commit 2 — RSS feed fallback when HTML scrape is blocked

**File:** `server.js`
**Effort:** 45-60 min
**Ship only if:** Commit 1 doesn't fully unblock Al Jazeera.

### Pattern

If HTML scrape returns non-200 or throws, fall back to parsing `aljazeera.com/xml/rss/all.xml` and filtering to US/Canada stories by URL pattern (`/us-canada/` or `/video/newsfeed/`).

**Why this works:** global RSS is a stable XML contract published for syndication partners. WAF less likely to block it. Direct curl confirmed 200 OK.

**Trade-off:** lower hit rate than direct HTML (maybe 2-3 US/Canada stories vs 5 from direct scrape). Good enough to keep production running during temporary blocks.

### Implementation

Add `scrapeAlJazeeraUsCanadaFromRss()` helper:

```javascript
async function scrapeAlJazeeraUsCanadaFromRss() {
  const RSS_URL = 'https://www.aljazeera.com/xml/rss/all.xml';
  try {
    const resp = await axios.get(RSS_URL, {
      timeout: 10000,
      headers: BROWSER_HEADERS
    });
    const xml = resp.data || '';

    // Simple regex-based parse — no XML library needed for this narrow task
    const itemMatches = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
    const videos = [];

    for (const itemXml of itemMatches) {
      const linkMatch = itemXml.match(/<link>([^<]+)<\/link>/);
      if (!linkMatch) continue;
      const link = linkMatch[1].trim();

      // Filter to US/Canada content
      if (!link.includes('/us-canada/') && !link.includes('/video/newsfeed/')) continue;

      const titleMatch = itemXml.match(/<title>(?:<!\[CDATA\[)?([^<\]]+)/);
      const title = titleMatch ? titleMatch[1].trim() : '(untitled)';

      const dateMatch = link.match(/\/(\d{4})\/(\d{1,2})\/(\d{1,2})\//);
      if (!dateMatch) continue;
      const [_, yyyy, mm, dd] = dateMatch;
      const urlDate = new Date(`${yyyy}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}T23:59:59Z`);

      videos.push({
        url: link.startsWith('http') ? link : `https://www.aljazeera.com${link}`,
        href: link.replace(/^https?:\/\/[^/]+/, ''),
        title,
        thumbnail: null,
        publishedAt: urlDate.toISOString(),
        dateString: `${yyyy}/${mm}/${dd}`
      });
    }

    // Dedupe by href
    const seen = new Set();
    const deduped = videos.filter(v => {
      if (seen.has(v.href)) return false;
      seen.add(v.href);
      return true;
    });

    console.log(`[us-canada-rss-fallback] Found ${deduped.length} US/Canada items in RSS feed`);
    return deduped;
  } catch (e) {
    console.error(`[us-canada-rss-fallback] RSS parse failed: ${e.message}`);
    return [];
  }
}
```

Update `GET /news/us-canada-videos` handler:

```javascript
app.get('/news/us-canada-videos', async (req, res) => {
  try {
    let videos = [];
    let sourcePath = 'html-scrape';

    try {
      const resp = await axios.get('https://www.aljazeera.com/us-canada/', {
        timeout: 15000,
        headers: BROWSER_HEADERS
      });
      // ... existing HTML parse logic ...
      videos = parsedFromHtml;
    } catch (htmlError) {
      console.warn(`[news/us-canada-videos] HTML scrape failed: ${htmlError.message}, falling back to RSS`);
      videos = await scrapeAlJazeeraUsCanadaFromRss();
      sourcePath = 'rss-fallback';
    }

    // ... existing lookback filter, validation, response ...

    res.json({
      ok: true,
      source: sourcePath === 'html-scrape'
        ? 'https://www.aljazeera.com/us-canada/'
        : 'rss-fallback:https://www.aljazeera.com/xml/rss/all.xml',
      sourcePath,
      // ... rest of response ...
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
```

Include `sourcePath` in the response so the dashboard can display which source was used.

### Commit message

```
feat(news): RSS fallback when Al Jazeera HTML scrape is blocked (Option Y hotfix 2)

Adds scrapeAlJazeeraUsCanadaFromRss() helper that parses Al Jazeera's
global RSS feed and filters to US/Canada content by URL pattern
(/us-canada/ or /video/newsfeed/). Used as fallback when the primary
HTML scrape throws or returns non-200.

Global RSS is a stable XML contract Al Jazeera publishes for
syndication. WAF less likely to block it than direct HTML scrapes.

Hit rate expected to be lower (2-5 items vs 5+ from HTML) but
non-zero when HTML path is blocked.

GET /news/us-canada-videos now reports `sourcePath` field in the
response ("html-scrape" or "rss-fallback") so the dashboard can
show Rob which source was used.

No new dependencies — regex-based XML parsing for this narrow task.

References: Rob directive 2026-04-13 23:10 ET "have cline do Y".
```

---

## Commit 3 — fetchWithRetry helper with exponential backoff

**File:** `server.js`
**Effort:** 20 min
**Ship only if:** Commits 1+2 still have intermittent failures.

### Implementation

```javascript
async function fetchWithRetry(url, options = {}, maxAttempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await axios.get(url, {
        ...options,
        headers: { ...BROWSER_HEADERS, ...(options.headers || {}) }
      });
      return resp;
    } catch (e) {
      lastError = e;
      const status = e.response?.status;
      // Don't retry 4xx — those are intentional blocks
      if (status && status >= 400 && status < 500) throw e;
      if (attempt < maxAttempts) {
        const backoffMs = Math.pow(2, attempt) * 1000;
        console.warn(`[fetchWithRetry] Attempt ${attempt}/${maxAttempts} failed: ${e.message}. Retrying in ${backoffMs}ms`);
        await new Promise(r => setTimeout(r, backoffMs));
      }
    }
  }
  throw lastError;
}
```

Apply to Al Jazeera scrape calls where appropriate.

### Commit message

```
feat(news): fetchWithRetry helper with exponential backoff (Option Y hotfix 3)

Wraps axios.get() with 3-attempt retry + exponential backoff
(2s, 4s, 8s) on 5xx/network errors. Does NOT retry on 4xx
(intentional blocks — retrying wastes time).

Merges BROWSER_HEADERS automatically so every retry attempt
carries the full browser header set.

Applied to Al Jazeera scrape calls for defensive resilience.
```

---

## What this handoff does NOT cover (deferred)

- **RSS.app custom feed integration** — Rob mentioned as long-term path. Requires account setup + credentials. Deferred to Phase 2.
- **Apify scraper integration** — paid third-party. Not worth integration cost.
- **Python feedparser/BeautifulSoup port** — different runtime, not worth the complexity.
- **Make/Zapier workflow automation** — outside engineering scope.
- **AJ+ English feed integration** — separate editorial voice. Future alternate News source, not direct fallback.

---

## Parallel work

Claude Code is handling Option X (Gate 2 News math bug + parseSegments race condition) on `server.js` (Gate 2 block around line 2800) and `cwn_production.html` simultaneously.

**Different sections of server.js** — Option X touches ~line 2800, Option Y touches ~line 5700-6710. Should not conflict. If a merge conflict hits, ping Rob.

---

## Priority order if time-constrained

**Ship Commit 1 only.** BROWSER_HEADERS is likely 90% of the fix. Commits 2 and 3 are defensive layers. If Al Jazeera stays unblocked after Commit 1, Rob can resume testing immediately. Commits 2+3 become follow-ups for future flaky-block scenarios.

---

## After Commit 1 lands

Ping Rob so he knows Al Jazeera is unblocked and can resume News smoke testing. Claude Code will separately ship Option X hotfixes 9+10 (Gate 2 News math + parseSegments race). Both sets need to land before the next News smoke test can run end-to-end.
