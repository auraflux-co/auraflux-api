# CWN Production — Status & Task Tracker

**Last Updated:** 2026-04-09 (11:44 PM ET)
**Branch:** main | **Latest Commit:** pending — fix: TV card overlay position → top-left (facing Bobby G)
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
| Cline | Phase 1-6 acceptance test plan + rollback process | `test/PHASE_1_6_ACCEPTANCE_TEST.md`, `STATUS.md` | pending | 2026-04-09 7:26 PM ET |
| Cline | Fix TV card overlay position: OVERLAY_ZONE + 2 hardcoded FFmpeg overlays → x=40 (top-left, facing Bobby G) | `server.js` | pending | 2026-04-09 7:37 PM ET |
| Cline | Module split Phase 1: extract lib/config.js, lib/logger.js, lib/metrics.js from server.js; remove inline duplicates; server verified clean | `lib/config.js`, `lib/logger.js`, `lib/metrics.js`, `server.js`, `SERVER_SPLIT_PLAN.md` | `787f81f` | 2026-04-09 11:30 PM ET |
| Cline | Upgrade pre-commit hook: add soft-warn for stale .md docs; update COMMIT_CHECKLIST + CLAUDE.md with doc-update rule | `scripts/pre-commit.sh`, `COMMIT_CHECKLIST.md`, `CLAUDE.md` | `d0ae35a` | 2026-04-09 11:35 PM ET |
| Cline | Add git push step to COMMIT_CHECKLIST.md | `COMMIT_CHECKLIST.md` | `b719c51` | 2026-04-09 11:39 PM ET |
| Cline | Add overnight automation: scripts/overnight_runner.sh + launchd plist (1am daily cron) | `scripts/overnight_runner.sh`, `scripts/com.cwn.overnight.plist`, `OVERNIGHT_TASKS.md` | `2563326` | 2026-04-09 11:43 PM ET |
| Cline | Add aider_plan.sh — one-shot full environment audit + multi-week plan generator | `scripts/aider_plan.sh` | pending | 2026-04-09 11:44 PM ET |

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
- **TV card position:** All 3 overlay positions (OVERLAY_ZONE + 2 FFmpeg burns) → `x=40` top-left, facing Bobby G ✅
- **Split-screen short-form:** `/capcut/split-screen` + `assembleShortForm()` — 9:16 portrait (`server.js:8358`) ✅
- **CapCut routes:** `/capcut/init`, `/capcut/add-segment`, `/capcut/ticker`, `/capcut/logo`, `/capcut/finalize`
- **Safety zone check:** TikTok + Reels AABB+circle overlap validation
- **Gate 3/6 approval flow:** Human checkpoint → approve → auto-publish with status polling
- **Disk usage + cleanup:** `GET /disk-usage`, `POST /cleanup`
- **VectCutClient:** `assembleShortForm()`, `addBrandedOverlay()`, `healthCheck()`
- **Upload status tracking:** `GET /upload-status/:trackingId` + `data/upload_status.json`

---

## 🟡 Phase 6 — Publish Integration (Active)

**`UPLOADPOST_API_KEY` ✅ confirmed in `.env` — ready to test**

| Task | Status | Notes |
|------|--------|-------|
| `UPLOADPOST_API_KEY` in `.env` | ✅ Done | JWT token confirmed present |
| Test Case #1: Twitch Long → YouTube Private | 🟡 Ready to run | Spec in `UPLOAD_API_SPEC.md` — need a video in `output/` |
| Test Case #2-5: Multi-platform | ⏳ After Test #1 passes | TikTok + Instagram + simultaneous |
| Approve overnight queue (Aider) | ⏳ Waiting on Rob | See `OVERNIGHT_TASKS.md` |
| Push commits to origin/main | ✅ Done | Pushed `b7af98a` — GitHub synced |

---

## 🔧 Tech Debt (Low Priority)

1. No request throttling — could overwhelm Puppeteer under load
2. Asset path hardcoding — should use environment variables
3. QA recorder NBA endpoint — should use `/generate-thumbnail` with `contentType: 'nba'`
4. 12-test suite re-run pending — Tests 2 & 4 fixed, need confirmed 12/12 pass

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
- **Long-form Logo:** 120px at `W-w-20:20` (top-right, 20px margins)
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
