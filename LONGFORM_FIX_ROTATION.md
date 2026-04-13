# Long-Form Fix Rotation

**⚠️ Every agent picking up a dispatch from this doc: re-read `COMMIT_CHECKLIST.md` before committing.** Specifically: (1) update `STATUS.md` → 🤖 Last Agent Action table (pre-commit hook blocks skips), (2) update every `.md` doc that references the files you changed, (3) atomic staging (`git add <files> && git commit -m "..."` in one command — never split, never `git add -A`), (4) conventional commit format with `file:line` references, (5) nodemon auto-restarts Node on `server.js` changes, (6) Python dashboard server needs manual restart on `cwn_production.html` changes.

**Purpose:** Single living doc tracking all fixes needed to get **NBA** and **News** long-form passing every gate end-to-end with creative pieces (intro cards / TV card / source clips / thumbnail / pinned comment) intact and visible in YouTube Studio. Twitch long-form has already shipped clean; its remaining polish is tracked in `POST_PUBLISH_TASKS.md`.

**Workflow:**
1. Rob gives feedback → Claude Code appends to `🔴 To Fix`
2. Rob says "dispatch" → Claude Code writes a focused `CLINE_HANDOFF_*.md` for the batch, moves items to `📤 Dispatched to Cline`
3. Cline ships → items move to `✅ Shipped` with commit hash
4. Repeat until both NBA **and** News long-form pass end-to-end
5. When long-form passes, spin up `SHORTFORM_FIX_ROTATION.md` and repeat the process for short-form

**Ship order (Rob decision, 2026-04-12):** News first (bounded, same pattern as working Twitch path), NBA second (architectural rework to live-narration mode).

**Out of scope for this doc:** Twitch long-form polish (see `POST_PUBLISH_TASKS.md`), short-form anything.

---

## Evidence base (from last night's test runs)

Anyone picking up this work can re-verify these files independently:

**News long-form — two runs, both structurally broken (0 source clips, no TV card), both auto-proceeded to Upload-Post:**
- `output/news_sunday_april_12_2026_22_avatar_0_clips__1775968382988.mp4` (04:36 AM, Gate 3 93/100)
- `output/news_sunday_april_12_2026_22_avatar_0_clips__1775973340051.mp4` (05:58 AM, Gate 3 83/100) — Rob reviewed this one
- `output/qa_failures/gate3_assembly_pass_1775968564381.txt`
- `output/qa_failures/gate3_assembly_pass_1775973522181.txt`
- `output/qa_failures/gate2_segments_manual_review_1775973331944.txt`

**Key signal:** filename contains `22_avatar_0_clips` — the assembly received zero source clip URLs. Gate 2 sampled 3 avatar segments only (lip sync / audio / framing — clean). Gate 3 checklist has no TV-card check and no clip-presence check, so both runs auto-proceeded despite being structurally broken.

**Late-sample Gate 3 report on the 05:58 run:** "avatar freezes at 0:16, audio cuts out, video does not end cleanly" — 50/100 on that sample, -30 deduction, still above 70 threshold so it shipped.

**NBA long-form:** failed at Gate 1 (script stage). Script was written in Twitch pattern (intro → clip → reaction → repeat) when NBA requires live-narration over the highlight. No NBA MP4 reached assembly.

---

## 🔴 To Fix

### News long-form

1. **Source clip URLs never reach `/assemble` for News.** Filename `22_avatar_0_clips` is proof. Need to trace where the News clip URLs are dropped — likely between `generate-full-script` returning `orderedClipUrls[]` and the dashboard's assembly call, OR the server-side assembly loop recognizes Twitch-style scene headers (`STREAMER_CLIP_SETUP`) but skips News-style headers (`STORY#_INTRO` / `STORY#_REACTION`). Until clips flow through, nothing else on the News track matters.
2. **News TV card overlay burn never fires.** `/news/generate-intro-card` endpoint exists at `server.js:4615` and scrapes Open Graph images to 640×360, but nothing in the assembly path invokes it for `STORY#_INTRO` scenes. Need to wire the intro-card generation into the News assembly branch the same way Twitch does for streamer intros, using the current `CONFIG.VISUAL_LAYOUTS.LONG_FORM.OVERLAY_ZONE` dimensions (520×293 at x=1360, y=60).
3. **Gate 3 is blind to missing TV card and missing clips.** Gemini's sample checklist is lip sync / ticker / freeze / transitions / audio / avatar visibility / background. It does not verify "is there a TV card in the top-right during intro scenes" or "do source clips play between avatar segments." Add both checks to the Gate 3 prompt so a 0-clip, 0-card video can never auto-proceed again. This is a defensive fix — protects NBA and Twitch too.
4. **Late-sample freeze + outro audio cut-out on News runs.** Both overnight News runs hit the same failure pattern near ~205s (avatar freezes, audio cuts). Root cause unconfirmed — possibilities: (a) all-avatar concat path (no source clips) hitting the old xfade branch that commit `6cd184a` only fixed for `clipCount > 0`, (b) an outro-segment rendering issue, (c) News-specific segment length / pacing. Needs ffprobe bitrate analysis on the broken file first, then a targeted fix.
5. **Rob's holistic read on the 05:58 run:** "the whole video was messed up including Bobby G was off because it wasn't the correct flow with no clips from the news items." Expected behavior: once items 1–4 are fixed, the News show should self-correct because the script was built around real stories that will now actually play. Re-assess after the next clean News run before adding more script-level items.

### NBA long-form

1. **NBA requires architectural rework to live-narration mode (new assembly branch).** Current pipeline treats NBA like Twitch/News (intro → clip → reaction → repeat, clips inserted *between* avatar segments). Actual NBA format: Bobby G **narrates over** the ESPN highlight while it plays full-bleed, then cuts to an avatar outro reaction, then sets up the next game. This is a new assembly mode, not a prompt tweak. Sub-pieces:
   - **Gemini script prompt (NBA-specific):** generate narration timed to highlight length (~30s per game), not setup/reaction beats. Narration word count ≈ duration × 0.85 speed × ~3 words/sec ≈ ~75 words per 30s clip. Separate `NARRATION` and `REACTION` scene headers per game.
   - **Assembly branch (NBA-specific):** for each game section, mix HeyGen narration audio **on top of** the highlight video track (duck or mute native highlight audio), avatar hidden during narration, avatar visible only for the reaction/setup beats between games.
   - **Gate 1 check:** validate narration word count matches highlight duration at current speak speed.
   - **Gate 3 check:** verify highlight plays full-bleed during narration sections and avatar appears only during reaction/setup beats.
   - **Failed at Gate 1 last night** — script was in Twitch pattern, blocked before HeyGen. No NBA MP4 exists to diagnose.
2. **Scope note for whoever picks this up:** this is a bigger lift than any News item. Treat as its own focused handoff. Don't bundle with News fixes. Consider landing in two commits — script prompt first (unblocks Gate 1 so we can see Gemini's narration output), then assembly branch second (unblocks full end-to-end).

### Twitch long-form (reopened for creative polish)

1. **Reaction → Follow CTA run-together split (Twitch-specific).** After Bobby G's second clip reaction, the "Follow [streamer]. Link in description." line runs into the reaction with no breathing room — same HeyGen render, same gesture envelope, SSML `<break>` alone isn't enough. Fix: split `[STREAMER]_CLIP2_REACTION` into two separate scenes so the reaction and CTA land as separate spoken deliveries with a natural concat boundary. Touches Gemini prompt, Gate 1 scene count validation, `parseSegments_v2` header recognition, scene count math. Rob approved Option 1 (split scenes) per POST_PUBLISH_TASKS.md §2.1. Test: 1 streamer × 1 clip run after shipping.

### Cross-cutting (affects all 3 long-form content types)

1. **Intro card duration per content type (config plumbing + new defaults).** Currently `CONFIG.INTRO_CARD.DURATION_SECONDS = 10` is a single key applied to all 3 types. Rob wants per-type control. Fix: replace with three keys — `DURATION_TWITCH: 10`, `DURATION_NBA: 8`, `DURATION_NEWS: 12` — in `lib/config.js`. Update the three assembly call sites that currently read `DURATION_SECONDS` to read the per-type key based on `contentType`. Rob-specified values: 10 / 8 / 12 seconds. Easy one-commit fix. Source: POST_PUBLISH_TASKS.md §3.2.
2. **Outro head-floating / abrupt end (FFmpeg freeze-hold on last 0.5–1.0s).** At "Appreciate you!" Bobby G's head drifts upward as the last word lands, then the video hard-cuts to end. Fix: FFmpeg freeze-hold on the last 0.5–1.0 seconds of the outro segment before assembly finalizes. Applies to all 3 long-form content types (same Bobby G avatar, same universal outro issue). Rob approved for testing. Source: POST_PUBLISH_TASKS.md §2.2.

### Cross-cutting / parked

1. **Bobby G speed for News (currently 0.85 long-form, 0.95 short-form via `HEYGEN_SPEAK_SPEED` in `.env`).** Rob's question: might News need slower delivery than 0.85? **Decision deferred** until we see a correctly-assembled News show (items 1–4 above shipped) — current read is that Bobby G sounded "off" on last night's News runs because the flow was broken, not because the speed was wrong. Re-assess after next clean News run.

---

## 📤 Dispatched to Cline

*(empty — all dispatched items have shipped)*

---

### NBA long-form Wave 1+2 — shipped 2026-04-13

**Handoff:** `CLINE_DISPATCH_PAIRED_20260411.md` + `CLINE_DISPATCH_PAIRED_LATE_20260411.md`
**Dispatched:** 2026-04-11 (Wave 1: NBA prompt rewrite; Wave 2a/2b: Gate 1 QA alignment)
**Shipped:** 2026-04-13 12:18 AM ET, 1 commit pending push to `origin/main`

| Wave | Commit | What |
|------|--------|------|
| Wave 1 | (prior session) | NBA Gemini prompt rewrite: 4-scene pattern (INTRO+SETUP+CLIP_REACTION+REACTION) → 3-scene pattern (INTRO+NARRATION+REACTION). NARRATION = Bobby G audio plays OVER the ESPN highlight clip (voiceover branch). CLIP_REACTION dropped — PIP was never implemented in assembly (fiction). Word count formula: `clipDuration × 2.5` (lower) to `clipDuration × 3` (upper) words per game. Per-game word count targets injected into GAME DATA block. sceneHeaders push updated to `GAME#_TEAMS_NARRATION`. |
| Wave 2a | pending | `claudeScriptQA()` Gate 1 NBA alignment: (1) checklist comment updated to 3-scene pattern (`GAME1_INTRO, GAME1_NARRATION, GAME1_REACTION are 3 SEPARATE scenes`); (2) `expectedScenes` NBA: `1 + (items.length * 4) + 1` → `1 + (items.length * 3) + 1`; (3) checklist item 6: GAME SETUP → NARRATION (play-by-play commentary sized to cover clip duration); (4) checklist item 10: word count → per-game NARRATION targets (±15% tolerance). |
| Wave 2b | pending | `geminiScriptQA()` legacy Gate 1 NBA alignment: (1) `expectedScenes` NBA: `1 + (streamers.length * 4) + 1` → `1 + (streamers.length * 3) + 1`; (2) checklist item 5: GAME SETUP → NARRATION; (3) checklist item 9: word count → per-game NARRATION targets. Also: `generate-full-script` endpoint `expectedScenes` NBA: `* 4` → `* 3`. |

**Grep verified:** 0 `CLIP_REACTION` hits in NBA QA/prompt blocks; 15+ `NARRATION` hits across Gate 1 QA (lines 2347, 2353, 2357, 2654, 2694, 2698) and NBA prompt block (lines 6912–7266). `node -c server.js` → exit 0.

**Untouched:** News, Twitch, short-form code paths.
**Next:** Rob runs NBA long-form smoke test. Expected: Gate 1 passes with 3-scene NARRATION structure. Assembly branch (NBA narration-over-clip mode) is the next architectural piece — tracked separately in `🔴 To Fix → NBA long-form → item 1`.

---

---

---

---

## 🔴 Postmortem — News batch 1 scope miss (2026-04-12)

News batch 1 shipped 4 technically-correct fixes but the underlying problem was wrong. The `22_avatar_0_clips` signature on last night's runs looked like a plumbing bug (Fix 1 missing `orderedClipUrls` build for News), so that's what got dispatched. The real root cause was older and lived in a completely different part of the code: **commit `b31533f` (Apr 11 00:30 ET, "refactor: reorganize root into folders") moved `clipzworld_newscast.html` into `tools/` but `server.js:1300`'s `/newscast-overlay` route kept pointing at the repo-root path.** Every News run since Apr 11 has been:

1. Running the burn loop successfully (Puppeteer + FFmpeg both exit 0)
2. Producing a transparent blank PNG because Express returns HTTP 500 for the missing HTML file
3. Blending a transparent PNG onto Bobby G → visually unchanged output
4. Logging `📰 NEWS newscast overlay burned [N/N]` for every intro segment, masking the silent failure

Fix 2 from batch 1 (wiring `cardData` onto `STORY#_INTRO` segments) was correct and necessary — it meant `cardData.title` / `cardData.category` etc. were present for the Puppeteer page to inject. But none of that mattered because Puppeteer never loaded the actual HTML page that would consume the injected data. Fix 2 was a prerequisite that shipped ahead of the real fix; it's still needed, just wasn't sufficient alone.

Separately, the `clipCount === 0` filename signature on today's run is **not a new regression** — it's how News has always been: News items from the dashboard don't carry `videoUrl` fields at all. Fix 1 from batch 1 (build `orderedClipUrls` from `items[].videoUrl`) correctly filters to an empty array when no video URLs exist, which is the actual shape of News data. That still leaves the Road A vs Road B architectural question (below) but it's not a fix target.

**Lesson:** a log line that says "overlay burned" is not verification — it's a trace that the code path executed. Real verification requires either a visible output in the assembled MP4 or an explicit downstream check that the overlay PNG has non-zero visible pixel content before FFmpeg consumes it. Fix 5 should add a size-and-content sanity check on the Puppeteer screenshot output to prevent this whole class of bug from recurring silently.

---

## 🤔 Road A vs Road B — parked until Fix 5 ships and we see a clean visual run

Two possible directions for News as a content type:

- **Road A:** Wire up a News video source. Either YouTube search per headline for a ~30s clip, or article-page scraping for embedded `<video>` tags. News keeps its current setup/clip/reaction scene structure with real clips between avatar segments. Effort: M. Risks: copyright, clip quality variance, YouTube rate limits.
- **Road B:** News is all-avatar anchor-narration. Rewrite the News Gemini prompt at `server.js:6695-6717` to drop `[CLIP PLAYS HERE]` markers and the `STORY#_CLIP_REACTION` scene type. News becomes `STORY#_INTRO → STORY#_NARRATION → STORY#_OUTRO_REACTION` × 10 + COLD_OPEN + OUTRO = 32 total scenes instead of 42. Bobby G delivers continuous narration per story, no dead-air clip beats. Gate 1 scene-count math updates from `1 + 10*4 + 1 = 42` to `1 + 10*3 + 1 = 32`. The full-screen newscast graphics overlay (blend mode full-frame) becomes the visual rotation per story. Effort: S.

**Parked until Fix 5 ships and Rob reviews a run where the newscast overlay is actually visible.** Rob's current read on News was colored by the silently-broken overlay (bug-level failure masquerading as design-level failure). After Fix 5, the visual truth of what News can look like becomes observable for the first time since Apr 11. Decision to be made after that run, not before.

---

## ✅ Shipped

### News long-form batch 1 — shipped 2026-04-12

**Handoff:** `CLINE_HANDOFF_NEWS_LONGFORM_FIXES.md`
**Dispatched:** 2026-04-12 ~4:47 PM ET
**Shipped:** 2026-04-12, 4 commits pushed to `origin/main`

| Fix | Commit | What |
|-----|--------|------|
| 1/4 | `e17e647` | `feat(news): build orderedClipUrls for News` — root cause of `22_avatar_0_clips`. News block in `generate-full-script` now maps `items[]` → `orderedClipUrls[]` so source clips flow through to assembly. |
| 2/4 | `eb67b0e` | `feat(news): attach cardData to STORY#_INTRO segments + persist newsItems` — TDZ fix in heygen-poller, `cardData` attached to each `STORY#_INTRO` segment, `newsItems` persisted on job card, `allNewsIntros` regex updated to match `STORY\d+_INTRO`. Fixes blank News TV card overlays. |
| 3/4 | `9271297` | `feat(gate3): Gate 3 blind-spot detection for missing clips + TV card` — `clipsExpectedButMissing` flag wired into `hasCriticalFail` (auto-fail), -25pt deduction, EARLY/MIDDLE checklists, and why-doc. Prevents Gate 3 scoring 93/100 on a 0-clip News video. |
| 4/4 | `ca56ccb` | `fix(assembly): News 22-segment all-avatar jobs use concat demuxer not xfade` — added `(contentType === 'news' && tsFiles.length > 10)` to concat demuxer condition. News all-avatar jobs were falling through to the broken xfade branch causing video freeze. |

**Untouched:** NBA, Twitch, short-form code paths.
**Next:** Rob runs News long-form smoke test. If clean, item 5 from original News feedback (Bobby G "off" holistic read) either self-resolves or surfaces new specifics to add to the rotation.

### News long-form batch 2 — shipped 2026-04-12

**Handoff:** `CLINE_HANDOFF_NEWS_LONGFORM_FIXES_BATCH2.md`
**Dispatched:** 2026-04-12 (post-smoke-test-1 feedback)
**Shipped:** 2026-04-12, 1 commit pushed to `origin/main`

| Fix | Commit | What |
|-----|--------|------|
| 5 | `971429d` | `fix(news): /newscast-overlay route path — tools/ prefix missing (server.js:1300)` — commit `b31533f` moved `clipzworld_newscast.html` into `tools/` but `server.js:1300` kept pointing at repo root. `res.sendFile` threw ENOENT → Express HTTP 500 → Puppeteer screenshotted blank PNG → FFmpeg blended blank over Bobby G → invisible newscast overlay for every News run since Apr 11. Same class of bug as ticker path fix in `0d13fb0`. Fix: add `tools/` prefix. Verified: `curl http://localhost:3000/newscast-overlay` returns HTTP:200 SIZE:15964. |

**Untouched:** NBA, Twitch, short-form code paths.
**Next:** Rob runs News long-form smoke test #2. Expected: newscast overlay now visible in assembled video. Road A vs Road B decision to be made after that run.

### News long-form batch 3 — shipped 2026-04-12

**Handoffs:** `CLINE_HANDOFF_NEWS_LONGFORM_FIXES_BATCH3.md` (Fix 6) + `CLINE_HANDOFF_NEWS_LONGFORM_FIXES_BATCH3_FIX7.md` (Fix 7)
**Dispatched:** 2026-04-12 (Fix 6: post-smoke-test-1 script review; Fix 7: post-smoke-test-3 overlay root-cause)
**Shipped:** 2026-04-12, 2 commits pushed to `origin/main`

| Fix | Commit | What |
|-----|--------|------|
| 6 | `9a4fcc6` | `fix(news): rewrite Gemini prompt to eliminate INTRO/SETUP repetition (server.js:6685-6737)` — SETUP rewritten to EXACTLY 1 sentence (new fact or hook, not a restatement of INTRO); CLIP_REACTION renamed to SUMMARY (1-2 sentences factual recap of what just played, no opinions/reactions/quips); REACTION tightened to deadpan take only (must not recap — that's SUMMARY's job); word count target 80-120 → 100-140 per story; Gate 1 QA comment + sceneHeaders push updated to STORY1_SUMMARY. Scene count unchanged (42 for 10 stories). No downstream code changes. |
| 7 | `4a2ac67` | `fix(news): newscast overlay RGBA alpha + logo position` — Complete rewrite of `tools/clipzworld_newscast.html` + `generateNewscastOverlay()` overhaul + burn loop state machine + `LOGO_POS_NEWS` in `lib/config.js`. Two critical rendering bugs fixed: (a) `omitBackground:true` in `page.screenshot()` — without it `body{background:transparent}` composites against white canvas → rgb24 PNG with YAVG~213 instead of real RGBA; (b) `overlay=0:0` replaces broken `blend=all_mode=normal:all_opacity=1` which doesn't composite RGBA alpha correctly. Two-state burn for `STORY#_INTRO` segments: PNG A (lower-third visible) for `t=0..introDur`, PNG B (lower-third hidden) for `t>introDur`. Logo override: `LOGO_POS_NEWS = {x:1725, y:910, size:90, opacity:0.85}` on Bobby G's coffee mug. Grep verified: `omitBackground` at 3830+10477+10479; `overlay=0:0` at 3829+3889+3890+3896+3936; `LOGO_POS_NEWS` at 4390+9817. `node -c server.js` exit 0. |

**Untouched:** NBA, Twitch, short-form code paths.
**Next:** Rob runs News long-form smoke test #4. Expected: newscast chrome (story list, lower-third, top bar, segment tag) now visible in assembled video for the first time since Apr 7.

### News long-form Fix 8B — shipped 2026-04-12 late evening

**Handoff:** `CLINE_HANDOFF_NEWS_LONGFORM_FIX_8B.md`
**Dispatched:** 2026-04-12 (post-smoke-test-4 code audit)
**Shipped:** 2026-04-12, 1 commit pushed to `origin/main`

| Fix | Commit | What |
|-----|--------|------|
| 8B | pending | `fix(news): Fix 8B — build News TV card (og:image scrape + OVERLAY_ZONE burn)` — All 6 pieces: (1) `scrapeArticleOgImage()` helper (axios + cheerio, extracts `<meta property="og:image">`); (2) News analysis block runs og:image scraping in parallel with Gemini, attaches `item.heroImageUrl`; (3) Job card save persists `heroImageUrl` in `newsItems[]`; (4) heygen-poller cardData extended with `heroImageUrl` for `STORY#_INTRO` segments; (5) `generateNewsStoryCardPNG()` Canvas renderer at 2× resolution (1040×586 for OVERLAY_ZONE 520×293) — hero image left-half, dark right panel, gold border, headline word-wrapped, source tag, category badge; (6) Second FFmpeg overlay burn inside Fix 7 `isStoryIntro` block — runs AFTER chrome burn, `enable='lte(t,introDur)'` time-gating, non-fatal on failure. `node -c server.js` → SYNTAX OK. Root cause of "no TV card" across all News smoke tests Apr 7–12: archived handoff asserted it was "already working" but `generateNewsStoryCardPNG` never existed in code. |

**Untouched:** NBA, Twitch, short-form code paths.
**Next:** Rob runs News long-form smoke test #5. Expected: TV card (og:image hero + headline + source) visible top-right at OVERLAY_ZONE during each STORY#_INTRO segment for first 10s.

### News long-form Fix 9 — shipped 2026-04-12 late night

**Handoff:** `CLINE_HANDOFF_NEWS_CLIP_SCRAPING.md`
**Dispatched:** 2026-04-12 (post-Fix-8B, Road A video scraping)
**Shipped:** 2026-04-12, 1 commit pushed to `origin/main`

| Fix | Commit | What |
|-----|--------|------|
| 9 | pending | `fix(news): Fix 9 — wire Al Jazeera video scraping via JSON-LD + yt-dlp (unblocks mid-story clips)` — New `scrapeArticleVideo(articleUrl)` helper: fetches article HTML, extracts JSON-LD `VideoObject.embedUrl` (Brightcove player URL), runs `yt-dlp --skip-download --dump-json` on the embed URL (yt-dlp rejects article URLs as "Unsupported URL" but succeeds 100% on Brightcove embed URLs), filters live streams (`is_live=true`, `duration=0`, URL contains `thehlive.com`), returns HLS manifest URL. Wired into News analysis block alongside `scrapeArticleOgImage` and `geminiAnalyzeClip` via `Promise.all` — `scrapedVideoUrls[i]` assigned to `item.videoUrl` when non-null, which flows through Fix 1's `orderedClipUrls` build automatically. Hit rate: 40% on mixed RSS feed (3/10 on-demand clips + 1 live stream filtered), 100% on `/video/` path articles. `node -c server.js` → exit 0. |

**Untouched:** NBA, Twitch, short-form code paths.
**Next:** Rob runs News long-form smoke test #6. Expected: `orderedClipUrls` now contains real Al Jazeera HLS clip URLs for `/video/` path stories — filename should show `N_avatar_M_clips` with M > 0 for the first time.

---

### News long-form Gap #51 — shipped 2026-04-13

**Handoff:** `CLINE_HANDOFF_GAP_51_STAGE_DIRECTION_LEAK.md`
**Dispatched:** 2026-04-13 (smoke test #6 failed Gate 3 three times — `[3-second pause — hold on source clip]` burned as on-screen text)
**Shipped:** 2026-04-13, commit `d5c53ea` pushed to `origin/main`

| Fix | Commit | What |
|-----|--------|------|
| Gap #51 | `d5c53ea` | `fix(news): defensive cleanAvatarText in generateVideo() + remove [3-second pause] stage direction from Gemini prompt` — Root cause: Gemini prompt VALIDATION CHECKLIST had 3 references instructing it to write `[3-second pause — hold on source clip]` into every STORY#_REACTION scene. HeyGen renders bracket text as burned-in on-screen text. Root cause fix (server.js): (1) removed `+ [3-second pause — hold on source clip]` from REACTION scene rule; (2) replaced `Add "[3-second pause — hold on source clip]" before moving to next story` with `Between stories, the assembly layer will add a 3-second hold on the source clip before cutting to the next story. Do NOT write stage directions in the script — just end the REACTION scene with a single deadpan sentence.` Defensive fix (cwn_production.html): wrapped `script` in `cleanAvatarText()` inside `generateVideo()`'s HeyGen payload — `applyPronunciations(cleanAvatarText(script))` — so any bracket directives that slip through the prompt are stripped before reaching HeyGen API. `node -c server.js` → exit 0. |

**Untouched:** NBA, Twitch, short-form code paths.
**Next:** Rob runs News long-form smoke test #7. Expected: no `[3-second pause]` text burned into HeyGen renders — Gate 3 should pass on first attempt.

---

### News long-form Fix 9b — shipped 2026-04-13

**Handoff:** `CLINE_HANDOFF_NEWS_FIX_9B_HLS_DOWNLOAD.md`
**Dispatched:** 2026-04-13 (smoke test #7 unblocked — Fix 9 returns Brightcove HLS URLs but `downloadFile()` blocked them)
**Shipped:** 2026-04-13, 1 commit pending push to `origin/main`

| Fix | Commit | What |
|-----|--------|------|
| 9b | pending | `fix(downloadFile): allow Brightcove CDN + handle HLS manifests via FFmpeg` — Fix 9's `scrapeArticleVideo()` returns Brightcove HLS manifest URLs (e.g. `https://manifest.prod.boltdns.net/manifest/v1/hls/v3/clear/...`) but `downloadFile()` blocked them at the SSRF whitelist with "URL blocked: not from trusted domain". Even if whitelisted, naive axios streaming downloads the ~2KB text manifest, not the actual video segments. Two changes to `downloadFile()` in `server.js`: (1) Added Brightcove + Al Jazeera domains to `trustedDomains[]`: `boltdns.net`, `brightcove.net`, `brightcove.com`, `edge.api.brightcove.com`, `aljazeera.com`, `aljazeera.net`. (2) HLS detection branch: `/\.m3u8(\?|$)/i.test(url) \|\| /\/hls\//i.test(url)` routes to `execFile(ffmpegPath(), ['-i', url, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart', '-y', destPath])` with 120s timeout — FFmpeg resolves all HLS segments and muxes to MP4. Axios streaming path unchanged for non-HLS URLs. `node -c server.js` → exit 0. |

**Untouched:** NBA, Twitch, short-form code paths.
**Next:** Rob runs News long-form smoke test #7. Expected: Al Jazeera HLS clips now download successfully via FFmpeg — assembled video should show `N_avatar_M_clips` with M > 0 for the first time.

---

### News long-form Fix 8 (Gate 2 regex) — shipped 2026-04-13

**Handoff:** `CLINE_HANDOFF_NEWS_SMOKE_TEST_7_FIXES.md` (Fix 8 of 10)
**Dispatched:** 2026-04-13 (post smoke test #7 review — Gate 2 regex blind to bracketed scores)
**Shipped:** 2026-04-13, 1 commit pending push to `origin/main`

| Fix | Commit | What |
|-----|--------|------|
| 8 | pending | `fix(gate2): Gate 2 score regex handles bracketed numbers + prompt uses angle brackets` — Root cause: Gate 2 Gemini prompt used `[number from 0-100]` bracket notation in the `OVERALL SCORE` field. Gemini mimics the format and outputs `OVERALL SCORE: [85]` with literal brackets. The `segScore` regex `/OVERALL SCORE:\s*(\d+)/i` fails to match — every segment defaulted to 80/100, causing every smoke test to stall at MANUAL_REVIEW even when real Gemini scores were 95-98. Fix A (server.js:2991): regex updated to `/OVERALL SCORE:\s*\[?(\d+)\]?/i` — optional brackets. Fix B (server.js:2970): prompt placeholder changed from `[number from 0-100]` to `<number from 0-100>` to discourage future bracket copying. Cross-cutting fix — benefits News, NBA, and Twitch Gate 2 scoring. |

**Untouched:** News, Twitch, short-form code paths. NBA Gate 2 prompt also benefits (same regex).
**Next:** Continue shipping remaining 9 fixes from `CLINE_HANDOFF_NEWS_SMOKE_TEST_7_FIXES.md`.

---

### NBA TV card Fix 10 (canvas 720×840 → 1040×586 landscape) — shipped 2026-04-13

**Handoff:** `CLINE_HANDOFF_NEWS_SMOKE_TEST_7_FIXES.md` (Fix 10 of 10)
**Dispatched:** 2026-04-13 (Rob-approved 1-line exception — NBA TV card canvas was portrait 6:7, causing horizontal stretch + vertical squish in OVERLAY_ZONE)
**Shipped:** 2026-04-13

| Fix | Commit | What |
|-----|--------|------|
| 10 | pending | `fix(nba): NBA TV card canvas 720×840→1040×586 landscape layout` — Root cause: `generateGameStoryCardPNG()` used 720×840 portrait canvas (6:7 ratio) but OVERLAY_ZONE is 520×293 (16:9 landscape). FFmpeg lanczos scale squished the portrait card into landscape, distorting all text and images. Fix: rewrite canvas from `720×840` to `1040×586` (exact 2× pixel-doubled OVERLAY_ZONE). Layout changed from portrait (center image, text below) to landscape (image left-half at 42%W × 78%H, text right column starting at 44%W). Gold border added around entire card. Title font `Math.round(H*0.1)` (~59px), subtitle `Math.round(H*0.075)` (~44px), text starts at `Math.round(H*0.28)` from top. All pixel values proportional to W/H. `node -c server.js` → exit 0. Rob-approved exception to News-only scope rule. |

**Untouched:** News, Twitch, short-form code paths. Only `generateGameStoryCardPNG()` in server.js touched.
**Next:** Continue shipping remaining News fixes from `CLINE_HANDOFF_NEWS_SMOKE_TEST_7_FIXES.md`.

---

### News long-form Fix 7 + Fix 4 (newscast overlay CSS) — shipped 2026-04-13

**Handoff:** `CLINE_HANDOFF_NEWS_SMOKE_TEST_7_FIXES.md` (Fix 7 + Fix 4 of 10)
**Dispatched:** 2026-04-13 (post smoke test #7 review — LIVE indicator flush right, flag flush left)
**Shipped:** 2026-04-13

| Fix | Commit | What |
|-----|--------|------|
| 7+4 | pending | `fix(news): LIVE indicator margin-right:80px + flag flush left (Fix 7+4)` — Fix 7: added `margin-right: 80px` to `.top-right` CSS rule in `tools/clipzworld_newscast.html` — pulls LIVE indicator + date inward from right frame edge. Fix 4: `.lower-third` CSS — removed slide-in animation from `.visible` state, added explicit `transform: translateX(0)` and `margin-left: 0` to ensure flag leading edge is flush at x=0 of frame (no 8px inset). Both are CSS-only changes in the same file, bundled as one commit. |

**Untouched:** NBA, Twitch, short-form code paths. Only `tools/clipzworld_newscast.html` CSS touched.

---

### News long-form Fix 3 (source attribution removal) — shipped 2026-04-13

**Handoff:** `CLINE_HANDOFF_NEWS_SMOKE_TEST_7_FIXES.md` (Fix 3 of 10)
**Dispatched:** 2026-04-13 (Bobby G must NEVER speak source names on air)
**Shipped:** 2026-04-13

| Fix | Commit | What |
|-----|--------|------|
| 3 | pending | `fix(news): remove spoken source attribution from News Gemini prompt + Gate 1 QA (Fix 3)` — Added SOURCE ATTRIBUTION RULE (STRICT) block to News long-form Gemini userPrompt VALIDATION CHECKLIST (before `Target: 100-140 words` line). Changed claudeScriptQA News checklist item 10 from checking that source attribution IS present to checking that NO spoken source attribution exists (FAIL hard -25 if any found). Bobby G must never say 'According to [source]', 'Sources at [source]', or '[source] reports'. |

**Untouched:** NBA, Twitch, short-form code paths. Only `server.js` News Gemini prompt + claudeScriptQA touched.
**Next:** Continue with Fix 1+9 (clip 16:9 crop + AJ outro trim, bundled FFmpeg pass).

---

### News long-form Fix 1+9 (16:9 crop + AJ outro trim) — shipped 2026-04-13

**Handoff:** `CLINE_HANDOFF_NEWS_SMOKE_TEST_7_FIXES.md` (Fix 1 + Fix 9 of 10, bundled)
**Dispatched:** 2026-04-13 (same FFmpeg normalization pass — bundled to avoid double-touching the TS loop)
**Shipped:** 2026-04-13

| Fix | Commit | What |
|-----|--------|------|
| 1+9 | pending | `fix(news): force 16:9 aspect ratio + strip Al Jazeera red outro branding (Fix 1 + Fix 9 of 9)` — Two helper functions added before `generateNewsStoryCardPNG`: (1) `detectTrailingSilence(clipPath)` — runs FFmpeg `silencedetect=noise=-30dB:duration=1.0` on the clip, parses stderr for `silence_start` timestamp, returns the silence start time or null if no trailing silence found. (2) `computeNewsClipTrimDuration(clipPath)` — calls `detectTrailingSilence()`, falls back to `(totalDuration - 5)` if silence detected within last 5s, otherwise returns full duration. Normalization pass rewritten as async `buildTsArgs()` IIFE: for News non-avatar segments (`contentType === 'news' && !isAvatarSeg`), awaits `computeNewsClipTrimDuration(inputForTS)` and adds `-t trimDuration` to FFmpeg args before the `-vf scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080` filter (already present). `buildTsArgs().then(tsArgs => { ... }).catch(rej)` replaces the old synchronous `const tsArgs = [...]` + `execFile()` pattern. Non-News and avatar segments use the same base args without `-t`. `node -c server.js` → exit 0. |

**Untouched:** NBA, Twitch, short-form code paths. Only the TS normalization loop in `server.js` touched.
**Next:** Fix 6 — orderedClipUrls null-preserve alignment.

---


### News long-form smoke test #9 pre-flight — Fix 25a/25b/25c + Fix 28 + Fix 27b — shipped 2026-04-13

**Handoff:** `CLINE_HANDOFF_NEWS_SMOKE_TEST_9_FIXES.md`
**Dispatched:** 2026-04-13 (root cause: dashboard fetched global Al Jazeera RSS, not US/Canada video section)
**Shipped:** 2026-04-13, pending push to `origin/main`

| Fix | Commit | What |
|-----|--------|------|
| 25a | (prev session) | `feat(news): GET /news/us-canada-videos endpoint` — HTML scrapes `aljazeera.com/us-canada/`, extracts only `/video/newsfeed/` article URLs (100% video hit rate by construction). Returns `{ ok, source, lookbackHours, totalFound, recentCount, videos: [{url, href, title, thumbnail, publishedAt, dateString}] }`. Env-var override `NEWS_FEED_URL` for future RSS.app swap. |
| 25b | pending | `feat(news): dashboard switches to /news/us-canada-videos` — All 5 rss2json references in `cwn_production.html` replaced with `fetchCwnNewsVideos()` adapter function. Adapter converts new response shape to legacy rss2json item shape. `thumbLoadNewsStories()` refactored; `thumbRenderNewsStoryGrid()` extracted as separate function. `grep -n "rss2json" cwn_production.html` returns only comments — zero live URL references. |
| 25c | (prev session) | `feat(news): pre-Gate-0 hard gate NEWS_CLIP_GATE_FAIL` — blocks episode production in `server.js` News block before any Gemini/Claude/HeyGen spend if any selected story lacks a video URL. Returns `{ok:false, error:'NEWS_CLIP_GATE_FAIL', ...}` with per-story breakdown. |
| 28 | pending | `fix(assembly): filename uses actual clip count from segsToProcess` — filename generator now uses `actualClipCount = segsToProcess.filter(s => s.type === 'source_clip').length` instead of count embedded in jobTitle string. Fixes misleading `0_clips` in filenames when clips were present. |
| 27b | pending | `docs(arch): Gemini hallucination rule in GATED_PIPELINE_ARCHITECTURE.md` — added "AI Video Analysis — Known Reliability Limits" section. Documents: Gemini 2.5 Flash fabricates clip presence/timestamps when prompted with expected count (smoke test #8 evidence: 4 of 5 clips fabricated at temperature 0.1); rule: never prompt Gemini with expected clip counts; safe vs unsafe uses of Gemini video analysis; consequence: `scripts/audit_news_clips.js` deleted (commit `76779ee`). |

**Untouched:** NBA, Twitch, short-form code paths.
**Next:** Rob runs News long-form smoke test #9. Expected: dashboard now fetches only `/video/newsfeed/` articles → `orderedClipUrls` populated with real Brightcove HLS URLs → assembled video shows `N_avatar_M_clips` with M > 0. Pre-Gate-0 hard gate blocks any run where selected stories lack video before HeyGen spend.

---

## Rotation log

| Date | Event |
|------|-------|
| 2026-04-12 | Doc created. Seeded from last night's News long-form runs (2× `0_clips` Gate 3 passes) and NBA Gate 1 failure. Ship order: News first, NBA second. |
| 2026-04-12 | News batch 1 dispatched as `CLINE_HANDOFF_NEWS_LONGFORM_FIXES.md` (4 fixes). |
| 2026-04-12 | News batch 1 shipped — 4 commits `e17e647`, `eb67b0e`, `9271297`, `ca56ccb` pushed to `origin/main`. Awaiting Rob's smoke test. |
| 2026-04-12 | Appended 3 new items to `🔴 To Fix`: Twitch reaction/CTA split (reopened), cross-cutting intro card duration per type (10/8/12), cross-cutting outro freeze-hold. |
| 2026-04-12 | News smoke test #1 ran end-to-end — Gate 1 100/100, Gate 2 80/100 MANUAL, Gate 3 90/100 PASS, Drive + Upload-Post published to YouTube private draft. Rob QA in YouTube Studio: no news clips (expected — root cause is News has no video source), no TV card (real bug — Fix 5 root-caused to broken `/newscast-overlay` route HTTP 500 from stale `server.js:1300` path), logo + ticker visible, outro clean (Gate 3 LATE-sample OUTRO false positive on a clean outro — known scoring bug, parked as cross-cutting). Fix 5 dispatched as News batch 2 one-line fix. |
| 2026-04-12 | News batch 2 shipped — Fix 5 `fix(news): /newscast-overlay route path — tools/ prefix missing (server.js:1300)` pushed to `origin/main`. Verified HTTP:200 SIZE:15964 before commit. Awaiting Rob's smoke test #2 to confirm newscast overlay visible in assembled video. |
| 2026-04-12 | News batch 3 dispatched as `CLINE_HANDOFF_NEWS_LONGFORM_FIXES_BATCH3.md` — Fix 6 News Gemini prompt rewrite (INTRO/SETUP repetition + CLIP_REACTION→SUMMARY rename) before running smoke test #2, so script flow issue and newscast overlay fix validate together in one run. |
| 2026-04-12 | News smoke test #3 (post-Fix 5 + Fix 6) — Gate 1 100/100, Gate 2 80/100 MANUAL, Gate 3 90/100 PASS (same score as test #1 — TV CARD check still failing Fix 3's informational criterion because the newscast overlay was STILL invisible in the final MP4). Rob QA in YouTube Studio: script flow confirmed much better (no more INTRO/SETUP repetition — Fix 6 verified clean), ticker + logo visible, but the newscast chrome layer (story list, lower-third, top bar, segment tag) was still NOT visible in the video. Root-caused via local preview experiment: (a) Puppeteer `page.screenshot()` without `omitBackground:true` composites `body{background:transparent}` against a white canvas producing rgb24 PNGs with YAVG~213, (b) FFmpeg `blend=all_mode=normal:all_opacity=1` does not composite alpha correctly for RGBA input (`overlay` filter is the correct primitive). Both bugs had been masking each other across Apr 7-12. |
| 2026-04-12 evening | Extended design conversation — Rob progressively specified the final newscast chrome design via iterative preview composites in `/tmp/`. Locked: sidebar always-on from frame 0; TV card time-gated on `CONFIG.INTRO_CARD.DURATION_SECONDS` at each STORY#_INTRO; story 1 pre-highlighted on cold open; last story highlighted through outro; TV card hidden during cold open + outro; logo moved from top-left to on-the-mug at `{x:1725, y:910, size:90, opacity:0.85}` (News-specific override); top bar renamed to "BECAUSE THE LIGHT WAS ON | Episode N"; lower-third moved top-left 720px wide; breaking flag removed; internal duplicate ticker removed; story list 420px with uniform 90px min-height items; segment-tag seg-name updates per active story category. Final 4-layer composite at `/tmp/newscast_FINAL_with_ticker.jpg` approved. |
| 2026-04-12 evening | News batch 3 Fix 7 dispatched as `CLINE_HANDOFF_NEWS_LONGFORM_FIXES_BATCH3_FIX7.md`. Covers template rewrite + server.js state machine + lib/config.js LOGO_POS_NEWS. Single commit. Rob's rebrand-to-Twitch/NBA directive parked in ROADMAP.md as post-test Could-Have. |
| 2026-04-12 late evening | News smoke test #4 (post-Fix 7) — Gate 3 97/100 (up from 90), TV CARD check PASSED for first time (Gemini saw gold-bordered graphics in frame), newscast chrome visibly rendering in the assembled MP4 with logo on mug, sidebar, top bar, lower-third headline, top-right segment-tag all present. Rob QA feedback: "news overlay is good and working as we designed it, logo is good, ticker still good, so just video clips not present and no tv card." Root cause of "no tv card" surfaced via code audit: the cross-content top-right OVERLAY_ZONE TV card (which Twitch and NBA both have) was never wired up for News. Archived handoff `CLINE_HANDOFF_TWITCH_INTRO_CARD_TO_TV_DESIGN.md` line 57 asserted it was already working but grep verification against current code shows zero matches for `generateNewsStoryCardPNG` or equivalent. Separately confirmed via live curl against Al Jazeera RSS + article HTML: no video enclosures or embedded video tags exist in Al Jazeera content, meaning genuine video clips cannot be scraped from the locked source. og:image scraping IS viable — every tested article has `<meta property="og:image">` present with valid full-res URL. |
| 2026-04-12 late evening | News Fix 8B dispatched as `CLINE_HANDOFF_NEWS_LONGFORM_FIX_8B.md` — build the News TV card code that was documented but never implemented. Scrape og:image per story at script-gen time, persist as `heroImageUrl`, new Canvas function `generateNewsStoryCardPNG()` matching Twitch/NBA 2×-resolution pattern, second FFmpeg overlay burn at OVERLAY_ZONE inside the Fix 7 `isStoryIntro` block after the chrome burn completes. Single commit. No new dependencies (axios + cheerio already in package.json). |
| 2026-04-12 | News batch 3 shipped — Fix 6 `fix(news): rewrite Gemini prompt to eliminate INTRO/SETUP repetition (server.js:6685-6737)` committed `9a4fcc6` and pushed to `origin/main`. Grep verified: 0 CLIP_REACTION hits in News prompt block; STORY#_SUMMARY + 100-140 word count confirmed at lines 6696, 6717, 6731, 6737. Awaiting Rob's smoke test #3. |
| 2026-04-13 | Fix 5 (smoke test #8 batch) — sidebar 5-cap + mutual exclusion + flag persistence — committed `d218ebe` and pushed to `origin/main`. Three sub-fixes: (5a) CSS `nth-child(n+6)` caps sidebar at 5 cards; (5b) `body.sidebar-hidden` mutual exclusion hides sidebar when flag+TV card active; (5c) state machine split into `isStoryIntro`/`isStoryBody`/default branches so flag persists across SETUP/SUMMARY/REACTION scenes. **⚠️ Fix 2 parking note:** Bobby G double-pronunciation of story headlines observed in smoke test #7 — Bobby G reads the headline in STORY#_INTRO, then the STORY#_SETUP scene opens with the same headline restated. Root cause: Gemini prompt SETUP rule says "1 new fact or hook" but Gemini occasionally opens SETUP with a restatement of the INTRO headline before adding the new fact. Not a code fix — a prompt tightening. Parked here for post-smoke-test-#8 assessment: if still present after Fix 6 (SETUP rewrite) has had a full clean run, add a Gate 1 QA check that fires -10 if SETUP scene text contains >50% word overlap with the preceding INTRO scene text. |
| 2026-04-13 | Smoke test #9 pre-flight: Fix 25a/25b/25c + Fix 28 + Fix 27b shipped. Root cause of all News 0-clip runs identified: dashboard was fetching global Al Jazeera RSS (all.xml via rss2json, ~20-30% video hit rate) instead of US/Canada HTML section (/video/newsfeed/ paths, 100% video by construction). All 5 fixes shipped this session. Awaiting Rob's smoke test #9. |
| 2026-04-13 | Track A (smoke test #10 pre-flight): Fix A1 + Fix A2 shipped. Fix A1: `server.js` line ~4377 — swapped `force_original_aspect_ratio=increase,crop=1920:1080` → `force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x0d1424` (CWN dark navy letterbox). Fixes faces cropped chin-to-tie on Al Jazeera broadcast video. Fix A2: `NEWS_CLIP_MAX_SECONDS=25` hard cap — `buildTsArgs()` async IIFE runs silencedetect then takes `min(silencedetect, 25)`. Fixes 50-123s full news packages playing uncut. Lines 3800/3834 (short-form split-screen) untouched. `node -c server.js` → exit 0. Awaiting Rob's smoke test #10. |
| 2026-04-13 | Track C (smoke test #10 pre-flight): Per-video validation pass + dashboard badges shipped. Extended GET /news/us-canada-videos with validateVideo(v) async function — 5 checks in parallel: (1) Brightcove URL HEAD 3s timeout, (2) yt-dlp --skip-download --dump-json 10s timeout, (3) dimensions >= 1280x720, (4) duration > 5s (warning if > 120s), (5) og:image HEAD 3s timeout. Each video gets validation: { status, checks, issues[] }. Response includes validationSummary: { passed, warnings, failed }. Validation skippable via ?validate=false. Dashboard: fetchCwnNewsVideos() preserves validation per item + validationSummary on response. thumbRenderNewsStoryGrid() shows summary bar (green/amber/red dot counts) + per-card badge dots + fail cards dimmed 60% opacity + pointer-events:none + UNUSABLE label. node -c server.js exit 0. Awaiting Rob's smoke test #10. |

### News long-form Red 2 (Al Jazeera watermark mask) — shipped 2026-04-13

**Handoff:** `CLINE_HANDOFF_NEWS_FULL_FIX_BEFORE_TEST_10.md` (Red 2 of 4)
**Dispatched:** 2026-04-13 (Rob directive: ship all 4 reds before test #10 fires)
**Shipped:** 2026-04-13, 1 commit pending push to `origin/main`

| Fix | Commit | What |
|-----|--------|------|
| Red 2 | pending | `feat(news): mask Al Jazeera corner watermark with CWN navy box` — Appended `,drawbox=x=1780:y=960:w=120:h=80:color=0x0d1424@1.0:t=fill` to the non-avatar vfFilter chain in the News source_clip normalization pass (`server.js` ~line 4376). Condition: `contentType === 'news' && !isAvatarSeg`. Covers Al Jazeera bottom-right corner watermark (logo + 20px safety padding) with CWN navy `#0d1424` — matches letterbox bar color so it reads as intentional CWN framing. `node -c server.js` → exit 0. |

**Untouched:** NBA, Twitch, short-form code paths. Only the vfFilter string in the News source_clip normalization pass touched.
**Next:** Red 3 — clip intro skip via `-ss 5` before `-i` for News source_clip segments (effective clip window 5s-30s of source).

### News long-form Red 3 (Al Jazeera intro card skip) — shipped 2026-04-13

**Handoff:** `CLINE_HANDOFF_NEWS_FULL_FIX_BEFORE_TEST_10.md` (Red 3 of 4)
**Dispatched:** 2026-04-13 (Rob directive: ship all 4 reds before test #10 fires)
**Shipped:** 2026-04-13, 1 commit pending push to `origin/main`

| Fix | Commit | What |
|-----|--------|------|
| Red 3 | pending | `feat(news): skip Al Jazeera intro branding cards with -ss 5 fast-seek` — Added `NEWS_CLIP_INTRO_SKIP = 5` constant and prepended `-ss 5` BEFORE `-i` in FFmpeg args for News source_clip segments in `buildTsArgs()` (`server.js` ~line 4401). Fast-seek mode (keyframe-accurate, no decode overhead). Effective clip window: 5s-30s of source (25s cap still applies after offset). Condition: `contentType === 'news' && !isAvatarSeg`. `node -c server.js` → exit 0. |

**Untouched:** NBA, Twitch, short-form code paths. Only the `buildTsArgs()` return path for News source_clip segments touched.
**Next:** Red 4 — proactive chrome directive architecture (full rewrite: lib/chromeDirectives.js Zod schema, News Gemini prompt JSON output, Gate 1 QA JSON validation, assembly chrome burn rewrite, feature flag USE_DIRECTIVE_CHROME).
