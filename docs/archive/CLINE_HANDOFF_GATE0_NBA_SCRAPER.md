# CLINE HANDOFF: Gate 0 NBA Scraper Audit & Hardening

**Agent:** Cline-A (Claude Sonnet)
**Priority:** High — blocks NBA long-form smoke test if ESPN URLs are expired or empty
**Date:** 2026-04-15
**Files to modify:** `server.js` (lines 1877–1965)

---

## Context

NBA clip sourcing happens at dashboard time, before script generation. The flow is:

```
Dashboard "FETCH GAMES" button
  → ESPN scoreboard API → game list
  → For each game: POST /nba/scrape-game-highlight
      → site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event={gameId}
      → picks highest-duration video matching "highlight|top plays|key plays|game recap"
      → returns videoUrl from links.source.HD.href → mezzanine → full → mobile
  → gameEntry.clipUrl = result.videoUrl
  → User selects games → nbaUseSelected() stores clipUrls in CURRENT_META
  → /generate-full-script receives items[] with item.clipUrl populated
  → lib/script_gen.js passes item.clipUrl to geminiAnalyzeClip() for full video analysis
```

**The problem being audited:** The endpoint was written assuming ESPN's unofficial JSON API returns usable direct MP4 URLs. Three things have never been verified in production:

1. Whether `links.source.HD.href` is a true public MP4 URL or an auth-gated / tokenized CDN link
2. Whether `videos[]` is ever absent or empty for real recent games (ESPN API is undocumented)
3. Whether there is a Gate 0 hard-fail that prevents passing null/empty clipUrls silently into script gen

Currently, if the scraper returns `ok: false` or an empty `videoUrl`, `script_gen.js` logs a Gap #24 warning but continues — Gemini falls back to thumbnail-only analysis and produces a lower-quality script. There is no hard stop.

---

## Audit Steps

### Step 1: Test the ESPN API against a real recent game

Run the following from your terminal to check the raw API response structure:

```bash
# Confirmed recent game ID — 2025 NBA Playoffs game
curl -s "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=401767285" \
  | node -e "
    const data = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    const videos = data.videos || [];
    console.log('Total videos:', videos.length);
    videos.forEach((v,i) => {
      const src = v.links?.source || {};
      console.log(\`Video \${i}: \"\${v.headline}\" duration=\${v.duration}s\`);
      console.log('  HD:', src.HD?.href?.slice(0,80));
      console.log('  mezzanine:', src.mezzanine?.href?.slice(0,80));
      console.log('  full:', src.full?.href?.slice(0,80));
      console.log('  mobile:', v.links?.mobile?.href?.slice(0,80));
    });
  "
```

**What to look for:**
- Does `videos[]` exist and have entries?
- Are HD/mezzanine/full hrefs present at all, or are they absent?
- Do the URLs end in `.mp4` or do they contain auth query params (`?sig=`, `?token=`, `?Policy=`, `?Signature=`)?
- Do the URLs point to ESPN CDN (`cdn.espn.com` or `media.espn.com`) or a third-party CDN?

### Step 2: Verify the URL is actually downloadable

If Step 1 returns a URL, test whether it downloads without auth:

```bash
# Replace URL with actual result from Step 1
curl -I "https://[URL from step 1]" --max-time 10

# Expected: HTTP/2 200 with Content-Type: video/mp4 and Content-Length > 1MB
# Failure: 403 Forbidden, 401 Unauthorized, 302 redirect to auth page, or 404
```

**If the URL requires auth or is tokenized (short TTL):** See "Fix A" below.

**If the URL returns 200 and is a real MP4:** The happy path works. Proceed to Step 3.

### Step 3: Test with a game that may have no videos

Find a game that was not nationally televised (early-season low-profile game or a game that was postponed). These are most likely to have `videos[]` empty or absent from the ESPN API.

```bash
# Try a less prominent game ID to test the empty case
curl -s "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=401234567" \
  | node -e "
    const data = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    console.log('videos count:', (data.videos||[]).length);
    if (!data.videos) console.log('videos field ABSENT from response');
  "
```

### Step 4: Check video dimensions

If a URL from Step 2 downloads successfully, probe it:

```bash
ffprobe -v quiet -print_format json -show_streams "https://[URL]" \
  | node -e "
    const data = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    const v = data.streams.find(s => s.codec_type==='video');
    console.log('Dimensions:', v?.width, 'x', v?.height);
    console.log('Duration:', v?.duration, 's');
  "
```

**Expected:** 1920×1080 or 1280×720, 16:9. If portrait (height > width), flag for pillarbox treatment identical to AJ news clips — use `buildAjPillarboxFilter()` once it is added by the AJ scraper handoff.

---

## What to Fix

### Fix A: ESPN URLs are auth-gated or tokenized (most likely scenario)

ESPN CDN URLs often require a signed token or referrer header. If `curl -I` returns 403 or 401, the current code is broken in production and every NBA job silently falls back to thumbnail-only analysis.

**Resolution path — in order of preference:**

**Option 1 (preferred): Use ESPN's Brightcove account via network interception**

ESPN video players use Brightcove. The same Puppeteer network interception pattern used in the AJ scraper can capture the actual HLS manifest URL, which does not require additional auth.

Add a `scrapeEspnGameVideoUrl(gameId)` helper:

```javascript
/**
 * Scrape ESPN game page for the Brightcove HLS URL using Puppeteer.
 * Falls back to current API links.source.HD if Brightcove not found.
 * @param {string} gameId
 * @returns {Promise<{videoUrl, duration, title, isFallback}>}
 */
async function scrapeEspnGameVideoUrl(gameId) {
  const puppeteer = require('puppeteer');
  const gamePageUrl = `https://www.espn.com/nba/game/_/gameId/${gameId}`;

  let capturedHlsUrl = null;
  let browser;

  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();

    await page.setRequestInterception(true);
    page.on('request', req => req.continue());
    page.on('response', async resp => {
      const url = resp.url();
      if (
        url.includes('edge.api.brightcove.com/playback/v1') ||
        url.includes('players.brightcove.net')
      ) {
        try {
          const body = await resp.json();
          (body.sources || []).forEach(s => {
            if (!capturedHlsUrl && (s.type === 'application/x-mpegURL' || (s.src && s.src.includes('.m3u8')))) {
              capturedHlsUrl = s.src;
            }
          });
        } catch (_) {}
      }
    });

    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
    await page.goto(gamePageUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });

    // Scroll to trigger lazy-loaded video player
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
      await new Promise(r => setTimeout(r, 600));
    }
    // Wait up to 5s for Brightcove intercept
    for (let i = 0; i < 10 && !capturedHlsUrl; i++) {
      await new Promise(r => setTimeout(r, 500));
    }

    await browser.close();
    browser = null;

    if (capturedHlsUrl) {
      console.log(`[nba-scrape] Brightcove HLS captured for ${gameId}: ${capturedHlsUrl.slice(0, 80)}...`);
      return { videoUrl: capturedHlsUrl, isFallback: false };
    }

  } catch (e) {
    console.warn(`[nba-scrape] Puppeteer fallback failed for ${gameId}: ${e.message}`);
  } finally {
    if (browser) { try { await browser.close(); } catch (_) {} }
  }

  return null; // caller falls back to API links
}
```

Then modify the `/nba/scrape-game-highlight` handler to try Puppeteer first when the API URL fails validation, or when `videoUrl` is empty.

**Option 2 (simpler): Add Referer + User-Agent headers to the axios GET**

Some ESPN CDN URLs work when the right `Referer: https://www.espn.com/` header is present. Before adding Puppeteer, test whether adding headers resolves the 403:

```javascript
// In the URL validation probe (Step 2 of the handler), add:
const testResp = await axios.head(videoUrl, {
  timeout: 8000,
  headers: {
    'Referer': 'https://www.espn.com/',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
  }
});
```

If this resolves the 403, add those same headers to the `geminiAnalyzeClip()` download call path in `lib/script_gen.js`.

**Option 3 (last resort): YouTube search for ESPN highlight clips**

ESPN posts official highlight clips to YouTube. The YouTube Data API v3 can search for `"[TEAM_A] vs [TEAM_B] highlights [DATE]"` and return a usable embed/stream URL. This is more reliable long-term but adds API key overhead. Treat as a follow-up if Options 1–2 both fail.

---

### Fix B: Gate 0 validation — hard fail when no usable clips exist

Currently `script_gen.js` line 1404–1406 logs a warning but continues with thumbnail fallback. This produces degraded output silently.

**Add a Gate 0 check** in the `/nba/scrape-game-highlight` handler and in `lib/script_gen.js`.

#### In `server.js` — after selecting the best video URL (around line 1935–1940):

```javascript
// Gate 0: Validate the selected URL is usable
if (!videoUrl) {
  console.error(`[nba-scrape] Gate 0 FAIL: No usable video URL found for game ${gameId}`);
  return res.json({
    ok: false,
    gate0: 'fail',
    error: `No valid highlight clip URL found for game ${gameId} — cannot generate script. Check ESPN API response at: ${summaryUrl}`
  });
}

// Gate 0: Validate duration meets minimum threshold
if (maxDuration < 30) {
  console.warn(`[nba-scrape] Gate 0 WARN: Best video for game ${gameId} is only ${maxDuration}s — below 30s minimum`);
  return res.json({
    ok: false,
    gate0: 'fail',
    error: `No valid highlight clips found for game ${gameId} — longest clip is only ${maxDuration}s (minimum: 30s)`
  });
}
```

#### In `lib/script_gen.js` — in the NBA branch (around line 1400–1413):

Replace the current warning-and-continue logic with a hard gate:

```javascript
} else if (type === 'nba' || type === 'nba-short') {
  // Gate 0: Hard fail if ANY game is missing a clipUrl
  const missingClipUrl = items.filter(item => !item.clipUrl);
  if (missingClipUrl.length > 0) {
    const missingGames = missingClipUrl.map(i => i.gameId || i.headline || '?').join(', ');
    const errMsg = `Gate 0 FAIL: ${missingClipUrl.length}/${items.length} NBA games have no highlight clip URL. Missing: ${missingGames}. Run SELECT GAMES → wait for scraper to complete → retry.`;
    console.error(`[generate-full-script] ${errMsg}`);
    throw new Error(errMsg);
  }
  // ...rest of analysis unchanged
```

This throw propagates to the `/generate-full-script` error handler and returns a 400/500 with the specific game IDs that failed, rather than letting a bad job reach HeyGen.

---

### Fix C: Return `gate0` field in the scraper response

The dashboard `nbaUseSelected()` flow checks `result.ok && result.videoUrl` but has no structured gate failure signal. Add `gate0: 'pass' | 'fail' | 'warn'` to all response paths so the dashboard can surface a user-visible error instead of silently showing "NO HIGHLIGHTS":

```javascript
// Pass case (around line 1945):
const result = {
  ok: true,
  gate0: 'pass',
  gameId,
  videoUrl,
  // ...existing fields
};

// Empty videos case (line 1892–1895):
return res.json({
  ok: false,
  gate0: 'fail',
  error: `No videos found for game ${gameId} — ESPN API returned empty videos[]. Game may be too recent or too old.`
});

// No duration case (line 1927–1930):
return res.json({
  ok: false,
  gate0: 'fail',
  error: `No video with duration >0 found for game ${gameId} — ESPN may not have processed highlights yet.`
});
```

---

## Testing Checklist

After making changes, verify all four scenarios:

**Scenario 1 — Happy path (game with highlights):**
```bash
curl -s -X POST http://localhost:3000/nba/scrape-game-highlight \
  -H "Content-Type: application/json" \
  -d '{"gameId":"401767285"}'
# Expected: { ok: true, gate0: "pass", videoUrl: "https://...", duration: >30 }
```

**Scenario 2 — Verify URL is actually downloadable:**
```bash
# Take videoUrl from Scenario 1 result
curl -I "[videoUrl from Scenario 1]" --max-time 10
# Expected: 200 OK with Content-Type: video/mp4
```

**Scenario 3 — Invalid game ID (gate0 fail):**
```bash
curl -s -X POST http://localhost:3000/nba/scrape-game-highlight \
  -H "Content-Type: application/json" \
  -d '{"gameId":"999999999"}'
# Expected: { ok: false, gate0: "fail", error: "No videos found..." }
```

**Scenario 4 — NBA script gen with missing clipUrl (gate0 hard fail):**
Post to `/generate-full-script` with an NBA item that has no `clipUrl`:
```bash
curl -s -X POST http://localhost:3000/generate-full-script \
  -H "Content-Type: application/json" \
  -d '{"type":"nba","items":[{"gameId":"401767285","away":"LAL","home":"BOS"}]}'
# Expected: 400/500 with "Gate 0 FAIL: 1/1 NBA games have no highlight clip URL"
```

**Scenario 5 — End-to-end with real game (confirm dimensions):**
If Scenario 2 gives a downloadable URL, probe dimensions:
```bash
ffprobe -v quiet -print_format json -show_streams "[videoUrl]" \
  | python3 -c "
import json, sys
d = json.load(sys.stdin)
v = next(s for s in d['streams'] if s['codec_type']=='video')
print(f\"{v['width']}x{v['height']}, duration={float(v.get('duration',0)):.1f}s\")
"
# Expected: 1920x1080 or 1280x720 (16:9), duration > 60s for a real game recap
```

---

## Decision Tree After Audit

```
ESPN API URL probes as downloadable public MP4?
├── YES → Add Gate 0 duration check (Fix B) + gate0 field (Fix C). Done.
└── NO (403/401/tokenized)
    ├── Does adding Referer: https://www.espn.com/ fix it?
    │   ├── YES → Add header to axios call, add Fix B + Fix C. Done.
    │   └── NO → Implement scrapeEspnGameVideoUrl() Puppeteer fallback (Fix A Option 1)
    │             → Add Fix B + Fix C. Done.
    └── Is Brightcove player not found via Puppeteer either?
        → Escalate to Claude Code — YouTube Data API v3 fallback evaluation needed.
```

---

## Files to Modify

| File | Lines | Change |
|------|-------|--------|
| `server.js` | 1877–1965 | Add Gate 0 validation, `gate0` field on all responses, Referer headers or Puppeteer fallback per audit result |
| `lib/script_gen.js` | ~1400–1413 | Replace warning-and-continue with hard throw on missing `clipUrl` |

Do NOT touch `cwn_production.html` — the dashboard already handles `result.ok === false` by not setting `gameEntry.hasHighlights`, which disables the game checkbox. No UI change needed.

---

## Known Constraints

1. **ESPN API is unofficial.** `site.api.espn.com` is not documented. The URL schema and response shape have been stable for ~2 years but could change without notice. If the whole API returns 404/403, escalate — this is a scraper replacement task, not a patch.
2. **Videos[] may lag by ~1 hour after game end.** If a user runs SELECT GAMES immediately after a game ends, `videos[]` may be empty or contain only a generic recap without "highlight" in the title. The Gate 0 fail error message should tell the user to wait.
3. **Puppeteer is already installed** (used by the AJ scraper and NBA intro card generator). No new dependencies needed.
4. **Duration field in ESPN API is not always populated.** Some videos have `duration: 0` or `duration: null`. The duration-based ranking (Step 3 of the current handler) already handles this via `video.duration || 0`. The new Gate 0 minimum-duration check must handle this correctly — treat `duration === 0` the same as `duration: null` (treat as unknown, warn but don't hard-fail if a URL is present and valid).
5. **`geminiAnalyzeClip()` supports HLS URLs.** The AJ scraper handoff (`CLINE_HANDOFF_AJ_NEWS_SCRAPER.md`) added HLS detection + FFmpeg transcode in `geminiAnalyzeClip()`. NBA Brightcove HLS URLs use the same `.m3u8` pattern and will flow through the same path automatically.

---

## Commit Strategy

Single commit per fix tier:

- If audit shows URLs work and only Gate 0 validation is missing: `fix(nba): Gate 0 hard-fail for missing/invalid highlight clip URLs`
- If Referer header is needed: `fix(nba): add Referer header to ESPN CDN URL requests + Gate 0 validation`
- If Puppeteer fallback is needed: `feat(nba): Puppeteer Brightcove fallback for ESPN highlight clips + Gate 0 validation`

Update `STATUS.md → 🤖 Last Agent Action` table in the same commit.

---

## Reference

- Endpoint location: `server.js:1880` (`POST /nba/scrape-game-highlight`)
- Dashboard caller: `cwn_production.html:4817` (inside `fetchNBAGames()` → per-game XHR loop)
- Script gen consumer: `lib/script_gen.js:1400–1413` (NBA branch of `handleGenerateFullScript`)
- Gap #24 warning (now to be replaced by hard gate): `lib/script_gen.js:1404–1406`
- Related handoff for AJ Puppeteer + HLS pattern: `docs/handoffs/CLINE_HANDOFF_AJ_NEWS_SCRAPER.md`
- Sample game ID for testing: `401767285` (recent NBA game, confirmed in ESPN URL)
