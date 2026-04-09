# Cline Plan Presentation Template

This template defines how Cline (Human Review Layer) presents plans before making code changes, following the orchestration model in CLAUDE.md.

---

## Plan Presentation Format

### 1. TASK SUMMARY
**What:** [One-sentence description of what needs to be done]
**Why:** [Business/technical reason for this change]
**Risk Level:** [LOW / MEDIUM / HIGH]

---

### 2. AFFECTED FILES
List all files that will be created, modified, or deleted:

**New Files:**
- `path/to/new/file.js` - [Purpose]

**Modified Files:**
- `path/to/existing/file.js` - [What sections will change]
- `path/to/another/file.js` - [What sections will change]

**Deleted Files:**
- `path/to/deprecated/file.js` - [Reason for removal]

---

### 3. IMPLEMENTATION STEPS

Break down the work into clear, sequential steps:

**Step 1: [Action Name]**
- What: [Specific change]
- Where: [File/function/line range]
- Why: [Reason for this approach]

**Step 2: [Action Name]**
- What: [Specific change]
- Where: [File/function/line range]
- Why: [Reason for this approach]

[Continue for all steps...]

---

### 4. AGENT ORCHESTRATION

Specify which AI agent handles each part:

| Task | Agent | Reason |
|------|-------|--------|
| [Task description] | Claude Code | [Why Claude handles this] |
| [Task description] | Aider | [Why Aider handles this - e.g., large file refactor] |
| [Task description] | Gemini Flash | [Why Gemini handles this - e.g., visual decision] |

---

### 5. DEPENDENCIES & PREREQUISITES

**Required Before Starting:**
- [ ] [Prerequisite 1]
- [ ] [Prerequisite 2]

**External Dependencies:**
- API: [Which APIs will be called]
- Services: [Which services must be running - e.g., VectCut on port 9001]
- Files: [Which config files must exist]

---

### 6. TESTING APPROACH

**How to Verify:**
1. [Test step 1]
2. [Test step 2]
3. [Expected outcome]

**Manual Testing:**
- Dashboard: [Which dashboard page to check]
- API: [Which endpoint to curl]
- Browser: [What to verify visually]

---

### 7. ROLLBACK PLAN

**If Something Goes Wrong:**
1. [Rollback step 1]
2. [Rollback step 2]

**Safe Points:**
- Git commit before: [commit hash or "current HEAD"]
- Backup files: [Which files to backup manually]

---

### 8. COMMIT STRATEGY

**Commit Message:**
```
[type]: [short description]

[Longer explanation of why this change was needed]
```

**Files to Stage:**
- [List specific files to include in commit]

**Files to Exclude:**
- `.env` (never commit)
- `output/` (never commit)
- `tmp/` (never commit)
- [Other exclusions per AIDER_COMMIT_CHECKLIST.md]

---

## Example Plan

### 1. TASK SUMMARY
**What:** Add NBA intro card generation endpoint
**Why:** Enable long-form NBA videos to show game thumbnails at each GAME#_INTRO scene
**Risk Level:** MEDIUM (new endpoint, integrates with VectCut API)

---

### 2. AFFECTED FILES

**New Files:**
- None (adding endpoint to existing server.js)

**Modified Files:**
- `server.js` - Add `/nba/generate-intro-card` endpoint (after line 6000)
- `HANDOVER.md` - Update Priority 1 task list (mark NBA card as complete)

**Deleted Files:**
- None

---

### 3. IMPLEMENTATION STEPS

**Step 1: Create NBA Card Generator Function**
- What: Add `generateNbaIntroCard(gameId, width, height)` helper function
- Where: `server.js` around line 2500 (near other helper functions)
- Why: Reuses existing `nba_thumbnail_generator.html` logic, resizes to 640×360 TV shape

**Step 2: Add POST Endpoint**
- What: Create `/nba/generate-intro-card` route handler
- Where: `server.js` after line 6000 (with other NBA endpoints)
- Why: Allows assembly pipeline to request cards on-demand per game

**Step 3: Integrate with VectCutClient**
- What: Update `assembleVideo()` to call new endpoint for NBA content
- Where: `server.js` assembly function (around line 3500)
- Why: Automatically generates and overlays cards at GAME#_INTRO scenes

---

### 4. AGENT ORCHESTRATION

| Task | Agent | Reason |
|------|-------|--------|
| Write endpoint logic | Claude Code | Straightforward API endpoint, <100 lines |
| Test visual output | Gemini Flash | Verify card layout matches brand standards |
| Review before commit | Cline | Present plan, summarize changes |

**Note:** Aider NOT needed - changes are localized, file is large but edits are contained.

---

### 5. DEPENDENCIES & PREREQUISITES

**Required Before Starting:**
- [x] VectCut API running on port 9001
- [x] `nba_thumbnail_generator.html` exists and works
- [x] `VISUAL_LAYOUTS.LONG_FORM.OVERLAY_ZONE` defined in CONFIG

**External Dependencies:**
- API: VectCut API (http://localhost:9001)
- Services: Node API server (port 3000)
- Files: `streamers.json` (not needed for NBA, but good to verify structure)

---

### 6. TESTING APPROACH

**How to Verify:**
1. Start VectCut API: `cd VectCutAPI && ./venv-capcut/bin/python3 capcut_server.py`
2. Curl the endpoint: `curl -X POST http://localhost:3000/nba/generate-intro-card -H "Content-Type: application/json" -d '{"gameId":"test123","teams":"Celtics vs Hawks"}'`
3. Check response for `{cardPath: "output/nba_card_test123.png", width: 640, height: 360}`
4. Verify PNG exists and has correct dimensions

**Manual Testing:**
- Dashboard: Go to NBA Production page, trigger full assembly
- API: Check logs for card generation timing
- Browser: Open generated PNG, verify it's 640×360 TV shape

---

### 7. ROLLBACK PLAN

**If Something Goes Wrong:**
1. `git reset --hard HEAD` (if not committed yet)
2. Restart Node server: `nodemon server.js`
3. Check VectCut API health: `curl http://localhost:9001/`

**Safe Points:**
- Git commit before: Current HEAD (8256b61)
- Backup files: Not needed (changes are additive, no deletions)

---

### 8. COMMIT STRATEGY

**Commit Message:**
```
feat: add NBA intro card generation endpoint

Enables long-form NBA videos to display 640×360 TV-shaped game thumbnails
at each GAME#_INTRO scene. Integrates with VectCut API for overlay positioning.

Part of Phase 2 implementation (IMPLEMENTATION_SPEC.md).
```

**Files to Stage:**
- `server.js` (NBA card endpoint + helper function)
- `HANDOVER.md` (update Priority 1 checklist)

**Files to Exclude:**
- `.env` (never commit)
- `output/` (never commit)
- `tmp/` (never commit)
- Any test PNG files generated during development

---

## Usage Instructions

**When to Present a Plan:**
1. Before ANY code changes (per CLAUDE.md Agent Orchestration Policy)
2. When task involves multiple files or high-risk refactors
3. When behavior changes require explicit approval

**How to Present:**
1. Fill out this template completely
2. Show to Rob (the human) for review
3. Wait for approval before proceeding
4. After changes complete, provide summary of what changed

**After Implementation:**
1. Summarize what was actually changed (may differ from plan)
2. Note any deviations from original plan and why
3. Confirm testing results
4. Present commit message for approval

---

## Integration with Orchestration Model

This plan format supports the 4-agent workflow:

- **Claude Code (General Manager):** Creates the plan, breaks into safe steps
- **Aider (Surgical Coder):** Executes high-risk refactors identified in plan
- **Gemini Flash (Visual Director):** Handles visual decisions flagged in plan
- **Cline (Human Review Layer):** Presents this plan, gets approval, summarizes after

**Key Principle:** Rob leads with ideas, reviews at checkpoints. This template ensures he can understand and approve work before code changes.

---

**Last Updated:** 2026-04-08
**Version:** 1.0
