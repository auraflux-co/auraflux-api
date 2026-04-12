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

*(empty — all dispatched items shipped)*

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

**Handoff:** `CLINE_HANDOFF_NEWS_LONGFORM_FIXES_BATCH3.md`
**Dispatched:** 2026-04-12 (post-smoke-test-1 script review)
**Shipped:** 2026-04-12, 1 commit pushed to `origin/main`

| Fix | Commit | What |
|-----|--------|------|
| 6 | `9a4fcc6` | `fix(news): rewrite Gemini prompt to eliminate INTRO/SETUP repetition (server.js:6685-6737)` — SETUP rewritten to EXACTLY 1 sentence (new fact or hook, not a restatement of INTRO); CLIP_REACTION renamed to SUMMARY (1-2 sentences factual recap of what just played, no opinions/reactions/quips); REACTION tightened to deadpan take only (must not recap — that's SUMMARY's job); word count target 80-120 → 100-140 per story; Gate 1 QA comment + sceneHeaders push updated to STORY1_SUMMARY. Scene count unchanged (42 for 10 stories). No downstream code changes. |

**Untouched:** NBA, Twitch, short-form code paths.
**Next:** Rob runs News long-form smoke test #3. Expected: no INTRO/SETUP repetition, structurally distinct 4-beat story flow (INTRO/SETUP/SUMMARY/REACTION).

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
| 2026-04-12 | News batch 3 shipped — Fix 6 `fix(news): rewrite Gemini prompt to eliminate INTRO/SETUP repetition (server.js:6685-6737)` committed `9a4fcc6` and pushed to `origin/main`. Grep verified: 0 CLIP_REACTION hits in News prompt block; STORY#_SUMMARY + 100-140 word count confirmed at lines 6696, 6717, 6731, 6737. Awaiting Rob's smoke test #3. |
