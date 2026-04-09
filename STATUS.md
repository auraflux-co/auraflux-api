# CWN Production — Status & Task Tracker

**Last Updated:** 2026-04-09 (1:45 PM ET)
**Branch:** main | **Latest Commit:** `186ea3d` — Phase 3: generateShortFormCaption + prioritizeNewsStories
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

## 📊 Phase Progress

| Phase | Owner | Status | Commit |
|-------|-------|--------|--------|
| Phase 1: Thumbnail Updates | Claude Code | 🟡 In progress | — |
| Phase 2: Short-Form Infrastructure | Cline | ✅ COMPLETE | `88e20eb` |
| Phase 3: Caption & Prioritization | Aider | ✅ COMPLETE | `186ea3d` |
| Phase 4: Operations Fixes | Cline | ✅ COMPLETE | `9fa9340` |
| Phase 5: Creative Layer | Claude Code → Cline | 🔴 Blocked (creative session in progress) | — |

---

## 🟡 Phase 1 — Long-Form Thumbnail Updates
**Owner:** Claude Code | **Est:** 2-3 hours

| Task | File | What |
|------|------|------|
| 1.1 News Thumbnail | `cwn_news_tool.html` | Tagline → "BECAUSE THE LIGHT WAS ON", 40-60% dark overlay, 8px blur |
| 1.2 NBA Thumbnail | `nba_thumbnail_generator.html` | Same tagline + overlay + blur |
| 1.3 Twitch Longform | `server.js` (Canvas code ~line 6354) | Refactor to use `assets/twitchsoup_thumbnail.jpeg` as base |
| 1.4 Validation | All 3 | Text readable at 1280×720, blur consistent, episode counter still works |

---

## 🔴 Phase 5 — Creative Layer (Blocked)
**Owner:** Claude Code (decisions) → Cline/Aider (build)
**Status:** Creative alignment session in progress with Rob + Claude

7 decisions needed before implementation can start:
1. Short-form split-screen layout (safe zones, intro/outro timing)
2. NBA intro card design (content, timing, border style)
3. News intro card design (fallback image, headline, attribution)
4. Gold border brand rules (scope, shadow spec, no-go zones)
5. Gate 3 visual retention rules (7-second rule vs CWN style)
6. Thumbnail strategy (3-option battle vs auto-select)
7. Bobby G voice standard (style guide accuracy)

---

## ✅ What's Working (Full System)

- **Full pipeline:** Script Gen → Gate 1 → HeyGen → Gate 2 → Assembly → Gate 3 → Drive Upload → Publish
- **All 3 content types:** Twitch, NBA, News (long-form + short-form)
- **Scene headers:** spaces → underscores (no more broken Gemini parsing)
- **Multi-platform publish:** YouTube, TikTok, Instagram via Upload-Post API
- **Short-form captions:** `generateShortFormCaption()` — 90-150 char + hashtags + altText
- **News prioritization:** `prioritizeNewsStories()` — 18 urgency keywords, score-sorted
- **Thumbnails:** FFmpeg-based for all 3 content types, episode auto-increment
- **CapCut routes:** `/capcut/init`, `/capcut/add-segment`, `/capcut/ticker`, `/capcut/logo`, `/capcut/finalize`
- **Safety zone check:** TikTok + Reels AABB+circle overlap validation
- **Gate 3/6 approval flow:** Human checkpoint → approve → auto-publish with status polling
- **Disk usage + cleanup:** `GET /disk-usage`, `POST /cleanup`
- **VectCutClient:** `assembleShortForm()`, `addBrandedOverlay()`, `healthCheck()`

---

## ⏸️ Next Up (After Phase 5 Creative Decisions)

These are blocked on Phase 5 creative alignment:

1. **NBA intro card endpoint** (`/nba/generate-intro-card`)
   - Resize `nba_thumbnail_generator.html` output to 640×360 TV shape
   - Overlay at `VISUAL_LAYOUTS.LONG_FORM.OVERLAY_ZONE` (right of Bobby G)

2. **News article image scraper** (`/news/generate-intro-card`)
   - Scrape Open Graph images from article URLs
   - Resize to 640×360, position right of Bobby G avatar

3. **Short-form split-screen assembly** (in `/assemble`)
   - Use `VectCutClient.assembleShortForm()` for 9:16 layout
   - Top 50%: source clip (1080×960), Bottom 50%: Bobby G (1080×960)

4. **Gate 3 visual retention checks**
   - Add visual balance + brand presence checks (gold borders, logo opacity)

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
| `streamers.json` | Streamer roster + display names + phonetics |
| `cwn_style_guides.json` | Gemini-learned style fingerprints per content type |
| `test_suite_12cases.json` | 12-test validation suite |
| `episode_counters.json` | Episode tracking (twitch/nba/news) |
| `.aider.conf.yml` | Aider config (claude-sonnet-4-20250514) |
| `VISUAL_DESIGN_SPEC.md` | Short-form layout spec (1080×1920, zones, safety) |
| `CREATIVE_VS_OPERATIONS.md` | 7 creative decisions needed for Phase 5 |
| `MORNING_BRIEFING.md` | What Aider did overnight — read every morning before touching code |
| `OVERNIGHT_TASKS.md` | Aider's overnight task queue (1am-7am ET window) |
| `SERVER_SPLIT_PLAN.md` | Plan to split server.js into modules (pending approval) |

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
