# CLINE_HANDOFF_WAVE_0_CLEANUP.md

**Author:** Claude Code (dispatched 2026-04-13 very early morning)
**For:** Cline (implementation — batch processing)
**Scope:** 16 independent Wave 0 cleanup items with zero blockers. Each item is a self-contained small fix — file location + scope + verification. Cline picks items off this list, ships each as its own atomic commit, updates STATUS.md + LONGFORM_FIX_ROTATION.md per commit. Work until stuck or done.
**Ship order:** Bottom-up per grouping is fine. Each item is independent — order doesn't matter structurally. One commit per item preferred; Cline may bundle trivially-related items (e.g., Gap #15 + #33 are the same humanization pattern applied to News and NBA, can ship as one commit).
**Do NOT touch:** The Fix 7 / Fix 8B / Fix 9 / Wave 1+2 NBA code paths that shipped in tonight's rotation. These items are all peripheral cleanup, not core pipeline changes.
**Before each commit:** Re-read `COMMIT_CHECKLIST.md`. Atomic staging. STATUS.md update. LONGFORM_FIX_ROTATION.md update.

---

## Why this handoff exists

Rob is pushing to burn through Cline's hot streak tonight and clear the entire outstanding gap list before transitioning to a cheaper agent for post-test phase + Railway migration. This doc consolidates all 16 Wave 0 items from the gap audit (News Wave 0: 4 items, NBA Wave 0: 5 items, Cross-cutting Wave 0: 7 items) into one dispatchable queue.

**Wave 0 items are defined as:** zero upstream blockers, zero downstream blockers, not required to pass News or NBA long-form test cases. They are all independently shippable. Failure or deferral of any item has zero cascade effect on other items.

**Ship discipline:** one commit per item (or per tightly-related group), atomic staging, STATUS.md row per commit, LONGFORM_FIX_ROTATION.md `✅ Shipped` entry per commit. The point is to clear the list, not to find creative ways to bundle.

---

## News Wave 0 — 4 items

### Gap #5 — Remove redundant `/news/generate-intro-card` endpoint

**File:** `server.js:5397`
**Scope:** Fix 8B (`9b78580`) added an inline `scrapeArticleOgImage()` helper at `server.js:~6214` that runs during News script generation via `Promise.all` parallel invocation. The older `/news/generate-intro-card` endpoint at `server.js:5397` was the previous implementation of the same scraping functionality. It's now dead code — nothing in the codebase calls it.

**Verification that it's dead:**
```bash
grep -n "generate-intro-card" cwn_production.html server.js
# Should show only the endpoint definition itself, no callers
```

If the grep shows any callers outside the endpoint definition, the endpoint is NOT dead — flag it and skip this item. If grep shows only the `app.post('/news/generate-intro-card'...)` definition line, proceed with deletion.

**Action:** Delete the entire `app.post('/news/generate-intro-card', async (req, res) => {...})` block. Preserve any `/nba/generate-intro-card` endpoint that lives in the same file — that one is NOT dead, NBA's assembly branch at `server.js:3987` still uses it.

**Commit message:**
```
chore(news): remove dead /news/generate-intro-card endpoint (Gap #5)

Fix 8B (9b78580) added inline scrapeArticleOgImage() to the News script
generation block, making the standalone /news/generate-intro-card endpoint
dead code. Grep verified no remaining callers in cwn_production.html or
server.js. NBA's /nba/generate-intro-card is separate and still in use.

References: LONGFORM_FIX_ROTATION.md Wave 0, gap audit Gap #5
```

---

### Gap #13 — Investigate and improve `/generate-publish-copy` News quality

**File:** `server.js:~6890` (News branch of `/generate-publish-copy` endpoint)
**Context:** Per Rob's memory `feedback_title_desc_generator`, he currently uses ChatGPT to generate News title/description/hashtags instead of this endpoint because output quality is insufficient. This item investigates what's wrong and ships an improvement.

**Action:**
1. Read the current News prompt in the endpoint at `server.js:~6890` (grep for `/generate-publish-copy` and find the `type === 'news'` branch)
2. Identify specific quality issues — likely candidates: generic title wording, missing episode number context, missing story-specific hooks in the description, hashtags not matching News content style
3. Rewrite the prompt to be more specific to News content — inject the actual story headlines from `items[]`, reference the episode number from `data/episode_counters.json`, match ClipzWorld News brand voice
4. Test by calling `/generate-publish-copy` with a real 5-story News payload, inspect the output, iterate if needed

**Verification:**
```bash
# After the rewrite, call the endpoint with test data
curl -X POST http://localhost:3000/generate-publish-copy \
  -H "Content-Type: application/json" \
  -d '{
    "contentType": "news",
    "form": "long",
    "items": [
      {"title": "UN warns of global food crisis", "source": "Al Jazeera"},
      {"title": "Viktor Orban concedes Hungary election", "source": "Al Jazeera"}
    ],
    "episodeNumber": 42
  }' | python3 -m json.tool
```

Output should have a title that references the lead story, a description that mentions all stories, and hashtags that are News-specific (not generic). If the output still feels generic, iterate the prompt once more.

**Commit message:**
```
fix(news): improve /generate-publish-copy News prompt quality (Gap #13)

Rob currently bypasses the endpoint and uses ChatGPT for title/description
generation because output was too generic. Rewrites the News branch of the
prompt to inject specific story headlines from items[], reference episode
number, and match ClipzWorld News brand voice.

Changes:
- server.js:~6890 — News branch prompt rewrite
- Tested against 5-story payload: title references lead story, description
  mentions all stories, hashtags News-specific

References: memory feedback_title_desc_generator, gap audit Gap #13
```

---

### Gap #15 — Humanize News chapter labels in `buildYouTubeChapters()`

**File:** `server.js:4876 buildYouTubeChapters(segments, segmentDurations)`
**Context:** After Fix 6, News scene labels are `INTRO`, `STORY1_INTRO`, `STORY1_SETUP`, `STORY1_SUMMARY`, `STORY1_REACTION`, etc. — 22 total for a 5-story run. These raw scene headers may be leaking into YouTube descriptions as chapter labels, producing ugly output like `0:30 STORY1_SETUP`.

**Action:**
1. Read `buildYouTubeChapters()` at `server.js:4876` and find how it constructs chapter lines from segment labels
2. Add a humanization layer: for each segment label, map it to a viewer-friendly string. Rules:
   - `INTRO` → `Welcome` or `Intro`
   - `OUTRO` → `Outro` or `Sign-off`
   - `STORY{N}_INTRO` → Use story N's headline from `segments[i].cardData.title` or `segments[i].storyTitle` if present, otherwise `Story N`
   - `STORY{N}_SETUP` → skip this scene entirely (not a chapter boundary — same story)
   - `STORY{N}_SUMMARY` → skip (same story)
   - `STORY{N}_REACTION` → skip (same story)
   - `COLD_OPEN` → `Opening`
3. Result: a News episode has ~7 chapters (Welcome + 5 Story headlines + Outro) instead of 22 raw scene labels.
4. Same function handles NBA via Gap #33 below — the NBA branch should use game matchup names (`Lakers @ Celtics`) instead of `GAME1_LAKERS_CELTICS_INTRO`.

**Verification:**
- Read the current output format: the function builds a string like `0:00 INTRO\n0:30 STORY1_INTRO\n...`
- After the change, output should be like `0:00 Welcome\n0:30 UN Food Crisis Warning\n...`
- Runtime test on next smoke test: check the YouTube description on the private draft and confirm chapters are human-readable

**Commit message:**
```
fix(publish): humanize chapter labels in YouTube descriptions (Gap #15 + #33)

buildYouTubeChapters() at server.js:4876 was producing raw scene headers
(STORY1_SETUP, GAME1_LAKERS_CELTICS_INTRO) in YouTube descriptions instead
of viewer-readable labels.

Changes:
- server.js:4876 — humanize News chapters: only STORY#_INTRO becomes a chapter,
  uses story headline from cardData, ~7 chapters per episode instead of 22 raw
- NBA chapters: only GAME#_INTRO becomes a chapter, uses "Away @ Home" matchup,
  ~7 chapters per episode instead of 17 raw
- COLD_OPEN/INTRO/OUTRO → Welcome/Intro/Outro

References: gap audit Gap #15 (News) + Gap #33 (NBA)
```

**Note:** Bundling Gap #15 (News) and Gap #33 (NBA) into one commit is efficient because both are the same humanization pattern applied to different scene name structures.

---

### Gap #17 — Upload-Post cross-platform confirmation logging

**File:** `server.js:~7830` (search for `form.append('first_comment'` to find the Upload-Post call area)
**Context:** Currently the `/publish` endpoint calls Upload-Post, receives a `request_id`, and logs `✅ Gate 6b: Published to youtube`. This confirms the POST was accepted by Upload-Post but does NOT confirm the video actually appeared as a private draft in each target platform. Silent failures on TikTok/Instagram are possible and would go unnoticed unless Rob manually checks each platform.

**Action:**
1. After the initial `/publish` Upload-Post call returns `request_id`, add a background polling step that hits `https://api.upload-post.com/api/uploadposts/status?request_id=${request_id}` at 30-second intervals up to 5 minutes
2. The Upload-Post status response should have per-platform state — parse it and log each platform's success/failure individually
3. Log format:
   ```
   ✅ Gate 6b: YouTube private draft created (video_id: xxxxx)
   ✅ Gate 6b: TikTok private draft created
   ⚠️ Gate 6b: Instagram draft rejected — {reason}
   ```
4. Polling is fire-and-forget — don't block the rest of the assembly pipeline. Use `setImmediate` or similar. Log when the polling finishes (or times out at 5 minutes).

**Fallback behavior:** If the Upload-Post status endpoint is unresponsive or returns an unexpected shape, log a warning and stop polling. Do NOT fail the run because of a polling error.

**Verification:**
After the change, next published News run should produce per-platform log lines within ~1-2 minutes of the `request_id` being returned.

**Commit message:**
```
feat(publish): poll Upload-Post status per platform and log individually (Gap #17)

Previously /publish logged only "Published to youtube" after Upload-Post
returned request_id, which confirms POST accepted but does NOT confirm
video landed on YouTube/TikTok/IG as private drafts.

Changes:
- server.js:~7830 — after Upload-Post call, fire-and-forget poll of
  api.upload-post.com/api/uploadposts/status for 5 min at 30s intervals
- Log per-platform state: YouTube, TikTok, Instagram independently
- Non-blocking — doesn't delay rest of pipeline

References: gap audit Gap #17
```

---

## NBA Wave 0 — 5 items

### Gap #19 — NBA SELECT GAMES UX hardening

**File:** `cwn_production.html:~2908 generateNBA()`
**Context:** Currently `generateNBA()` reads clip URLs from `CURRENT_META.clipUrls` which is populated by `nbaUseSelected()` at `cwn_production.html:4565`. If a user types game IDs directly into the `nba-game-ids` textarea and clicks GENERATE SCRIPT without first clicking SELECT GAMES → picking from the list → clicking USE SELECTED, then `CURRENT_META.clipUrls` is empty and the server receives games with no `clipUrl`, which cascades to Gate 1 failure (empty Gemini analysis) or degraded output.

**Action:**
1. In `generateNBA()` at line 2908, add a guard at the top:
   ```javascript
   if (!CURRENT_META || !CURRENT_META.clipUrls || Object.keys(CURRENT_META.clipUrls).length === 0) {
     alert('Please click SELECT GAMES first to scrape highlight URLs before generating the script.');
     nav('nba');
     return;
   }
   ```
2. This forces the user through the SELECT GAMES flow before the generate button can produce a script.

**Alternative** (if you prefer not to use `alert`): show the error inline in the `nba-status` element instead of a modal alert.

**Verification:** Manual test — type a game ID directly into `nba-game-ids` without going through SELECT GAMES, click GENERATE SCRIPT, confirm the error appears and the script is NOT generated.

**Commit message:**
```
fix(dashboard): NBA generate guard — require SELECT GAMES flow (Gap #19)

Typing game IDs directly into nba-game-ids textarea without clicking
SELECT GAMES first left CURRENT_META.clipUrls empty, which cascaded to
server-side Gate 1 failures (empty clipUrl → empty Gemini analysis).
Guard forces users through the scrape flow before generate.

Changes:
- cwn_production.html:~2908 generateNBA() — check CURRENT_META.clipUrls
  populated before proceeding, else alert + redirect to SELECT GAMES page

References: gap audit Gap #19
```

---

### Gap #20 — NBA ESPN video selection quality (filter out press conferences and interviews)

**File:** `server.js:5333-5347` (the `videos.forEach` loop inside `/nba/scrape-game-highlight`)
**Context:** Current logic picks the video with the highest `duration` from ESPN's summary API `videos[]` array. Problem: ESPN often includes post-game press conferences (longest, not a highlight), player interviews, and condensed-game replays alongside actual highlight videos. Longest-duration selection may pick the wrong one.

**Action:**
1. Before the duration-sorting logic, filter the `videos[]` array to prefer videos whose `headline` or `title` or `description` contains highlight-specific keywords: `highlight`, `highlights`, `top plays`, `key plays`, `best plays`, `game highlights`
2. If filtering leaves at least 1 video, pick the longest-duration from the filtered set
3. If filtering leaves zero videos (no headline matches), fall back to the original longest-duration-wins logic across all videos — better to have a press conference than no clip at all
4. Add logging so we can see what got filtered:
   ```javascript
   console.log(`[nba-scrape]   Filtered ${filteredCount}/${videos.length} videos matching "highlight" pattern`);
   ```

**Pattern match:**
```javascript
const highlightPattern = /highlight|top\s+plays|key\s+plays|best\s+plays|game\s+recap/i;
const filteredVideos = videos.filter(v => {
  const text = `${v.headline || ''} ${v.title || ''} ${v.description || ''}`;
  return highlightPattern.test(text);
});
const videoPool = filteredVideos.length > 0 ? filteredVideos : videos;
// ... continue with existing longest-duration logic against videoPool
```

**Verification:** Test by running `/nba/scrape-game-highlight` against a gameId where ESPN has both a press conference and a highlight video. Confirm the highlight is picked.

**Commit message:**
```
fix(nba): prefer highlight videos over press conferences in ESPN scrape (Gap #20)

/nba/scrape-game-highlight was picking longest-duration video from ESPN
summary API, which often returned post-game press conferences (30+ min)
instead of actual game highlights (~1-2 min).

Changes:
- server.js:5333-5347 — filter videos[] by headline/title/description matching
  /highlight|top plays|key plays|best plays|game recap/i before picking
  longest-duration; fall back to unfiltered set if zero matches

References: gap audit Gap #20
```

---

### Gap #24 — NBA defensive guard for empty `clipUrl`

**File:** `server.js:6710` (NBA analysis block inside `/generate-full-script`)
**Context:** If a game arrives at the server with empty `clipUrl` (e.g., dashboard skipped the scrape step somehow, ESPN returned `{ok: false}` for that game, or a race condition), the current code at `server.js:6710` falls back to thumbnail-only Gemini analysis silently. This produces low-quality analysis and a weaker script for that game, with no warning.

**Action:**
1. Before the `items.map(item => geminiAnalyzeClip(item.clipUrl||'', item.thumbnailUrl||'', 'nba', item))` call, scan items for missing clipUrls:
   ```javascript
   const missingClips = items.filter(g => !g.clipUrl || !g.clipUrl.startsWith('http')).map(g => `${g.away}@${g.home}`);
   if (missingClips.length > 0) {
     console.warn(`[generate-full-script] ⚠️ NBA: ${missingClips.length}/${items.length} games have no clipUrl: ${missingClips.join(', ')}`);
     console.warn(`[generate-full-script] ⚠️ These games will use thumbnail-only Gemini analysis — script quality will be degraded for them`);
   }
   ```
2. Do NOT drop the missing-clip games from the items array — let them through with degraded analysis, matching current behavior. The guard is informational only.
3. Optional: add a `_clipMissing: true` flag to the affected items so downstream code can treat them differently if needed in the future.

**Verification:** Trigger the warning by calling `/generate-full-script` with an NBA payload where one game has `clipUrl: ''`. Confirm the warning appears in the log without breaking the run.

**Commit message:**
```
feat(nba): warn when games arrive with empty clipUrl (Gap #24)

Previously games with empty clipUrl silently fell through to thumbnail-only
Gemini analysis, producing degraded scripts with no warning. Add defensive
logging so degraded-analysis cases are visible in nodemon output.

Changes:
- server.js:6710 — scan items for missing clipUrls before geminiAnalyzeClip
  parallel call, warn with affected game labels, do not drop games from
  analysis (preserve existing fallback behavior)

References: gap audit Gap #24
```

---

### Gap #33 — NBA chapter label humanization

**Combined with Gap #15 above.** See the Gap #15 entry — the same commit handles both News and NBA chapter humanization because they're the same pattern applied to different scene name structures. No separate action needed.

---

### Gap #34 — NBA `/generate-publish-copy` quality investigation

**File:** `server.js:~7160` (NBA branch of `/generate-publish-copy` endpoint)
**Context:** Same class as Gap #13 for News — NBA publish copy quality likely has similar generic-output issues. Rob probably bypasses this for NBA too.

**Action:** Same pattern as Gap #13 but applied to the NBA branch:
1. Read current NBA prompt at `server.js:~7160`
2. Identify quality issues
3. Rewrite to inject specific game data (top scorer, team names, final scores) from `items[]`, reference episode number, match "Other Side of the Pillow" NBA brand voice
4. Test with real NBA payload, iterate if needed

**Verification:** Same as Gap #13 but with NBA payload.

**Commit message:**
```
fix(nba): improve /generate-publish-copy NBA prompt quality (Gap #34)

Same class as Gap #13 for News — NBA publish copy rewrite to inject
specific game data, reference episode number, match "Other Side of the
Pillow" brand voice.

Changes:
- server.js:~7160 — NBA branch prompt rewrite

References: gap audit Gap #34
```

---

## Cross-cutting Wave 0 — 7 items

### Gap #10 + #40 — Gate 3 LATE-sample outro false positive

**File:** `server.js:~1541` (the `geminiQACheck()` function's LATE sample checklist)
**Context:** Gate 3 samples 20-second windows at EARLY/MIDDLE/LATE points of the assembled MP4. The LATE sample window typically ends mid-outro segment because the sample window is fixed-length and doesn't align to scene boundaries. Gemini interprets "the 20-second sample ends mid-sentence" as "the video ends mid-sentence" and deducts 10-20 points with `OUTRO: FAIL — unclean cut`. Confirmed on smoke tests #1 #3 #4 for News (Rob verified outro actually plays cleanly in YouTube Studio).

**Action:**
1. Find the LATE sample prompt wording in `geminiQACheck()` — search for `OUTRO` or `LATE SAMPLE` in the checklist construction
2. Update the OUTRO check to explicitly distinguish sample-window boundary from video-end boundary:
   ```
   3. OUTRO: Does the AVATAR or AUDIO end mid-sentence at the CONTENT boundary?
      IMPORTANT: This is a 20-second SAMPLE, not the full video. If the sample
      boundary falls mid-sentence but the video continues normally past this
      sample, that is NOT an outro failure. Only report FAIL if you can see
      the avatar stop talking AND the video visually ends (black frame, fade
      out, or hard cut) within this sample window.
   ```
3. Applies to all content types (News + NBA + Twitch). Cross-content fix, no branch required.

**Verification:** Next smoke test should show LATE sample scoring higher — either 100/100 clean pass or a different deduction reason not related to outro.

**Commit message:**
```
fix(gate3): clarify LATE-sample OUTRO check — sample boundary ≠ video boundary (Gap #10 + #40)

Gate 3's 20-second LATE sample window often ends mid-outro segment,
causing Gemini to interpret the SAMPLE boundary as the VIDEO boundary
and mark OUTRO as FAIL. Silent -10 to -20 deduction per run on every
content type, confirmed false positive via Rob's YouTube Studio review.

Changes:
- server.js:~1541 — LATE sample OUTRO checklist item rewritten to
  explicitly require visual video end (black frame, fade, hard cut)
  within the sample window, not just sample-boundary mid-sentence

References: gap audit Gap #10 (News) + Gap #40 (cross-content duplicate),
POST_PUBLISH_TASKS.md Gate 3 LATE-sample issues
```

---

### Gap #39 — White strips at top/bottom of assembled MP4s (DIAGNOSTIC FIRST)

**File:** `server.js` assembly pipeline (multiple locations TBD)
**Context:** POST_PUBLISH_TASKS.md §1.1 reports "thin bright/white horizontal band at the very top of the assembled MP4" visible in Twitch long-form compilations. Suspected causes: (a) HeyGen avatar segments may have baked-in letterbox bars from sub-pixel rounding when native 4K scales to 1920×1080, (b) FFmpeg concat adds padding when mixing segments with different pixel aspect ratios, (c) something else.

**DIAGNOSTIC FIRST, then fix.** Do NOT ship a fix without evidence.

**Diagnostic action:**
1. Find the most recent assembled MP4 in `output/` that's known to have the white strip issue (ask Rob which MP4 if unclear — or use any recent long-form)
2. Run `ffprobe -show_streams` on it to get actual dimensions, pixel format, and SAR
3. Download a raw HeyGen segment from a recent job via the heygen URL stored on the job card in `data/jobs.json`
4. Run `ffprobe -show_streams` on the raw HeyGen segment
5. Compare dimensions — if HeyGen segment is NOT exactly 1920×1080 or has a baked letterbox, that's the source
6. If HeyGen segment is clean 1920×1080, the strip is a concat-time artifact

**Fix based on diagnostic:**
- **If HeyGen source has baked strip:** add a crop filter to each avatar segment before concat. Example: `ffmpeg -i segment.mp4 -vf "crop=1920:1080:0:0" segment_cropped.mp4`. Integrate into the assembly loop's per-segment normalization.
- **If concat is adding padding:** explicit `setsar=1:1,format=yuv420p` in the concat filter chain.
- **If something else:** document the finding and flag for separate follow-up.

**Verification:** After fix, run a smoke test (any content type) and visually inspect the assembled MP4 for white strips. Strips should be gone.

**Commit message:** (depends on which root cause you find — write after diagnostic)

```
fix(assembly): eliminate white strip at top of assembled long-form MP4s (Gap #39)

Diagnostic: {HeyGen source had baked X / concat added padding / etc.}
Fix: {crop filter / setsar / etc.}

Changes:
- server.js:{LINE} — {specific fix}

Verification: ffprobe on post-fix MP4 shows clean 1920×1080, visual
inspection confirms no white strip at top/bottom.

References: POST_PUBLISH_TASKS.md §1.1, gap audit Gap #39
```

---

### Gap #42 — Gate 3 content-type-specific TV CARD check wording (DEPENDS ON HANDOFF 7)

**File:** `server.js:~1541` (the `geminiQACheck()` function's TV CARD checklist item)
**Context:** Current TV CARD check wording describes a "top-right gold-bordered card" which matches Twitch/NBA (both use `OVERLAY_ZONE` top-right cards) but doesn't distinguish the News TV card from the newscast chrome sidebar (both have gold borders, confused Gemini on smoke test #4).

**This item may auto-resolve if Handoff 7's Gap #11 fix lands first.** Handoff 7 tightens the wording to "photo + headline together" which naturally distinguishes the News TV card from the chrome sidebar.

**Action after Handoff 7 ships:**
1. Check if the wording is now distinguishing correctly across all 3 content types
2. If yes, mark Gap #42 as auto-resolved — no action needed
3. If no, add content-type-specific branches to the TV CARD check:
   ```javascript
   const tvCardCheck = contentType === 'news'
     ? '7. NEWS TV CARD: Is there a rectangular card in the top-right area containing BOTH a news article photo AND a headline text overlay? (yes/no)'
     : '7. TV CARD: Is there a rectangular card with a gold border visible in the top-right area of the frame containing content-specific data (streamer photo for Twitch, game thumbnail for NBA)? (yes/no)';
   ```

**Verification:** Review a Gate 3 why-doc from a post-Handoff-7 smoke test and confirm Gemini correctly identifies the TV card across all content types without confusion.

**Commit message:** (skip if auto-resolved)

```
fix(gate3): content-type-specific TV CARD check wording (Gap #42)

Handoff 7's Gap #11 fix {did not fully resolve / needs content-type branches}.
Adds News-specific vs Twitch/NBA-specific TV CARD check wording.

Changes:
- server.js:~1541 — TV CARD checklist item branches on contentType

References: gap audit Gap #42, Handoff 7 Gap #11 prior fix
```

---

### Gap #44 — Intro card duration per content type

**File:** `lib/config.js:~55` (`CONFIG.INTRO_CARD`)
**Context:** Currently one unified `DURATION_SECONDS = 10` applied to all 3 content types. Rob's directive from earlier tonight: Twitch 10s / NBA 8s / News 12s per content type.

**Action:**
1. Edit `lib/config.js` `CONFIG.INTRO_CARD`:
   ```javascript
   INTRO_CARD: {
     // ... existing keys stay ...
     DURATION_SECONDS: 10,    // DEPRECATED — kept for backwards compat, prefer per-type keys below
     DURATION_TWITCH: 10,
     DURATION_NBA: 8,
     DURATION_NEWS: 12
   }
   ```
2. Find all references to `CONFIG.INTRO_CARD.DURATION_SECONDS` in `server.js` via grep — should be 3-5 call sites
3. For each call site, determine the content type context (usually `contentType === 'twitch'/'nba'/'news'` branch)
4. Replace with the per-type key:
   ```javascript
   // BEFORE
   const introDur = CONFIG.INTRO_CARD.DURATION_SECONDS;
   // AFTER
   const introDur = contentType === 'news' ? CONFIG.INTRO_CARD.DURATION_NEWS
                 : contentType === 'nba'  ? CONFIG.INTRO_CARD.DURATION_NBA
                 : CONFIG.INTRO_CARD.DURATION_TWITCH;
   ```
5. If any call site can't determine `contentType` at that point, fall back to `DURATION_SECONDS` (the deprecated key) as a safe default.

**Grep to find call sites:**
```bash
grep -n "INTRO_CARD.DURATION_SECONDS\|INTRO_CARD\.DURATION" server.js
```

**Verification:**
- `node -c server.js` exit 0
- Grep check: all call sites updated, 0 un-branched references to `DURATION_SECONDS` in places where content type is known

**Commit message:**
```
feat(config): intro card duration per content type (Gap #44)

Replaces unified CONFIG.INTRO_CARD.DURATION_SECONDS = 10 with per-type
keys: Twitch 10s, NBA 8s, News 12s. Rob directive from 2026-04-12 evening.

Changes:
- lib/config.js:55 — add DURATION_TWITCH/NBA/NEWS keys alongside existing
  DURATION_SECONDS (kept for backwards compat as fallback)
- server.js — update 3-5 call sites to branch on contentType

References: gap audit Gap #44, LONGFORM_FIX_ROTATION.md to-fix entry
```

---

### Gap #45 — Outro freeze-hold via FFmpeg filter

**File:** `server.js` — NBA/Twitch/News assembly outro handling (need to find exact location via grep)
**Context:** POST_PUBLISH_TASKS.md §2.2: at "Appreciate you!" Bobby G's head drifts upward as the last word lands, then the video hard-cuts to end. Rob approved a freeze-hold fix: freeze the last frame of the OUTRO segment for 0.5-1.0 seconds before concat finalizes, so the viewer sees Bobby G hold his final pose briefly before the video ends cleanly.

**Action:**
1. Find where the OUTRO segment is processed in the assembly loop. Likely in the same per-segment processing loop at `server.js:~3700-4100` where avatar segments are normalized.
2. Detect the outro segment by its label (`OUTRO` scene header, or position-in-list = last avatar segment)
3. For the outro segment only, add an FFmpeg filter that extends the last frame:
   ```javascript
   // For outro segment: freeze the last 0.75 seconds by extending the last frame
   const outroVfFilter = 'tpad=stop_mode=clone:stop_duration=0.75';
   // Applied as: ffmpeg -i outro.mp4 -vf "tpad=stop_mode=clone:stop_duration=0.75" outro_held.mp4
   ```
4. `tpad` is the FFmpeg filter for time-padding — `stop_mode=clone` clones the last frame, `stop_duration=0.75` extends by 0.75 seconds. Standard FFmpeg pattern.
5. Apply to all 3 long-form content types (cross-content fix). Do NOT apply to short-form.

**Verification:** Run any long-form smoke test. Open the assembled MP4 and confirm the last ~0.75s holds Bobby G's final frame before the video ends. Visually cleaner outro — no hard cut on the last word.

**Commit message:**
```
fix(assembly): freeze-hold last frame of outro segment by 0.75s (Gap #45)

POST_PUBLISH_TASKS §2.2: Bobby G's head drifts upward at "Appreciate you!"
and the video hard-cuts on the last word. Freeze-hold the last frame for
0.75 seconds so the final pose settles before the video ends.

Changes:
- server.js:~{LINE} — detect OUTRO segment in assembly loop, apply
  `tpad=stop_mode=clone:stop_duration=0.75` FFmpeg filter to extend the
  last frame by 0.75s before concat

Applies to all 3 long-form content types (News + NBA + Twitch). Not
applied to short-form.

References: POST_PUBLISH_TASKS.md §2.2, gap audit Gap #45
```

---

## Rotation doc updates after each commit

For every item that ships:

1. **STATUS.md** → `🤖 Last Agent Action` table row with: agent=Cline, task, file(s), commit hash, timestamp
2. **LONGFORM_FIX_ROTATION.md** → find the gap in the `🔴 To Fix` or `📤 Dispatched` section, move to `✅ Shipped` with commit hash
3. **Rotation log** → new line dated 2026-04-13 with the gap number and outcome

---

## Ship discipline rules

1. **One commit per item.** Gap #15 + #33 can bundle (same pattern, two branches of same function). Everything else ships standalone.
2. **Atomic staging:** `git add <files> STATUS.md LONGFORM_FIX_ROTATION.md && git commit -m "..." && git push` in a single chained command
3. **Do NOT use `git add -A`** — always explicit file list per `COMMIT_CHECKLIST.md`
4. **Commit messages follow conventional commit format:** `fix:` / `feat:` / `chore:` with file:line references
5. **Each commit must leave the server in a working state** — `node -c server.js` exit 0 before every commit
6. **Nodemon auto-restarts on server.js save** — monitor the boot output for any startup errors before committing
7. **If an item has a hidden blocker** (e.g., Gap #39 diagnostic reveals something unexpected), flag it in `LONGFORM_FIX_ROTATION.md` as blocked with a reason and skip to the next item rather than stall
8. **Work until stuck or done.** If you finish all 16, stop. If you hit a blocker on one, flag it and skip to the next.

---

## What to do if you run into problems

**If an item has an unexpected blocker you can't resolve:**
- Mark the gap as `🟡 Blocked` in `LONGFORM_FIX_ROTATION.md` with a short explanation
- Update STATUS.md with what you found
- Skip to the next item
- Do NOT stop the queue

**If a fix breaks something downstream:**
- `git revert HEAD && git push` immediately
- Mark the gap as `🟡 Needs rework` in `LONGFORM_FIX_ROTATION.md`
- Skip to the next item

**If two items conflict on the same file:**
- Ship them in order that minimizes rework
- Second item rebuilds on first — not a parallelism issue for atomic commits

**If VectCutAPI or nodemon isn't running:**
- VectCutAPI is NOT required for any item in this handoff. Ignore.
- If nodemon is down, start it with `nodemon server.js` from repo root before committing any server.js changes

---

## Checklist — items by grouping

**News Wave 0:**
- [ ] Gap #5 — Remove dead `/news/generate-intro-card` endpoint
- [ ] Gap #13 — News `/generate-publish-copy` quality rewrite
- [ ] Gap #15 — News chapter label humanization (bundled with #33)
- [ ] Gap #17 — Upload-Post cross-platform confirmation logging

**NBA Wave 0:**
- [ ] Gap #19 — NBA SELECT GAMES UX guard
- [ ] Gap #20 — NBA ESPN highlight pattern filter
- [ ] Gap #24 — NBA empty clipUrl warning
- [ ] Gap #33 — NBA chapter label humanization (ships with #15)
- [ ] Gap #34 — NBA `/generate-publish-copy` quality rewrite

**Cross-cutting Wave 0:**
- [ ] Gap #10 + #40 — Gate 3 LATE-sample OUTRO check wording fix
- [ ] Gap #39 — White strip diagnostic + fix
- [ ] Gap #42 — Gate 3 TV CARD check (may auto-resolve from Handoff 7)
- [ ] Gap #44 — Intro card duration per content type
- [ ] Gap #45 — Outro freeze-hold FFmpeg filter

**Total: 16 items across 15 possible commits (Gap #15 + #33 bundle as 1 commit).**

Ship them all. Stop when stuck or done. Report commit hashes as they land.
