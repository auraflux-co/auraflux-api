# CWN Production — Status & Task Tracker

**Last Updated:** 2026-04-11 (7:30 AM ET — morning)
**Branch:** main | **Latest Commit:** `a1439b6` — Cline shipped **Phase 1 Gate 2** (parseSegments_v2 + gate2_validateSegmentStructure + fix loop). **Smoke test ready to re-run** — see `OVERNIGHT_STATUS.md` morning checklist. Task #14 handoff (Gemini clip analysis truncation fix) pending for ship.
**🚨 NEW ARCHITECTURE DOC:** Every agent must read `GATED_PIPELINE_ARCHITECTURE.md` at the start of every session. It supersedes the ad-hoc retry logic patchwork and defines 9 principles + 7 gates + Gate Output Contract + collaborative QA dialogue pattern.
**How to start a session:** Tell Cline: _"Read CLAUDE.md and STATUS.md and tell me what we're working on"_
**Every morning:** `cat MORNING_BRIEFING.md` — see what Aider did overnight before touching anything

---

## 🗂️ Agent Assignments

| Agent | Role | Best For |
|-------|------|----------|
| **Claude Code** | Creative Director + Architect | HTML template design, brand decisions, spec writing |
| **Cline** | Implementation Lead | server.js edits, API integration, pipeline wiring |
| **Aider** | Surgical Coder | Text generation logic, prompt engineering, keyword detection |

---

## 🤖 Last Agent Action

> **Every agent must update this table before committing code. The pre-commit hook will block commits that skip this.**

| Agent | Task Completed | Files Changed | Commit | Timestamp |
|-------|---------------|---------------|--------|-----------|
| Cline | Added pre-commit hook + STATUS enforcement | `.git/hooks/pre-commit`, `STATUS.md`, `COMMIT_CHECKLIST.md`, `CLAUDE.md` | `a7b6698` | 2026-04-09 7:00 PM ET |
| Claude Code | Newscast UI updates + NBA intro card handoff + Upload API spec | `tools/clipzworld_newscast.html`, `POST_PUBLISH_MANUAL_CHECKLIST.md`, `CLINE_HANDOFF_NBA_INTRO_CARD.md`, `UPLOAD_API_SPEC.md`, `data/upload_status.json` | `b3fcdff` | 2026-04-09 (earlier today) |
| Cline | Phase 1-6 acceptance test plan + rollback process | `test/PHASE_1_6_ACCEPTANCE_TEST.md`, `STATUS.md` | `787f81f` | 2026-04-09 7:26 PM ET |
| Cline | Fix TV card overlay position: OVERLAY_ZONE + 2 hardcoded FFmpeg overlays → x=40 (top-left, facing Bobby G) | `server.js` | `787f81f` | 2026-04-09 7:37 PM ET |
| Cline | Module split Phase 1: extract lib/config.js, lib/logger.js, lib/metrics.js from server.js; remove inline duplicates; server verified clean | `lib/config.js`, `lib/logger.js`, `lib/metrics.js`, `server.js`, `SERVER_SPLIT_PLAN.md` | `787f81f` | 2026-04-09 11:30 PM ET |
| Cline | Upgrade pre-commit hook: add soft-warn for stale .md docs; update COMMIT_CHECKLIST + CLAUDE.md with doc-update rule | `scripts/pre-commit.sh`, `COMMIT_CHECKLIST.md`, `CLAUDE.md` | `d0ae35a` | 2026-04-09 11:35 PM ET |
| Cline | Add git push step to COMMIT_CHECKLIST.md | `COMMIT_CHECKLIST.md` | `b719c51` | 2026-04-09 11:39 PM ET |
| Cline | Add overnight automation: scripts/overnight_runner.sh + launchd plist (1am daily cron) | `scripts/overnight_runner.sh`, `scripts/com.cwn.overnight.plist`, `OVERNIGHT_TASKS.md` | `2563326` | 2026-04-09 11:43 PM ET |
| Cline | Add aider_plan.sh — one-shot full environment audit + multi-week plan generator | `scripts/aider_plan.sh` | `484248f` | 2026-04-09 11:44 PM ET |
| Cline | Fix news long-form post-reaction pause: 5 seconds → 3 seconds (server.js lines 5951, 5961, 5963) | `server.js` | `e9ae7f7` | 2026-04-09 11:47 PM ET |
| Cline | Fix overnight_runner.sh: add STATUS.md, OVERNIGHT_TASKS.md, MORNING_BRIEFING.md to Aider chat | `scripts/overnight_runner.sh`, `STATUS.md` | `afc0e7c` | 2026-04-10 8:52 AM ET |
| Claude Code | Config updates: Aider → Gemini 2.5 Pro (avoid TPM limit), remove hardcoded API key, Emily active, dashboard clips/streamer default 3→2 | `.aider.conf.yml`, `data/streamers.json`, `cwn_production.html`, `STATUS.md` | `e269afc` | 2026-04-10 9:15 AM ET |
| Cline | Add 🔄 REFRESH IDs button to dashboard job cards + refreshHeyGenIds() JS function; calls GET /heygen/latest-videos, matches by jobId_ prefix, updates segment URLs for Avatar V workaround | `cwn_production.html`, `server.js` | `ef5486a` | 2026-04-10 11:40 AM ET |
| Cline | Fix sendToHeyGen() title format: now sets HeyGen video title as `batchId_XX_SCENENAME` so REFRESH IDs can match by index and preserve segment order | `cwn_production.html` | `16ce6fe` | 2026-04-10 12:37 PM ET |
| Cline | Fix #1 Twitch clip mismatch (Gate 1 85/100): analyses mapped by streamer name (analysesByStreamer), items[].clips updated to match analysisClips order, generateClipAvailabilityReport() added | `server.js` | `3b5e9d0` | 2026-04-10 12:57 PM ET |
| Cline | Fix #2 clip report wiring: clipReportDataForQA declared + assigned inside twitch block; passed to both claudeScriptQA call sites (initial QA + post-claudeScriptFix QA) | `server.js` | `3b5e9d0` | 2026-04-10 2:09 PM ET |
| Cline | Add Node.js restart step to COMMIT_CHECKLIST.md (after push section) | `COMMIT_CHECKLIST.md` | `5e8a13c` | 2026-04-10 2:23 PM ET |
| Cline | Fix #3 ROOT CAUSE: claudeScriptQA() received 2D clipAnalyses array for Twitch; flatAnalyses() now iterates streamer×clip so attribution is always correct; NBA/News flat arrays unchanged | `server.js` | `64c2f70` | 2026-04-10 4:54 PM ET |
| Cline | Fix #4: Filter streamers with no real clip analyses before Gemini prompt — prevents hallucination for 0-clip streamers (only include streamers with ≥1 analysis > 50 chars) | `server.js` | `b5cac55` | 2026-04-10 5:13 PM ET |
| Cline | Fix #5: Explicit scene→clip mapping in Gemini prompt — each clip block now labels which SETUP/REACTION scenes it feeds, preventing Gemini from swapping clip 1 and clip 2 analyses | `server.js` | `84a780c` | 2026-04-10 5:28 PM ET |
| Cline | Fix #6A-E: Real video clip filtering (isVideoAnalyzed flag), dynamic report numbers, explicit CLIP ORDER swap in claudeScriptFix | `server.js`, `STATUS.md` | `67527e5` | 2026-04-10 5:47 PM ET |
| Cline | Add job persistence: persistedJobs loaded from data/jobs.json on startup, saveJobCard() writes to disk with 7-day pruning, GET /jobs endpoint for dashboard recovery after server restart | `server.js`, `STATUS.md` | `33a8800` | 2026-04-10 8:11 PM ET |
| Cline | Fix ASSEMBLE button missing after page refresh: add restoreJobsFromServer() + ↩ RESTORE JOBS button + auto-call on init (1.5s delay); reconstructs segments from server's persisted job cards so REFRESH IDs → ASSEMBLE flow works after any page reload | `cwn_production.html`, `STATUS.md` | `cfe2200` | 2026-04-10 9:30 PM ET |
| Cline | Add pipeline rollback + force-advance: POST /job/:id/rollback + POST /job/:id/advance + detectStage() in server.js; ↩ ROLLBACK + ⏭ FORCE ADVANCE buttons on every job card; rollbackJob() + advanceJob() JS functions call server then refresh queue | `server.js`, `cwn_production.html`, `STATUS.md` | `eac1073` | 2026-04-10 9:36 PM ET |
| Cline | Fix rollback/advance key mismatch: all 6 JSON responses now use `before`/`after` keys (dashboard JS reads resp.before/resp.after); 4 responses were incorrectly using `from`/`to` | `server.js` | `472718f` | 2026-04-10 9:41 PM ET |
| Cline | **Planned:** fix generateVideo() missing title (add `title: title \|\| undefined` to HeyGen API payload so REFRESH IDs can match videos by `batchId_XX_SCENENAME` prefix). **⚠️ NOT YET COMMITTED** — change is unstaged in `cwn_production.html`. The message on commit `6ce68c4` claims this fix but `git show 6ce68c4 --stat` shows zero HTML changes; see next row for what `6ce68c4` actually contains. | `cwn_production.html` (unstaged) | — | 2026-04-10 9:48 PM ET |
| Claude Code | Docs sync (committed as `6ce68c4` with misleading message due to concurrent-commit collision with Cline): wrote ROLLBACK_FORCE_ADVANCE_SPEC.md documenting shipped rollback/advance feature (stage machine, endpoint contracts, test checklist, open questions); added Job Persistence + Pipeline Controls + Zoom-to-Fill sections to CLAUDE.md; added `data/jobs.json` to .gitignore; archived two stale CLINE_HANDOFF_CLIP_MISMATCH_*.md to `docs/archive/`; deleted empty `scripts/trigger_assemble.js`; added `scripts/claude_consult.sh` (peer-agent tool). Added Tech Debt #5 (rollback/advance audit trail follow-up). | `ROLLBACK_FORCE_ADVANCE_SPEC.md`, `CLAUDE.md`, `.gitignore`, `STATUS.md`, `docs/archive/CLINE_HANDOFF_CLIP_MISMATCH_BUG.md`, `docs/archive/CLINE_HANDOFF_CLIP_MISMATCH_FIX_V2.md`, `scripts/claude_consult.sh` | `6ce68c4` (content) / see note | 2026-04-10 10:15 PM ET |
| Claude Code | Clarify commit history: commit `6ce68c4` message says "pass title to HeyGen API in generateVideo()" but actually contains Claude Code's docs-sync work (6 docs files, 0 lines of HTML). Concurrent commit activity mislabeled the commit. The real generateVideo() title fix is still unstaged in cwn_production.html (see row above). This STATUS entry exists so future agents reading git log aren't confused — the content is correct, only the message is wrong. | `STATUS.md` | `54650ed` | 2026-04-10 10:30 PM ET |
| Claude Code | Add Atomic Staging rule to COMMIT_CHECKLIST.md after concurrent-commit incident: documents the git-index race condition between multiple agents, the `git add && git commit` atomic pattern, practical guidance (chain with `&&`, explicit file lists, check reflog after committing), and a postmortem of the 2026-04-10 incident so future agents don't repeat it | `COMMIT_CHECKLIST.md`, `STATUS.md` | `54650ed` | 2026-04-10 10:45 PM ET |
| Cline | Fix REFRESH IDs for pre-title-format jobs: add `POST /heygen/video-urls` endpoint to server.js (batch video_id → URL lookup via HeyGen v1/video_status.get); add direct video_id fallback to `refreshHeyGenIds()` in dashboard — when prefix match returns 0, checks segments with videoId but no url, calls new endpoint, updates segment URLs + status. Fixes job `script_twitch_1775866928172` (sent before title fix) | `server.js`, `cwn_production.html`, `STATUS.md` | `12863ef` | 2026-04-10 10:00 PM ET |
| Claude Code | Document Upload-Post publish-time privacy policy in ROLLBACK_FORCE_ADVANCE_SPEC.md: new "Publish-Time Privacy (Rollback's Last Line of Defense)" section covering YT `private` / TikTok `SELF_ONLY` / IG account-wide private; Upload-Post API research (no IG draft flag, only `share_mode` with Trial Reels variants); current policy = IG account-wide private until 10 Reels shipped; exit criteria + Trial Reels API test curl; added Tech Debt #6 linking to the spec | `ROLLBACK_FORCE_ADVANCE_SPEC.md`, `STATUS.md` | pending | 2026-04-10 11:10 PM ET |
| Claude Code | Full diagnostic investigation + Cline handoff for broken Apr 10 Twitch long-form MP4: extracted 10+ frames across 5 reference videos (Apr 4-10) pinpointing pillarbox regression to Apr 10; downloaded raw HeyGen segment via API and ffprobe-verified 1920×1080 container with baked-in portrait pillarbox (HeyGen Avatar V glitch confirmed); root-caused "Error response" ticker bug to commit `b31533f` moving ticker HTMLs to `tools/` without updating `TICKER_MAP`; Rob identified new landscape-native 4K avatar `842f20b75ce242aea397f5030aa018aa`; wrote `CLINE_HANDOFF_AVATAR_AND_TICKER_FIX.md` with exact diffs for 4 fixes (avatar swap, OVERLAY_ZONE flip to top-right `x=1240`, LOGO_POS flip to top-left `x=20` to avoid collision, ticker `tools/` path fix); wrote `FUTURE_4K_MIGRATION_PLAN.md` parking doc for eventual 4K canvas migration (recommendation: stay at 1080p, benefit from supersampling); added corrections header to `CLAUDE_DIAGNOSIS_BROKEN_TWITCH_LONGFORM.md`. Cline owns all code edits; Claude Code wrote docs only. | `CLINE_HANDOFF_AVATAR_AND_TICKER_FIX.md`, `CLAUDE_DIAGNOSIS_BROKEN_TWITCH_LONGFORM.md`, `FUTURE_4K_MIGRATION_PLAN.md`, `STATUS.md` | pending | 2026-04-11 12:30 AM ET |
| Cline | **Avatar swap + overlay flip + ticker path fix (atomic):** swap portrait avatar `1a5d4e9130d2467fa01d9e1580aff829` → landscape-native 4K avatar `842f20b75ce242aea397f5030aa018aa` in `.env`, `cwn_production.html` (2 locations), `lib/config.js`; flip OVERLAY_ZONE x=40→x=1240 (TV card top-right, Bobby G faces viewer's left); flip LOGO_POS x=1780→x=20 (logo top-left to avoid collision); update 2 FFmpeg overlay burns in `server.js` (x=1240:y=40); update 2 logo overlay burns (overlay=20:20); fix TICKER_MAP paths: add `tools/` prefix to all 3 ticker HTML paths (broken since commit b31533f moved files without updating map); clean cached ticker MP4s + frames | `.env`, `cwn_production.html`, `lib/config.js`, `server.js`, `STATUS.md`, `CLAUDE.md` | `0d13fb0` | 2026-04-11 1:06 AM ET |
| Claude Code | **🚨 GATED SELF-HEALING PIPELINE ARCHITECTURE:** Wrote 3 foundational docs after Rob articulated 9 principles for autonomous pipeline fix loops. (1) `GATED_PIPELINE_ARCHITECTURE.md` — 900+ line authoritative spec: 9 principles (every gate has QA agent, programmatic fix path, no arbitrary retry limits, QA has authoritative decision power, every fix documented, specific diagnostics, collaborative QA dialogue), 7 stages with 7 gates (Gate 1 Claude + Gates 2-6 Gemini + Gate 7 Rob platform review), Gate Output Contract JSON schema, retry dialogue loop, save point strategy, loop detection, learning records (`gate_fixes.jsonl` + daily markdown), migration plan (Phases 1-8), rules of engagement for all agents. (2) `CLINE_HANDOFF_GATE2_SEGMENT_STRUCTURE.md` — 1200+ line ship-tonight Phase 1 handoff: root-cause analysis of parseSegments_v1 over-splitting CLIP_SETUP sections into 3 sub-segments (zombie fragments + duplicated labels), complete parseSegments_v2 single-segment-per-section implementation, A/B switch via `USE_PARSE_SEGMENTS_V2` flag, Gate 2 pure-code validator (6 checks: count/order/duplicates/empty/clip-url/clip-count), dialogue-based fix loop (`handleGate2Failure`), `POST /gate-fix-log` endpoint, dashboard UI spec. (3) `CLINE_HANDOFF_GATE1_CLIP_DIAGNOSTIC_UPGRADE.md` — Phase 2 handoff: upgrade Gate 1 clip availability report from generic "not in this episode" to 9 specific failure modes (TWITCH_API_EMPTY, STREAMER_NOT_FOUND, GQL_RESOLUTION_FAILED, CDN_DOWNLOAD_BLOCKED, GEMINI_ANALYSIS_TRUNCATED, etc.) each with cause + evidence + fix suggestion. Cline owns all code; Claude Code wrote docs only. | `GATED_PIPELINE_ARCHITECTURE.md`, `CLINE_HANDOFF_GATE2_SEGMENT_STRUCTURE.md`, `CLINE_HANDOFF_GATE1_CLIP_DIAGNOSTIC_UPGRADE.md`, `STATUS.md` | pending | 2026-04-11 3:15 AM ET |
| Cline | Phase 1 Gate 2: `parseSegments_v2` (A/B flag `USE_PARSE_SEGMENTS_V2`) + `gate2_validateSegmentStructure()` (6 checks: segment_count_mismatch, clip_count_mismatch, duplicate_labels, empty_avatar_segment, missing_clip_url, segment_order_mismatch) wired into `sendToHeyGen()` before confirm(); `handleGate2Failure()` fix loop + `displayGate2Pass()` UI; `POST /gate-fix-log` endpoint appends to `logs/gate_fixes.jsonl` | `cwn_production.html`, `server.js`, `STATUS.md` | `a1439b6` | 2026-04-11 2:47 AM ET |
| Claude Code | Wrote `CLINE_HANDOFF_GEMINI_CLIP_ANALYSIS_TRUNCATION_FIX.md` — surgical fix for Task #14: Gemini clip analysis truncation in `geminiAnalyzeClip()` at `server.js:5745` where `maxOutputTokens=500` cuts off the 4-section structured response, producing truncated output like `"Here's an analysis of the Twitch clip: 1. **Visually happening:**"` that causes Gate 1 CLIP MATCH to deduct 15 points (85/100, hard fail after 3 retries). Handoff includes: root-cause analysis with evidence from `output/qa_failures/gate1_script_fail_1775886258810.txt`, exact diffs for 4 changes (raise token cap 500→1500 + add finishReason detection + thumbnail fallback 200→500 + optional thumbnail finishReason mirror), test plan, rollback plan, teaching section on why 1500 is the right number, relationship to Phase 2 Gate 1 diagnostic upgrade handoff, commit message template, Cline checklist. ~30 min Cline work expected. Unblocks Gate 1 auto-pass on smoke tests (currently requires FORCE ADVANCE workaround). Prerequisite for the full Gate 1 diagnostic upgrade Phase 2 handoff to ship cleanly. | `CLINE_HANDOFF_GEMINI_CLIP_ANALYSIS_TRUNCATION_FIX.md`, `STATUS.md` | pending | 2026-04-11 7:30 AM ET |

---

## 📊 Phase Progress

| Phase | Owner | Status | Commit |
|-------|-------|--------|--------|
| Phase 1: Thumbnail Updates | Claude Code | ✅ COMPLETE | `767aecf` |
| Phase 2: Short-Form Infrastructure | Cline | ✅ COMPLETE | `88e20eb` |
| Phase 3: Caption & Prioritization | Aider | ✅ COMPLETE | `186ea3d` |
| Phase 4: Operations Fixes | Cline | ✅ COMPLETE | `9fa9340` |
| Phase 5: Creative Layer | Claude Code + Rob | ✅ COMPLETE | `b3fcdff` |
| Phase 6: Publish Integration | Cline | 🟡 In Progress — ready to test | — |

---

## ✅ What's Working (Full System)

- **Full pipeline:** Script Gen → Gate 1 → HeyGen → Gate 2 → Assembly → Gate 3 → Drive Upload → Publish
- **All 3 content types:** Twitch, NBA, News (long-form + short-form)
- **Scene headers:** spaces → underscores (no more broken Gemini parsing)
- **Multi-platform publish:** YouTube, TikTok, Instagram via Upload-Post API (`server.js:6782`)
- **Short-form captions:** `generateShortFormCaption()` — 90-150 char + hashtags + altText
- **News prioritization:** `prioritizeNewsStories()` — 18 urgency keywords, score-sorted
- **Thumbnails:** FFmpeg-based for all 3 content types, episode auto-increment — tagline "BECAUSE THE LIGHT WAS ON" ✅
- **NBA intro card:** `/nba/generate-intro-card` — Puppeteer → 640×360 PNG (`server.js:9800`) ✅
- **News intro card:** `/news/generate-intro-card` — OG image scraper → 640×360 (`server.js:4615`) ✅
- **TV card position:** All 3 overlay positions (OVERLAY_ZONE + 2 FFmpeg burns) → `x=1240` top-right (Bobby G faces viewer's left; logo moved to top-left `20:20` to avoid collision) ✅
- **Split-screen short-form:** `/capcut/split-screen` + `assembleShortForm()` — 9:16 portrait (`server.js:8358`) ✅
- **CapCut routes:** `/capcut/init`, `/capcut/add-segment`, `/capcut/ticker`, `/capcut/logo`, `/capcut/finalize`
- **Safety zone check:** TikTok + Reels AABB+circle overlap validation
- **Gate 3/6 approval flow:** Human checkpoint → approve → auto-publish with status polling
- **Disk usage + cleanup:** `GET /disk-usage`, `POST /cleanup`
- **VectCutClient:** `assembleShortForm()`, `addBrandedOverlay()`, `healthCheck()`
- **Upload status tracking:** `GET /upload-status/:trackingId` + `data/upload_status.json`
- **Avatar V hybrid workflow:** 🔄 REFRESH IDs button in dashboard syncs manually-upgraded HeyGen videos (`GET /heygen/latest-videos`) ✅

---

## 🎬 Avatar V Production Workflow (Current Standard)

> HeyGen Avatar V is **web-console only** — no API access yet. Use this hybrid workflow for all productions until the API is released.

### Step-by-step

| Step | Where | Action | Automated? |
|------|-------|--------|-----------|
| 1 | CWN Dashboard | Generate script → click **SEND TO HEYGEN** | ✅ Auto |
| 2 | HeyGen web UI | Wait for all segments to finish rendering (green ✓) | 👤 Manual wait |
| 3 | HeyGen web UI | For each segment: click **Regenerate** → switch to **Avatar V** → confirm. Repeat for all segments | 👤 Manual |
| 4 | CWN Dashboard | Click **🔄 REFRESH IDs** on the job card | 👤 One click |
| 5 | CWN Dashboard | Click **⚙ ASSEMBLE** | 👤 One click |
| 6 | Background | FFmpeg downloads all segments, stitches, adds ticker/logo/overlays | ✅ Auto |
| 7 | Background | Gate 5: Gemini visual QA on assembled video | ✅ Auto |
| 8 | CWN Dashboard | Gate 3: Review Gate 5 score → click **✅ APPROVE & UPLOAD →** | 👤 One click |
| 9 | Background | Upload-Post publishes to YouTube + TikTok + Instagram as **private drafts** | ✅ Auto |
| 10 | YouTube / TikTok / IG | Review private video → flip to **public** when ready | 👤 Manual |

### Notes
- **REFRESH IDs** matches by title prefix `jobId_XX_SCENENAME` — only works for jobs sent after Apr 10 2026 (when title format was added to `sendScriptToHeyGen()`)
- Older jobs without titles: paste URLs manually into segment fields, or re-send
- When Avatar V API launches: swap `HEYGEN_AVATAR_ID` in `.env` — zero code changes needed
- HeyGen queue cleanup: use the node script in session history to delete all but last N videos

---

## 🟡 Phase 6 — Publish Integration (Active)

**`UPLOADPOST_API_KEY` ✅ confirmed in `.env` — ready to test**

> ⚠️ **Avatar V Status:** API/MCP access coming "in the coming months" per HeyGen support (no ETA). **Hybrid workaround now available:** Generate with Avatar IV via API → manually upgrade to Avatar V in HeyGen web console → click 🔄 REFRESH IDs button in dashboard to sync upgraded URLs → continue automated pipeline (ASSEMBLE → Gate 3 → Publish). Phase 6 testing can proceed with this workflow.

| Task | Status | Notes |
|------|--------|-------|
| `UPLOADPOST_API_KEY` in `.env` | ✅ Done | JWT token confirmed present |
| HeyGen Avatar V access | 🟡 Waiting | API not yet available — when ready, just swap `HEYGEN_AVATAR_ID` + `HEYGEN_AVATAR_SHORT_ID` in `.env` (zero code changes) |
| Test Case #1: Twitch Long → YouTube Private | 🟡 Ready to run | Spec in `UPLOAD_API_SPEC.md` — Avatar IV works fine, no need to wait for V |
| Test Case #2-5: Multi-platform | ⏳ After Test #1 passes | TikTok + Instagram + simultaneous |
| Approve overnight queue (Aider) | ⏳ Waiting on Rob | See `OVERNIGHT_TASKS.md` |
| Push commits to origin/main | ✅ Done | Pushed `e269afc` — GitHub synced |

---

## 🔧 Tech Debt (Low Priority)

1. No request throttling — could overwhelm Puppeteer under load
2. Asset path hardcoding — should use environment variables
3. QA recorder NBA endpoint — should use `/generate-thumbnail` with `contentType: 'nba'`
4. 12-test suite re-run pending — Tests 2 & 4 fixed, need confirmed 12/12 pass
5. **Audit trail for rollback/force-advance** — neither dashboard log nor `logs/errors.jsonl` records rollback/advance events. Dashboard should append to job card log; server should write `{level:'warn', kind:'rollback'|'advance', jobId, before, after, at}` to `logs/errors.jsonl`. See `ROLLBACK_FORCE_ADVANCE_SPEC.md` → "Audit trail" section.
6. **Revisit Instagram publish strategy after 10 successful Reels** — Upload-Post has no IG draft/private API parameter (confirmed 2026-04-10). Current policy: IG account stays account-wide private until 10 Reels shipped end-to-end with no content issues. After that, run the Trial Reels API test (documented in `ROLLBACK_FORCE_ADVANCE_SPEC.md` → "Publish-Time Privacy" section) to determine whether `share_mode=TRIAL_REELS_DONT_SHARE_TO_FOLLOWERS` actually works on a new account without the 1,000-follower minimum. Based on outcome: (a) wire it into `server.js:7030-7033` and flip account public, (b) drop IG from default `platforms` array until follower count grows, or (c) keep account private indefinitely. YouTube (`private`) + TikTok (`SELF_ONLY`) are already handled correctly at the API level.

---

## 🏗️ Services & Ports

| Service | Port | Command |
|---------|------|---------|
| Dashboard | 8765 | `python3 -m http.server 8765` |
| Node API | 3000 | `nodemon server.js` |
| VectCut API | 9001 | `cd VectCutAPI && ./venv-capcut/bin/python3 capcut_server.py` |

**Dashboard:** http://localhost:8765/cwn_production.html

---

## 🎨 Brand Standards (Quick Reference)

- **CWN Gold:** `#c7af4f`
- **Border:** `5px solid` + `0 4px 15px rgba(0,0,0,0.5)` shadow at 50% opacity
- **Logo Opacity:** 85% (0.85)
- **Long-form Logo:** 120px at `20:20` (top-LEFT, 20px margins — moved from top-right to avoid collision with TV card at x=1240)
- **Short-form Logo:** 80px at `W-w-15:15` (top-right, 15px margins)
- **Tagline:** "BECAUSE THE LIGHT WAS ON" (all thumbnails)

---

## 📁 Key Files

| File | Purpose |
|------|---------|
| `CLAUDE.md` | Full architecture, rules, gotchas (READ FIRST every session) |
| `STATUS.md` | This file — current tasks + system state |
| `QA_GATES.md` | All QA gates (1-6) documented |
| `COMMIT_CHECKLIST.md` | Pre-commit rules for Aider/Cline |
| `server.js` | Node.js API (6000+ lines, all endpoints) |
| `cwn_production.html` | Dashboard UI |
| `data/streamers.json` | Streamer roster + display names + phonetics |
| `data/cwn_style_guides.json` | Gemini-learned style fingerprints per content type |
| `test/test_suite_12cases.json` | 12-test validation suite |
| `data/episode_counters.json` | Episode tracking (twitch/nba/news) |
| `.aider.conf.yml` | Aider config (claude-sonnet-4-20250514) |
| `VISUAL_DESIGN_SPEC.md` | Short-form layout spec (1080×1920, zones, safety) |
| `CREATIVE_VS_OPERATIONS.md` | 7 creative decisions needed for Phase 5 |
| `MORNING_BRIEFING.md` | What Aider did overnight — read every morning before touching code |
| `OVERNIGHT_TASKS.md` | Aider's overnight task queue (1am-7am ET window) |
| `SERVER_SPLIT_PLAN.md` | Plan to split server.js into modules — IN PROGRESS (Phase 1 done: config, logger, metrics extracted ✅) |

---

## 📜 Recent Commits

```
64c2f70  fix: flatten 2D clipAnalyses in claudeScriptQA — correct streamer attribution for Twitch (Fix #3)
186ea3d  Phase 3: generateShortFormCaption + prioritizeNewsStories
b40ee6a  fix: correct Twitch longform tagline to TALK SOUP + switch Aider to Anthropic API
2c0878a  docs: update MASTER_TASK_LIST.md — Phase 2 + Phase 4 marked complete
9fa9340  feat(phase4): Gate 3 human approval + Gate 6 auto-publish wiring
88e20eb  Phase 2: Short-form split-screen + CapCut integration
93aa22f  fix: Scene header normalization (spaces → underscores in Gemini output)
bc3f3a9  Fix Tests 2 & 4: scene header spaces, ExtraEmily displayName, manual v2.1
```

---

## 🗑️ Files to Archive (Pending Claude Notification)

These files are superseded by `STATUS.md` and `CLAUDE.md`. Do not delete until Claude Code is notified:

**Replaced by STATUS.md:**
- `TODO.md` — backlog (now in STATUS.md)
- `AUTOMATION_STATUS.md` — completed items (now in STATUS.md)
- `HANDOVER.md` — session handover (now in STATUS.md)
- `SESSION_SUMMARY.md` — session history (now in STATUS.md)
- `MASTER_TASK_LIST.md` — phase tracker (now in STATUS.md)

**Stale planning docs (Apr 6, superseded by CLAUDE.md):**
- `WORKFLOW_GAPS_ANALYSIS.md`
- `COMPREHENSIVE_REVIEW.md`
- `CODEBASE_OVERVIEW.md`
- `IMPLEMENTATION_PLAN.md`
- `IMPLEMENTATION_SPEC.md`
- `IMPLEMENTATION_AUTOMATION.md`
- `NEXT_TEST_PLAN.md`

**Resolved bug docs:**
- `FIX_PLAN_SCENE_STRUCTURE.md`
- `TEST_FAILURE_ANALYSIS.md`
- `TEST1_POSTMORTEM.md`
- `URGENT_TEST_FAILURE_INVESTIGATION.md`
- `TEST_RESULTS_FINAL_2026-04-09.md`
- `NEWS_COMPILATION_FIX.md`
- `DESIGN_REVIEW_SUMMARY.md`
- `CANVA_FIX_SUMMARY.md`
- `GATE1_MAX_DATA_LIMITS.md`
