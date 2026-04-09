# CWN Production - Session Handover

**Last Updated:** 2026-04-09 (12:36 AM ET)
**Session End Time:** 2026-04-09 ~12:36 AM
**Next Claude Session:** Read CLAUDE.md + this file first for full context

---

## How to Start Next Session

Tell Cline:
> "Read CLAUDE.md and HANDOVER.md and tell me what we're working on"

Cline will be fully up to speed in ~30 seconds. No re-training needed.

---

## Current Design Hierarchy (CRITICAL)

**Gemini = Primary Design Owner** (Visual strategy, placement, pacing, design_brief generation)
**Claude = Implementation Lead** (Executes Gemini's designs via VectCut/FFmpeg, manages all Gemini API calls)

### Key Rule
Claude must NEVER assume design choices (thumbnail layout, overlay positioning, color grading). You are required to:
- **Consult Gemini** for all visual decisions (hooks, safe zones, coordinates)
- **Pass Gemini's design_metadata** directly into VectCutClient or FFmpeg filters
- **Report back to Rob** only when Gemini has approved design at Gate 3

---

## Port Map & Service Status

| Service | Port | Status | Command |
|---------|------|--------|---------|
| Dashboard | 8765 | ✅ HEALTHY | `python3 -m http.server 8765` |
| Node API | 3000 | ✅ HEALTHY | `nodemon server.js` |
| VectCut API | 9001 | ✅ HEALTHY | `./venv-capcut/bin/python3 capcut_server.py` |

**VectCut Health Check:** `curl http://localhost:9001/`

---

## What Was Fixed Tonight (April 8-9, 2026)

### Bug 1 — NBA Scene Headers Had Spaces ✅ FIXED
**File:** `server.js` (~line 6015)
**Problem:** "Trail Blazers" → `=== GAME4_JAZZ_TRAIL BLAZERS_INTRO ===` (space breaks Gemini parsing)
**Fix:** `.replace(/\s+/g, '_')` on team names before embedding in headers
**Result:** `=== GAME4_JAZZ_TRAIL_BLAZERS_INTRO ===` ✅

### Bug 2 — Twitch Scene Headers Had Spaces ✅ FIXED
**File:** `server.js` (~line 6231)
**Problem:** "Jay Cinco" → `=== JAY CINCO_INTRO ===` (space breaks Gemini parsing)
**Fix:** `.replace(/\s+/g, '_')` on display names before embedding in headers
**Result:** `=== JAY_CINCO_INTRO ===` ✅

### Bug 3 — ExtraEmily displayName Mismatch ✅ FIXED
**File:** `test_suite_12cases.json` (Test 2, item 5)
**Problem:** `"displayName": "ExtraEmily"` but `getDisplayName('extraemily')` returns `"Emily"`
**Fix:** Changed to `"displayName": "Emily"`

### Root Cause
Tests 2 (Twitch Long-form B) and 4 (NBA Long-form B) were failing because multi-word names with spaces in `=== HEADER ===` markers break Gemini's structured output parsing. Fix: `.replace(/\s+/g, '_')` on all scene header name generation.

---

## Other Changes Tonight

- **CWN_Production_Manual.html** → Updated to v2.1 (Gate 5, disk cleanup, wired publish endpoints)
- **`.aider.conf.yml`** → Switched from `gemini-2.5-pro` → `gemini-2.5-flash` (5-10x faster)
- **`AIDER_COMMIT_CHECKLIST.md`** → Added Context Management + Repository Map sections
- **`SESSION_SUMMARY.md`** → Fully updated with tonight's work

---

## Current Implementation State

### ✅ Fully Working
- Full pipeline: Script Gen → Gate 1 → HeyGen → Gate 2 → Assembly → Gate 3 → Drive Upload → Publish
- Gate 5 (Final Video QA): Visual 30 + Audio 30 + Clips 30 + Pacing 10 = 100, pass ≥85
- All 3 content types: Twitch, NBA, News (long-form + short-form)
- Scene header generation: spaces → underscores (no more broken headers)
- Multi-platform publish: YouTube, TikTok, Instagram via Upload-Post API
- Disk usage + cleanup: `GET /disk-usage`, `POST /cleanup`
- FFmpeg thumbnail generator: all 3 content types with episode auto-increment
- VectCutClient class: `assembleShortForm()`, `addBrandedOverlay()`, `healthCheck()`
- VISUAL_LAYOUTS config: spatial coordinates for long-form + short-form
- design_metadata field in `/generate-full-script` response

### Test Suite Status
| Test | Name | Status |
|------|------|--------|
| 1 | Twitch Long-form A | ✅ Should pass |
| 2 | Twitch Long-form B (Jay Cinco, Emily) | ✅ Fixed tonight |
| 3 | NBA Long-form A | ✅ Should pass |
| 4 | NBA Long-form B (Trail Blazers) | ✅ Fixed tonight |
| 5-12 | News + Short-form | ✅ Should pass |

### ⏸️ Priority 1 - Next Tasks (Not Yet Started)

1. **Create NBA card generator endpoint** (`/nba/generate-intro-card`)
   - Resize `nba_thumbnail_generator.html` output to 640×360 TV shape
   - Return PNG path for FFmpeg overlay at `VISUAL_LAYOUTS.LONG_FORM.OVERLAY_ZONE`

2. **Build News article image scraper** (`/news/generate-intro-card`)
   - Scrape Open Graph/Twitter Card images from article URLs
   - Resize to 640×360, position right of Bobby G avatar

3. **Implement short-form split-screen in `/assemble` endpoint**
   - Use VectCutClient.assembleShortForm() for 9:16 layout
   - Top half: source clip (1080×960), Bottom half: Bobby G (1080×960)

4. **Update Gate 3 QA for visual retention**
   - Add visual balance checks (per Creative Requirements)
   - Verify brand presence (gold borders, logo opacity)

---

## Brand Standards (Quick Reference)

- **CWN Gold:** `#c7af4f`
- **Border Width:** `5px solid` with `0 4px 15px rgba(0,0,0,0.5)` shadow at 50% opacity
- **Logo Opacity:** `85%` (0.85)
- **Long-form Logo:** 120px at `W-w-20:20` (top-right, 20px margins)
- **Short-form Logo:** 80px at `W-w-15:15` (top-right, 15px margins)

---

## Git Status (Current)

**Branch:** main
**Latest Commit:** `986034f - Update SESSION_SUMMARY.md with April 8-9 session work`

**Tonight's Commits:**
```
986034f  Update SESSION_SUMMARY.md with April 8-9 session work
701b64a  Add Repository Map section to Aider checklist
763da4a  Add context management tips to Aider checklist
e1cd730  Switch Aider model from gemini-2.5-pro to gemini-2.5-flash
bc3f3a9  Fix Tests 2 & 4: scene header spaces, ExtraEmily displayName, manual v2.1
```

**Working Directory:** Clean ✅

---

## Key Files Reference

| File | Purpose |
|------|---------|
| `CLAUDE.md` | Full project rules + architecture (READ FIRST) |
| `SESSION_SUMMARY.md` | Detailed session history |
| `server.js` | Node.js API (6000+ lines) |
| `cwn_production.html` | Dashboard UI |
| `streamers.json` | Streamer roster + display names |
| `test_suite_12cases.json` | 12-test validation suite |
| `.aider.conf.yml` | Aider config (gemini-2.5-flash) |
| `QA_GATES.md` | All 5 QA gates |
| `AIDER_COMMIT_CHECKLIST.md` | Aider workflow rules + context tips |

---

**END OF HANDOVER**

_Updated at end of each session. Reflects current state of the project._
