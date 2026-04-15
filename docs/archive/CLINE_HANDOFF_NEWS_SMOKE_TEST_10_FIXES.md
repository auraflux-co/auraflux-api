# CLINE_HANDOFF_NEWS_SMOKE_TEST_10_FIXES.md

**Author:** Claude Code, drafted 2026-04-13 evening after News smoke test #9 visual review
**For:** Cline
**Scope:** Two-commit ship. Commit 1 = Track A Tier 1 emergency fix (filter swap + hard clip cap). Commit 2 = Track C Shape A pre-validation (extend `/news/us-canada-videos` endpoint with source validation). Both ship tonight. Parallel doc `CHROME_DIRECTIVE_ARCHITECTURE.md` is Track B, Claude Code writes it in parallel, no Cline work.
**Do NOT touch:** NBA, Twitch, short-form code paths. Existing Fix 1 / Fix 9 / Fix 25a / Fix 25c all stay in place and get patched, not replaced.
**Before each commit:** Re-read `COMMIT_CHECKLIST.md`. Atomic staging. STATUS.md update. `LONGFORM_FIX_ROTATION.md` update.

---

## Why this handoff exists

News smoke test #9 completed at 17:22 ET 2026-04-13 with all 4 stories having valid video URLs (Fix 25a/b/c verified working — 100% clip presence from the us-canada `/video/newsfeed/` source). **But the assembled video has two catastrophic visual problems Rob flagged on review:**

### Problem 1 — Clips are cropped so aggressively the subjects are unrecognizable

Frame extraction at 00:01:00 of the test #9 MP4 shows **Trump from chin-to-tie only. No eyes, no forehead, no top of head.** Frame at 00:03:30 shows a commentator's face cropped at mouth-level.

**Root cause:** `server.js:4377` uses `scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=fps=30` — zoom-to-fill crop. On non-16:9 Al Jazeera sources (their `/video/newsfeed/` videos are NOT all 16:9 as originally assumed), the filter scales the source UP until it covers 1920×1080, then crops overflow. Result: Trump's head gets chopped off the top and bottom of the frame.

**The filter was originally designed for Twitch clips** where the source has baked-in letterbox bars that need cropping away. Applied to Al Jazeera's already-clean broadcast video, it destroys framing.

### Problem 2 — Clips are 50 to 123 seconds long, not 15-25 seconds

ffprobe on the 4 clip files from test #9:

```
story1_clip.ts: 50.5 seconds  (22 MB)
story2_clip.ts: 108.4 seconds (53 MB)
story3_clip.ts: 75.6 seconds  (31 MB)
story4_clip.ts: 123.5 seconds (55 MB)
Total clip runtime: 358 seconds = 5:58 of raw clip content
```

**Root cause:** Al Jazeera's `/video/newsfeed/` URLs publish **full standalone news packages** (1-2 minute news reports), not highlight snippets. Fix 9's silencedetect trim was designed to strip the Al Jazeera red outro branding card (~5 seconds at the tail) but does NOT cap total duration. The clips play in full.

**Consequence:** Bobby G introduces a story (~8 sec), then a full 108-second Al Jazeera news package plays with its own anchor + narration + conclusion, then Bobby G comes back for 5-second summary. **The Al Jazeera piece becomes the episode. Bobby G becomes a 13-second host wrapper around a 108-second third-party news segment.** That's not what a CWN News show is supposed to be.

### Problem 3 — Rob flagged this strategically (meta-ask, not a fix)

Rob's words 2026-04-13 PM: *"we have to nail the set design based on input into the right scenes early in process... why aren't the videos showing up at the right time the right size."*

Meta-observation: the current chrome state machine is **reactive** — it tries to guess "what should be on screen right now" from scene label string matching at FFmpeg concat time. Rob wants to flip the architecture to **proactive** — Gemini writes chrome directives into the script at generation time, assembly reads them directly, no state machine needed.

**That's Track B — a design doc, not a Cline fix for this handoff.** Captured separately in `CHROME_DIRECTIVE_ARCHITECTURE.md` (Claude Code writing in parallel). Do NOT implement proactive chrome directives in this handoff. Stay reactive for now. Rob's direction: ship the Tier 1 fix first, park the architecture rework for later.

### Problem 4 — Catch problems upstream, not downstream

Rob's words: *"we may even want to think about grabbing the rss feeds early on to that way if its broken then we know earlier than later when it hits youtube editor."*

Meta-observation: catching "clip dimensions are wrong" AFTER the pipeline has burned HeyGen tokens + built an assembled MP4 is ~$0.86 of wasted spend per failed run. Catching it BEFORE Gemini script generation fires is ~$0. The current `/news/us-canada-videos` endpoint returns article URLs but doesn't validate them. Track C extends it with a pre-validation pass.

---

## Track A (Commit 1) — Tier 1 emergency fix

**Files:** `server.js` (one line swap + one arg addition), `STATUS.md`, `LONGFORM_FIX_ROTATION.md`
**Effort:** 20-30 minutes including testing
**Ship first:** this is blocking test #10

### Change A1 — Filter swap: zoom-to-fill → letterbox-fit for News source clips

**File:** `server.js:4377`

**Current:**
```javascript
const vfFilter = isAvatarSeg
  ? 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,fps=fps=30'
  : 'scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=fps=30';
```

**Target:**
```javascript
const vfFilter = isAvatarSeg
  ? 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,fps=fps=30'
  : 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x0d1424,fps=fps=30';
```

**Changes:**
- `increase` → `decrease`: scale DOWN to fit, don't scale UP to cover
- `crop=1920:1080` → `pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x0d1424`: letterbox with CWN dark navy bars instead of cropping overflow
- Avatar path (line 4376) keeps `color=black` because Bobby G's HeyGen output is clean 16:9 — the `pad` is a defensive no-op in practice but safer to leave alone

**Why CWN dark navy `#0d1424` instead of black:**
- Rob's call 2026-04-13 — ties the letterbox into the show's brand palette
- Matches `SHARED_NEWSCAST_SET_MIGRATION.md` section 10.1 broadcast palette primary dark
- Viewer who sees bars on non-16:9 clips reads them as "intentional CWN framing" instead of "default FFmpeg gap"

**IMPORTANT scope:** only the `isAvatarSeg ? ... : ...` branch changes. **Do NOT touch** the scale filter elsewhere in server.js — there are other `scale=1920:1080` references in thumbnail and short-form code paths that serve different purposes. Grep first to confirm `4377` is the ONLY line you're changing. Verify with:

```bash
grep -n "force_original_aspect_ratio=increase" server.js
```

This should show the ONE line you're patching, plus any other references (Twitch short-form clip scaling at `server.js:3800` and `3834` — those stay untouched because the short-form split-screen pattern genuinely needs zoom-to-fill for the half-screen slots).

### Change A2 — Hard 25-second cap on News source clips

**File:** `server.js` — inside the News clip normalization async IIFE near `server.js:4379-4390` where Fix 9's `computeNewsClipTrimDuration()` is called

**Current state:**

```javascript
// Fix 9: News source clips — compute trim duration to strip AJ red outro
if (contentType === 'news' && seg.type === 'source_clip') {
  const trimDur = await computeNewsClipTrimDuration(seg.path, selectedClip);
  if (trimDur && trimDur > 0) {
    args.push('-t', trimDur.toFixed(3));
  }
}
```

**Target state:**

```javascript
// Fix 9 + Track A2: News source clips — strip AJ outro AND cap at 25s hard max
// Rob's rule 2026-04-13: Al Jazeera /video/newsfeed/ publishes full 1-2 minute
// news packages. Cap at 25 seconds so the clip supports the Bobby G narrative
// instead of dominating it. Still strip AJ outro via silencedetect if the
// computed trim is LESS than 25s.
if (contentType === 'news' && seg.type === 'source_clip') {
  const NEWS_CLIP_MAX_SECONDS = 25;
  const silenceTrimDur = await computeNewsClipTrimDuration(seg.path, selectedClip);

  // Take the MINIMUM of: silencedetect result OR 25s hard cap
  // If silencedetect returns null/0, use hard cap
  // If silencedetect returns 18s (tail silence at 18s mark), use 18s (shorter than cap)
  // If silencedetect returns 60s (long clip with silence at 60s), use 25s cap
  let finalTrim;
  if (silenceTrimDur && silenceTrimDur > 0 && silenceTrimDur < NEWS_CLIP_MAX_SECONDS) {
    finalTrim = silenceTrimDur;
    log(asmId, `  ✂️  News clip ${path.basename(selectedClip)}: trimming to ${finalTrim.toFixed(1)}s (silencedetect, below ${NEWS_CLIP_MAX_SECONDS}s cap)`);
  } else {
    finalTrim = NEWS_CLIP_MAX_SECONDS;
    log(asmId, `  ✂️  News clip ${path.basename(selectedClip)}: capping at ${NEWS_CLIP_MAX_SECONDS}s hard (silencedetect returned ${silenceTrimDur || 'null'})`);
  }
  args.push('-t', finalTrim.toFixed(3));
}
```

**Notes:**
- `NEWS_CLIP_MAX_SECONDS = 25` hardcoded for now. Consider moving to `lib/config.js` as `CONFIG.NEWS_CLIP_MAX_SECONDS` in a follow-up commit if Rob wants to tune it per-run.
- Silencedetect still runs because it might find a shorter natural cut point (e.g., clip ends at 18s before hitting 25s cap). `Math.min(silencedetect, cap)` preserves Fix 9's value while adding the upper bound.
- First 25 seconds of the clip plays (FFmpeg `-t` starts from the beginning of the input). No seeking to middle-of-clip. Rob's call 2026-04-13: Al Jazeera front-loads the hook, first 25s is the strongest content.

### Verification

After committing Change A1 + A2, before pushing:

1. **Grep check A1:**
   ```bash
   grep -n "force_original_aspect_ratio=increase" server.js | grep -v "3800\|3834"
   ```
   Should return ZERO hits. Lines 3800 and 3834 are the short-form split-screen scale filters — those are allowed to stay.

2. **Grep check A2:**
   ```bash
   grep -n "NEWS_CLIP_MAX_SECONDS" server.js
   ```
   Should show both the definition and the usage inside the News clip normalization block.

3. **Syntax check:**
   ```bash
   node -c server.js
   ```
   Exit 0.

4. **Smoke test locally** by sending a test News request through the pipeline OR hand off to Rob to fire test #10 on the dashboard after nodemon restarts.

### Commit message — Track A

```
fix(news): letterbox-fit source clips instead of zoom-to-fill + hard 25s cap (Track A Tier 1)

Two catastrophic visual bugs in News smoke test #9 (file
news_monday_april_13_2026_18_avatar_4_cl_4clips_1776114960751.mp4):

Problem 1: clips cropped so aggressively subjects were unrecognizable.
Frame at 00:01:00 showed Trump from chin-to-tie only — no eyes, no
forehead, no top of head. Root cause: server.js:4377 used scale=1920:
1080:force_original_aspect_ratio=increase,crop=1920:1080 (zoom-to-fill)
on Al Jazeera source video that is NOT all 16:9. The filter was
originally designed for Twitch clips with baked-in letterbox bars.

Problem 2: clips were 50 to 123 seconds long instead of 15-25s highlights.
Al Jazeera /video/newsfeed/ URLs publish full 1-2 minute standalone
news packages, not highlight snippets. Bobby G became a 13-second host
wrapper around 108-second third-party news segments. Format was
inverted — Al Jazeera piece became the episode.

Fix A1 (server.js:4377): swap isAvatarSeg ternary FALSE branch from
increase+crop to decrease+pad with color=0x0d1424 (CWN dark navy).
Matches avatar path's letterbox-fit pattern. Non-16:9 sources now get
branded navy letterbox bars instead of losing faces to crop.

Fix A2 (server.js ~4379 News clip normalization): new NEWS_CLIP_MAX_
SECONDS=25 constant. Every News source_clip passes through both
computeNewsClipTrimDuration (Fix 9 silencedetect) AND a hard 25s cap
via Math.min-equivalent logic. First 25 seconds of the clip plays,
anything after is cut. Silencedetect still wins if it finds a shorter
natural cut (e.g., clip ends at 18s before hitting cap).

Non-News and non-source_clip paths untouched. Short-form split-screen
scale filters at server.js:3800+3834 untouched. Fix 9 silencedetect
call still fires. Fix 25a/25b/25c upstream logic untouched.

Verification: grep force_original_aspect_ratio=increase server.js
returns only lines 3800 and 3834 (short-form, allowed). node -c
server.js exit 0.

Test: Rob fires News smoke test #10 via dashboard after nodemon
restart. Expected: 4 stories, each with clips capped at 25s or less,
no cropped faces, letterbox bars appear on non-16:9 sources in navy.

References: News smoke test #9 review 2026-04-13 PM, Rob's framing
feedback "videos are there but the size is massive", Rob's format
feedback "we have to nail the set design".
```

---

## Track C (Commit 2) — Shape A pre-validation on `/news/us-canada-videos`

**Files:** `server.js` (extend existing `/news/us-canada-videos` endpoint with per-video validation pass), `cwn_production.html` (dashboard renders validation badges per story), `STATUS.md`, `LONGFORM_FIX_ROTATION.md`
**Effort:** 1.5-2 hours
**Ship second:** independent of Track A, rides on the existing Fix 25a endpoint, zero conflict

### What Track C adds

The current `GET /news/us-canada-videos` endpoint (from Fix 25a) scrapes the us-canada HTML page, finds `/video/newsfeed/` article URLs, filters to 24h lookback, returns JSON. It does NOT validate that each article will actually work downstream.

Track C extends the endpoint to validate every candidate in parallel BEFORE returning the response. Each story gets a `validation` object attached indicating whether it's usable, and what issues exist if not.

### Validation checks (v1 — 5 checks)

For each candidate article URL, run these checks in parallel (`Promise.all`):

1. **Brightcove URL reachable** — scrape the article's Brightcove embed URL via `scrapeArticleVideo()` (existing helper at `server.js:6222`), then `HEAD` request the returned HLS manifest URL with a 3-second timeout. Status 200 = pass. Anything else = fail with reason "Brightcove CDN unreachable".

2. **yt-dlp extraction succeeds** — run `yt-dlp --skip-download --dump-json` on the article URL with a 10-second timeout. Successful JSON output = pass. Exit code != 0 or missing JSON = fail with reason "yt-dlp extraction failed" and the yt-dlp error message.

3. **Source dimensions extracted and plausible** — from the yt-dlp JSON output, read `width` and `height`. Pass if both are present and width >= 1280 and height >= 720. Warning if present but < 1280×720 (will upscale, lower quality). Fail if missing entirely.

4. **Source duration extracted and plausible** — from yt-dlp JSON, read `duration` (seconds). Pass if > 5 seconds (valid clip). Warning if > 120 seconds (will be hard-capped by Track A2 to 25s, viewer loses context). Fail if missing or <= 5 seconds.

5. **og:image reachable** — from the article HTML (already scraped by Fix 8B's `scrapeArticleOgImage()` helper at `server.js:6314` or wherever it lives), check the og:image URL with a `HEAD` request, 3-second timeout. Pass if status 200. Warning if missing og:image. Fail if og:image URL returns 404 or other error.

**None of the checks require actually downloading video content.** All are metadata-only probes. Total validation latency per story: ~5-10 seconds. With 5 stories in parallel via `Promise.all`, total endpoint latency: ~10-15 seconds.

### Response shape

**Before Track C** (current Fix 25a output):

```json
{
  "ok": true,
  "source": "https://www.aljazeera.com/us-canada/",
  "lookbackHours": 24,
  "totalFound": 5,
  "recentCount": 4,
  "videos": [
    {
      "url": "https://www.aljazeera.com/video/newsfeed/...",
      "href": "/video/newsfeed/...",
      "title": "...",
      "thumbnail": null,
      "publishedAt": "2026-04-13T00:00:00.000Z",
      "dateString": "2026/4/13"
    }
  ]
}
```

**After Track C:**

```json
{
  "ok": true,
  "source": "https://www.aljazeera.com/us-canada/",
  "lookbackHours": 24,
  "totalFound": 5,
  "recentCount": 4,
  "validationSummary": {
    "passed": 3,
    "warnings": 1,
    "failed": 0
  },
  "videos": [
    {
      "url": "...",
      "title": "...",
      "...": "...",
      "validation": {
        "status": "ok",  // "ok" | "warning" | "fail"
        "checks": {
          "brightcoveReachable": { "pass": true },
          "ytdlpExtract": { "pass": true },
          "dimensions": { "pass": true, "width": 1920, "height": 1080, "aspect": "16:9" },
          "duration": { "pass": true, "durationSec": 67 },
          "ogImage": { "pass": true }
        },
        "issues": []
      }
    },
    {
      "url": "...",
      "validation": {
        "status": "warning",
        "checks": { ... },
        "issues": [
          "source dimensions 640x480 (4:3) — will letterbox with CWN navy bars",
          "source duration 180s — will hard-cap to 25s via Track A2"
        ]
      }
    },
    {
      "url": "...",
      "validation": {
        "status": "fail",
        "checks": { ... },
        "issues": [
          "Brightcove HLS manifest returned HTTP 404"
        ]
      }
    }
  ]
}
```

### Implementation notes

**Graceful degradation:** if a validation check throws an exception (network error, timeout, yt-dlp crash), treat it as `fail` with the exception message in `issues`. Never let a validation error take down the whole endpoint. Wrap each check in try/catch.

**Timeouts matter:** total endpoint latency is already 3-5 seconds for the HTML scrape. Adding 10-15 seconds of validation is acceptable for a "click a button, wait for fresh candidates" UX, but NOT acceptable as a blocking call on every dashboard page load. Suggest: the dashboard fetches `/news/us-canada-videos` ONLY when Rob clicks "Fetch today's stories" (existing behavior), not on page load. If Rob wants caching later, we add a `?cached=true` query param.

**Parallel execution:** use `Promise.all` so all N stories validate simultaneously, not sequentially. If yt-dlp takes 8 seconds per story and you run sequentially, 5 stories = 40 seconds. Parallel = 8 seconds.

**Reuse existing helpers:** `scrapeArticleVideo()` at `server.js:6222` already does Brightcove HLS extraction. Don't rewrite it. Call it from the validation pass and inspect the result.

**Where to inject the validation:** inside the existing `/news/us-canada-videos` handler, AFTER the initial HTML scrape + date filter, BEFORE the final `res.json(...)`. Add a new `Promise.all(videos.map(v => validateVideo(v)))` step and merge the results into each video object.

### Dashboard changes (`cwn_production.html`)

The existing story card grid rendered by `thumbRenderNewsStoryGrid()` (exists per Fix 25b) needs a new visual badge per card based on `validation.status`.

**Badge styling:**
- `ok` → small green dot, no text, tooltip shows "Verified"
- `warning` → small amber dot, text "Warning", tooltip shows issues list
- `fail` → small red dot, text "Unusable", card is visually dimmed (60% opacity) and NOT selectable in the story-picker flow

**Where to render:** inside the story card template in `thumbRenderNewsStoryGrid()`. Add a small row below the title showing the badge + abbreviated first issue.

**Dimmed cards stay visible** so Rob can see "hey, today had 1 failed story" and know the pipeline is healthy even if not every story is usable. But they can't be clicked/selected.

**Summary bar at top of grid:** small text above the grid showing `"3 verified, 1 warning, 0 unusable"` using `validationSummary`. Lets Rob gauge source health at a glance.

### Verification

1. **Endpoint test via curl:**
   ```bash
   curl -s http://localhost:3000/news/us-canada-videos | python3 -m json.tool | head -100
   ```
   Expected: JSON with `validationSummary` + each video has a `validation` object with 5 checks. Total latency <20 seconds.

2. **Dashboard test:** hard-refresh browser tab, click "Fetch today's stories" in the News Compilation card. Story cards should render with green/amber/red badges per card. Dimmed failed stories should not be clickable.

3. **Synthetic failure test (optional):** manually break the Brightcove URL in `scrapeArticleVideo()` for one story (return a known-bad URL) and verify the validation catches it and renders the story as red.

### Commit message — Track C

```
feat(news): pre-validate us-canada-videos candidates upstream (Track C Shape A)

Extends GET /news/us-canada-videos (Fix 25a) with a per-candidate
validation pass that runs in parallel BEFORE returning the response.
Each story now reports whether it will work downstream, catching
problems 15+ minutes before HeyGen tokens burn.

v1 validation checks (all metadata-only, no downloads):
  1. Brightcove URL reachable (HEAD request, 3s timeout)
  2. yt-dlp extraction successful (--skip-download --dump-json, 10s)
  3. Source dimensions >= 1280x720 (warning if smaller)
  4. Source duration > 5s, warning if > 120s (will hard-cap to 25s)
  5. og:image reachable (HEAD request, 3s timeout)

Response adds per-video validation object + validationSummary aggregate.

Dashboard (cwn_production.html) renders badges per story card based on
validation.status:
  - ok     (green dot)     → selectable
  - warning (amber dot)    → selectable, issues shown in tooltip
  - fail    (red dot)      → dimmed 60%, NOT selectable

Summary bar above grid shows '3 verified, 1 warning, 0 unusable'.

Rationale (Rob 2026-04-13): catching 'clip dimensions are wrong' AFTER
the pipeline has burned HeyGen tokens + built an assembled MP4 is
~$0.86 of wasted spend per failed run. Catching it BEFORE Gemini
script generation fires is ~$0. Moving detection upstream by one stage
is a 100x cost reduction per failed run.

Parallel execution via Promise.all keeps endpoint latency ~10-15
seconds total for 5 stories (vs sequential ~40-50 seconds).

Reuses existing scrapeArticleVideo() + scrapeArticleOgImage() helpers
from Fix 9 + Fix 8B. No new dependencies.

Graceful degradation: validation errors are caught and converted to
'fail' status with error message in issues. Never takes down the
endpoint.

Follow-ups deferred to later handoffs:
- Shape B: cron-based pre-validation with cache (Phase 2)
- Shape C: full validation worker in Railway (Phase 2+)
- Gemini clip content validation (too slow for v1)
- Audio silencedetect validation (needs download)
- Duplicate-story detection (needs history store)
- Topic deny-list filtering (needs list definition)

References: News smoke test #9 review 2026-04-13 PM, Rob's feedback
"we may even want to think about grabbing the rss feeds early on
so if its broken then we know earlier than later when it hits
youtube editor".
```

---

## Ship order + atomic commits

**Commit 1 (Track A):** Tier 1 emergency fix. 2 code changes in `server.js`. Ship this first, verify nodemon restart is clean, syntax check passes.

**Commit 2 (Track C):** Pre-validation endpoint + dashboard badges. Depends on nothing from Track A conceptually but both touch `server.js` so sequential commits prevent merge conflicts.

**Do NOT bundle both fixes into one commit.** If Track C has any issue (yt-dlp subprocess crash, dashboard render bug, Brightcove HEAD timeout), you can revert Track C without losing Track A's emergency framing fix.

```bash
# After Commit 1 lands clean:
git log --oneline -3  # confirm Track A is on top
# then proceed to Commit 2

# After Commit 2 lands clean:
git log --oneline -5
git push origin main
# then ping Rob
```

---

## What this handoff does NOT cover

- **Track B — `CHROME_DIRECTIVE_ARCHITECTURE.md`** — Claude Code writes this as a parked design doc in parallel. No Cline work. No code changes. It's the "when you're ready to build proactive chrome directives" spec.
- **NBA, Twitch, short-form** — untouched
- **Gate 3 rebuild** — still the Phase 2 note from earlier
- **Dashboard auto-split for 10-story batches** — earlier test #9 handoff gap, still parked
- **Gemini content-level validation during pre-fetch** — deferred to v2 of Track C
- **Sidebar dynamic rotation** — Rob parked this, stays parked
- **Chrome state machine rework** — Track B scope, not this handoff

---

## Commit hygiene

- Re-read `COMMIT_CHECKLIST.md` before each commit
- Atomic staging
- Update `STATUS.md` → 🤖 Last Agent Action table on every commit
- Update `LONGFORM_FIX_ROTATION.md` → move fixes to ✅ Shipped with commit hashes
- `node -c server.js` exit 0 before each commit
- Push to `origin/main` after each commit lands
- nodemon auto-restarts on `server.js` changes
- Python dashboard server needs manual restart OR Rob hard-refreshes browser for `cwn_production.html` changes
- Ping Rob after Commit 2 pushes so he can fire News smoke test #10

---

## Expected outcome — News smoke test #10

After Cline ships both commits and Rob fires test #10:

**From the dashboard side (Track C verification):**
- Click "Fetch today's stories" in News Compilation card
- Grid renders with 4-5 story cards, each with green/amber/red validation badges
- Summary bar shows "N verified, M warnings, K unusable"
- Rob selects stories (can only select green or amber, reds are dimmed)
- Rob clicks Generate News Video

**From the pipeline side (Track A verification):**
- Gemini script gen + Claude Gate 1 as before
- HeyGen renders 18 segments (4-story episode = 2 + 4×4 = 18 avatar scenes)
- Gate 2 passes with real Gemini scores
- Assembly runs — each source clip is trimmed to max 25 seconds AND letterboxed instead of cropped
- Final MP4: ~5-8 minutes total runtime (matches 8-15 min target lower end)
- Gate 3 reviews — clips visible, subjects not cropped, duration balanced

**Visual verification:**
- Open final MP4 in VLC, scrub to each clip slot
- Subject faces should be fully visible (eyes, forehead, mouth, chin all in frame)
- Non-16:9 sources show CWN dark navy `#0d1424` letterbox bars
- Clip duration per story ~15-25 seconds max
- Bobby G narration balance: 80% avatar / 20% clip (not the current 20% / 80% inversion)

**If the above doesn't happen:** ship another handoff. Test #10 is a checkpoint, not a finish line.
