# CWN Production - Session Handover

**Last Updated:** 2026-04-08
**Session End Time:** 2026-04-08 (Context continuation session)
**Next Claude Session:** Read this file first for context

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
| **VectCut API** | **9001** | **✅ HEALTHY** | `./venv-capcut/bin/python3 capcut_server.py` |

**VectCut Health Check:** `curl http://localhost:9001/` (returns server info)

---

## Current Implementation State

### ✅ Completed Today (2026-04-08)

1. **VectCut API Integration**
   - Server running on port 9001
   - Environment variables added to .env (VECTCUT_API_URL, SHORT_FORM_LOGO_SIZE, SHORT_FORM_AUDIO_MIX)

2. **VISUAL_LAYOUTS Configuration** (server.js:175-196)
   - Long-form 1920×1080 spatial mapping with AVATAR_SAFE_ZONE, OVERLAY_ZONE, LOGO_POS
   - Short-form 1080×1920 spatial mapping with CLIP_ZONE, AVATAR_ZONE, BURN_IN_ZONE

3. **VectCutClient Class** (server.js:232-318)
   - `assembleShortForm(clipPath, avatarPath, jobId)` - Creates 9:16 split-screen
   - `addBrandedOverlay(videoPath, assetPath, layout)` - Applies CWN Gold (#c7af4f) borders
   - `healthCheck()` - Verifies API connectivity

4. **design_metadata Field** (server.js:5867-5875)
   - Added to `/generate-full-script` response
   - Schema: visualHook, safeZone, overlayPositions, burnInImages, logoPlacement, colorGrading
   - Enables Gemini to store visual instructions for Claude to execute

5. **Phase 6 Documentation** (IMPLEMENTATION_SPEC.md:272-318)
   - AI-Generated Burn-In Images workflow spec
   - Gemini generates design_brief (Midjourney-style prompts)
   - Claude triggers image generation API and places via VectCut

6. **Cline Plan Presentation System** (NEW)
   - `CLINE_PLAN_TEMPLATE.md` - 8-section structured plan format
   - `CLINE_USAGE_GUIDE.md` - Complete workflow documentation
   - `EXAMPLE_PLAN_NBA_CARDS.md` - Real-world example plan
   - `CLAUDE.md` - Updated with Cline implementation references
   - Enables human review checkpoints before/after code changes

### 🚧 In Progress

- **End-of-Session Protocol Creation** (this file)

### ⏸️ Priority 1 - Next Tasks

1. **Create NBA card generator endpoint** (`/nba/generate-intro-card`)
   - Resize `nba_thumbnail_generator.html` output to 640×360 TV shape
   - Return PNG path for FFmpeg overlay at `VISUAL_LAYOUTS.LONG_FORM.OVERLAY_ZONE`

2. **Build News article image scraper** (`/news/generate-intro-card`)
   - Scrape Open Graph/Twitter Card images from article URLs
   - Resize to 640×360, position right of Bobby G avatar

3. **Implement short-form split-screen in `/assemble` endpoint**
   - Use VectCutClient.assembleShortForm() for 9:16 layout
   - Top half: source clip (1080×960), Bottom half: Bobby G (1080×960)
   - Apply 80px logo overlay via VISUAL_LAYOUTS.SHORT_FORM.LOGO_POS

4. **Update Gate 3 QA for visual retention**
   - Add visual balance checks (per Creative Requirements)
   - Verify brand presence (gold borders, logo opacity)
   - Check retention hooks align with design_metadata.visualHook

---

## Brand Standards (Reference Quick)

- **CWN Gold:** `#c7af4f`
- **Border Width:** `5px solid` with `0 4px 15px rgba(0,0,0,0.5)` shadow at 50% opacity
- **Logo Opacity:** `85%` (0.85)
- **Long-form Logo:** 120px at `W-w-20:20` (top-right, 20px margins)
- **Short-form Logo:** 80px at `W-w-15:15` (top-right, 15px margins)

---

## Current Design Blockers

### None at this time

All infrastructure is in place. Ready to proceed with Phase 2 (Card Generation) and Phase 4 (Short-form Split-Screen).

---

## Git Status (Snapshot)

**Branch:** main
**Last Commit:** `7f4f187 - feat: add design_metadata to /generate-full-script response`

**Recent Commits:**
```
7f4f187 feat: add design_metadata to /generate-full-script response
6f47dc3 feat: add VectCutClient design orchestrator
1f49a49 docs: add Phase 6 AI burn-in images to IMPLEMENTATION_SPEC
6778b73 feat: add VISUAL_LAYOUTS config for brand spatial mapping
6b84d7a fix: upgrade profile image URLs to 300x300
```

**Working Directory:** Clean (no uncommitted changes)

---

## First 3 Tasks for Tomorrow Morning

When you start the next session, say:

> "Claude, read CLAUDE.md and HANDOVER.md. We are implementing the VectCut integration. You are the Implementation Lead, and Gemini is our Creative Director. What is the next task on our Priority 1 list?"

Then proceed with:

1. **Task 1:** Create `/nba/generate-intro-card` endpoint
   - Read `nba_thumbnail_generator.html` to understand existing logic
   - Create new endpoint that accepts `{gameId, width: 640, height: 360}`
   - Return `{cardPath, gameId, teams}` for FFmpeg overlay

2. **Task 2:** Create `/news/generate-intro-card` endpoint
   - Implement `scrapeNewsHeaderImage(articleUrl)` function
   - Use cheerio to extract og:image or twitter:image
   - Download, resize to 640×360, return path

3. **Task 3:** Test both endpoints standalone
   - Run NBA card generation for a real game
   - Run News scraper for a real Reuters article
   - Verify dimensions and file paths before assembly integration

---

## Context Re-Injection Prompt (Use This Tomorrow)

```
Claude, read CLAUDE.md and the latest run_metrics file. We are in the middle of implementing VectCut API integration for video production.

You are the Implementation Lead, and Gemini is our Creative Director. Our VectCut API is live on port 9001.

Key context:
- VectCutClient class is implemented (server.js:232-318)
- VISUAL_LAYOUTS config defines all spatial coordinates
- design_metadata field added to /generate-full-script response
- You must consult Gemini for ALL visual decisions (never assume)

What is the next task on our Priority 1 list?
```

---

## Notes for Rob

- **PENDING COMMIT:** New Cline files created but NOT yet committed to git
  - `CLINE_PLAN_TEMPLATE.md`, `CLINE_USAGE_GUIDE.md`, `EXAMPLE_PLAN_NBA_CARDS.md`
  - `CLAUDE.md` modified with Cline references
  - See commit strategy below for how to notify Claude Code

- VectCut API server still running on port 9001 (PID from previous session may have changed)
- No broken state - everything is saved and ready for next session
- design_metadata currently returns null values - Gemini prompt needs update to populate this (future task)

### How to Notify Claude Code of New Files

**Option 1: Commit to GitHub (Recommended)**
```bash
cd ~/cwn-production
git add CLINE_PLAN_TEMPLATE.md CLINE_USAGE_GUIDE.md EXAMPLE_PLAN_NBA_CARDS.md CLAUDE.md
git commit -m "docs: add Cline plan presentation system

Implements structured plan presentation mechanism for Human Review Layer.
Cline now presents 8-section plans before code changes and summaries after.

Files:
- CLINE_PLAN_TEMPLATE.md: Template for plan presentation
- CLINE_USAGE_GUIDE.md: Complete workflow documentation
- EXAMPLE_PLAN_NBA_CARDS.md: Real-world example
- CLAUDE.md: Updated with Cline implementation references"

git push origin main
```

Then in Claude Code chat:
> "Claude, pull the latest changes from GitHub. New Cline documentation has been added: CLINE_PLAN_TEMPLATE.md, CLINE_USAGE_GUIDE.md, and EXAMPLE_PLAN_NBA_CARDS.md. Read these files to understand the new plan presentation workflow."

**Option 2: Direct File Reference (No Commit)**
In Claude Code chat:
> "Claude, read the following new files in the repo: CLINE_PLAN_TEMPLATE.md, CLINE_USAGE_GUIDE.md, and EXAMPLE_PLAN_NBA_CARDS.md. These define how Cline presents plans before code changes."

**Option 3: Update .aider.conf.yml (Auto-read on startup)**
Add to `.aider.conf.yml`:
```yaml
read:
  - CLAUDE.md
  - AIDER_COMMIT_CHECKLIST.md
  - CLINE_PLAN_TEMPLATE.md
  - CLINE_USAGE_GUIDE.md
```

This makes Aider (and potentially Claude Code) auto-read these files on startup.

**Recommended Approach:** Use Option 1 (commit + push) so files are version-controlled and Claude Code can reference them via git history.

---

**END OF HANDOVER**

_This file is auto-regenerated at end of each session. DO NOT manually edit - changes will be overwritten._
