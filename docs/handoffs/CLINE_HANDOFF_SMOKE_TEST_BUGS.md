# CLINE_HANDOFF_SMOKE_TEST_BUGS.md
→ Agent: Cline-A

**Author:** Claude Code, 2026-04-14  
**Size:** M (touches server.js Tier 1 + tools/clipzworld_newscast.html Tier 2)  
**Blocks:** News smoke test passing. Execute in order — Fix 1 first, then Fix 2, then Fix 3.

---

## Context

Smoke test today confirmed chrome IS rendering (TV card, flag, sidebar visible). Three bugs remain:

1. **0 source clips** — most critical, every episode is avatar-only with no news footage
2. **TV card persists** — TV card shows on non-INTRO scenes (SETUP/SUMMARY/REACTION) throughout episode
3. **Double pronunciation** — Bobby G double-pronounces words (lower priority — prompt issue, not code)

Read `AGENT_FILE_REGISTRY.md` and declare lock in `STATUS.md` before editing `server.js`.

---

## Fix 1 — 0 source clips (CRITICAL)

**Root cause:** Brightcove HLS manifest URLs (from `scrapeArticleVideo()`) contain a `fastly_token` that expires. By the time assembly runs after HeyGen renders (30-60 min), the token is stale. `downloadFile()` with FFmpeg fails silently on the expired HLS manifest — either times out or downloads corrupt data — so all 5 source_clip segments are skipped.

**Evidence:** `data/jobs.json` → `orderedClipUrls[].url` = `https://manifest.prod.boltdns.net/manifest/v1/hls/v3/...?fastly_token=Njlk...`. This token expires.

**Fix:** In the assembly download loop at `server.js:3705`, add a News-specific path that re-scrapes the article URL to get a fresh HLS URL at assembly time. The article URL is stored alongside the HLS URL in `orderedClipUrls[].pageUrl`.

Find the block at `server.js:3705`:

```js
if (segType === 'source_clip') {
  // ── Use locally cached file if available (Maya, Emily high-expiry clips) ──
```

Add a **News HLS re-scrape** block AFTER the local cache check, BEFORE the Twitch GQL block. Insert after the closing `}` of the `if (seg.localCache && ...)` block and BEFORE `let clipSlug = seg.pageUrl ? extractTwitchSlug(seg.pageUrl) : '';`:

```js
          // ── News clips: re-scrape Brightcove HLS URL at assembly time ──
          // Brightcove fastly_token expires in ~1 hour (same as Twitch CDN tokens).
          // HeyGen render takes 30-60 min — always re-scrape rather than use stored URL.
          // seg.pageUrl for News source_clips = the Al Jazeera article URL.
          if (contentType === 'news' && seg.pageUrl && seg.pageUrl.includes('aljazeera')) {
            try {
              const freshHls = await scrapeArticleVideo(seg.pageUrl);
              if (freshHls) {
                url = freshHls;
                log(asmId, `🔄 Fresh Brightcove HLS for ${label} (re-scraped from article)`);
              } else {
                log(asmId, `⚠️  Re-scrape returned null for ${label} — trying stored URL`);
              }
            } catch(e) {
              log(asmId, `⚠️  Re-scrape failed for ${label}: ${e.message} — trying stored URL`);
            }
          }
```

**Where to put it** — it goes inside the `if (segType === 'source_clip') {` block, right after the `seg.localCache` early-return block ends. The final structure should be:

```
if (segType === 'source_clip') {
  // ── local cache check ──
  if (seg.localCache && ...) { ... continue; }

  // ── NEWS: re-scrape fresh HLS URL (NEW BLOCK GOES HERE) ──
  if (contentType === 'news' && seg.pageUrl && ...) { ... }

  // ── TWITCH: GQL token refresh ──
  let clipSlug = seg.pageUrl ? extractTwitchSlug(seg.pageUrl) : '';
  ...
}
```

**Also verify**: `contentType` is in scope at that point in the assembly loop. Search for `const { ..., contentType, ...} = req.body` — if `contentType` isn't destructured, read it from the job variable. Check line ~3466 for the destructure.

**Verify the assembly payload sends `pageUrl` for News source_clips:**

In `cwn_production.html`, in `assembleJob()`, the `segmentData` map at line ~1414:
```js
pageUrl: s.type === 'source_clip' ? (s.pageUrl || '') : '',
```

This sends `pageUrl`. But where does `s.pageUrl` come from for News clips?

In `parseSegments_v2` at line ~3532:
```js
pageUrl = orderedUrls[clipInsertIdx].pageUrl || '';
```

And in `server.js:7313`, `orderedClipUrls` for News:
```js
orderedClipUrls = items.map((item, i) => {
  const videoUrl = item.videoUrl || item.clipUrl || null;
  return {
    url:        videoUrl,
    clipUrl:    videoUrl,
    pageUrl:    item.link || item.url || '',  // ← article URL
```

**Verify `item.link` is the Al Jazeera article URL** (not an HLS URL). If `pageUrl` is empty on News clips, `seg.pageUrl` in assembly is `''` and the re-scrape block never fires. In that case, add a fallback: use `seg.url` (the stored HLS URL) and try to extract the article URL from it — but this would be complex. First check if `pageUrl` is populated by adding a log statement.

**Test after fix:**
1. Run a News script generation (uses saved directive sidecar from today's run if available)
2. Watch assembly logs for `🔄 Fresh Brightcove HLS for STORY1_CLIP`
3. Confirm concat_list includes clip files

**Commit message:**
```
fix(news): re-scrape Brightcove HLS URL at assembly time to avoid fastly_token expiry

News source clips use Brightcove CDN HLS manifests with fastly_token= expiry params.
Assembly runs after HeyGen (30-60 min) — stored HLS URLs are expired by then.
Fix: add News-specific path in assembly download loop that calls scrapeArticleVideo()
with the article URL at assembly time to get a fresh HLS token, same pattern as
Twitch GQL token refresh.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

---

## Fix 2 — TV card persists on non-INTRO scenes

**Root cause investigation:** The directive path correctly sets `tvCard.visible=false` on non-INTRO scenes (verified in `data/directives/script_news_1776199680667.json`). The `directiveToOverlayParams()` correctly returns `tvCard: null` when `visible=false`. `generateNewscastOverlay()` correctly hides the TV card element when `opts.tvCard` is null.

**Likely cause:** The `500ms setTimeout` at `server.js:11478` (after `page.evaluate`) is a race condition — Puppeteer takes the screenshot before animations settle, and the TV card's CSS transition may still be mid-animation. Fix 5 from `CLINE_HANDOFF_SEQUENCE_APR14.md` was supposed to replace this with `document.fonts.ready` but the commit message claims it was shipped while the code still shows `setTimeout(resolve, 500)`.

**Verify:** Run `grep -n "fonts.ready\|setTimeout.*100\)" server.js` — if no results, the fix was NOT applied.

**Fix:** In `server.js` inside `generateNewscastOverlay()`, find:
```js
    // Wait for animations to settle
    await new Promise(resolve => setTimeout(resolve, 500));
```

Replace with:
```js
    // Wait for fonts to load + animations to settle
    await page.evaluate(() => document.fonts.ready);
    await new Promise(resolve => setTimeout(resolve, 100));
```

**Also verify:** Does `burnSceneChromeFromDirective()` at `server.js:11301` get called for ALL avatar scenes (INTRO, SETUP, SUMMARY, REACTION) or only INTRO? Check the caller at line ~4187:
```js
} else if (contentType === 'news' && (segTypes[i] || 'avatar') === 'avatar') {
```

This fires for ALL News avatar segments. Good — each scene gets its own directive-driven chrome overlay with correct `tvCard.visible`.

**If TV card still persists after fonts.ready fix:** The issue may be that Puppeteer is reusing browser context. Check that `generateNewscastOverlay` launches a NEW browser for each call (should already be the case — `puppeteer.launch()` is inside the function, not cached).

**Commit message:**
```
fix(news): replace 500ms setTimeout with document.fonts.ready before Puppeteer screenshot

Fix 5 from CLINE_HANDOFF_NEWS_CHROME_FIX.md was claimed in commit 9b6a403 but grep
shows setTimeout(resolve, 500) is still at server.js:11478. Actually applying it now.
Deterministic font-load wait eliminates race condition where TV card CSS transitions
were mid-animation during screenshot, causing visual state leakage between scenes.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

---

## Fix 3 — Double pronunciation (lower priority)

**Root cause:** Gemini occasionally opens `STORY#_SETUP` with a restatement of the INTRO headline — Bobby G ends up saying the same thing twice in consecutive segments. This is a prompt quality issue, documented in commit `b060942` as "prompt tightening deferred post-smoke-test-#8."

**Fix:** Add a Gate 1 deduction for INTRO→SETUP word overlap. In `claudeScriptQA()` (`server.js`), after the existing News directive-mode checks, add:

> **Note: Only do this fix if Fixes 1+2 pass and the double pronunciation is still visibly present in a new test run. Do not implement Fix 3 if the issue isn't reproducible. It's possible Gemini stops doing it after the storyIndex/schema fixes from commit 7638a5c.**

If the issue IS reproducible: search for the News Gate 1 QA section in `claudeScriptQA()`. Add a check in the Gate 1 prompt that explicitly says:

```
STORY#_SETUP scenes must NOT repeat or restate the INTRO scene's opening sentence.
If the first sentence of SETUP has >60% word overlap with the last sentence of the preceding INTRO, deduct 10 points and flag as "DOUBLE_PRONUNCIATION_RISK".
```

This is a prompt change inside the Gate 1 Claude QA call, not a code logic change.

**Commit message:**
```
fix(news): Gate 1 QA deduction for INTRO→SETUP word overlap (double pronunciation)

Bobby G double-pronounces when Gemini opens SETUP by restating the INTRO headline.
Add Gate 1 QA check: if SETUP first sentence has >60% word overlap with INTRO last
sentence, deduct 10 pts and flag DOUBLE_PRONUNCIATION_RISK for operator review.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

---

## After all 3 fixes

1. Run `node --check server.js`
2. Update `STATUS.md` → `🔒 Active File Locks` — clear your lock
3. Update `STATUS.md` → `🤖 Last Agent Action` table
4. Commit each fix separately

**Next:** Run smoke test again. If all 3 fixes pass:
- TV card visible only on STORY_INTRO ✅
- Source clips appear during episode ✅  
- No double pronunciation ✅

Then News long-form is locked and NBA can begin.
