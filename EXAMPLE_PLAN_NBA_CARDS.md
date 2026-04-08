# Example Plan: NBA Intro Card Endpoint

This is a real-world example of how Cline presents a plan using `CLINE_PLAN_TEMPLATE.md` before making code changes.

---

## 1. TASK SUMMARY

**What:** Add `/nba/generate-intro-card` endpoint to generate 640×360 TV-shaped intro cards for NBA long-form videos

**Why:** Enable the assembly pipeline to automatically display game thumbnails at each `GAME#_[TEAMS]_INTRO` scene, matching the visual style already working for Twitch compilations

**Risk Level:** MEDIUM
- New endpoint with VectCut API integration
- Reuses existing `nba_thumbnail_generator.html` logic (proven)
- Changes are additive (no deletions or refactors)
- Testing can be done standalone before assembly integration

---

## 2. AFFECTED FILES

**New Files:**
- None (adding endpoint to existing server.js)

**Modified Files:**
- `server.js` - Add helper function + POST endpoint (~100 lines total)
  - Helper function: `generateNbaIntroCard(gameId, teams, width, height)` around line 2500
  - POST endpoint: `/nba/generate-intro-card` after line 6000 (near other NBA endpoints)
- `HANDOVER.md` - Update Priority 1 task list (mark NBA card generation as ✅ Completed)

**Deleted Files:**
- None

---

## 3. IMPLEMENTATION STEPS

**Step 1: Create Helper Function `generateNbaIntroCard()`**
- **What:** Add async function that generates NBA intro card PNG
- **Where:** `server.js` around line 2500 (near other helper functions like `generateStreamerIntroCard()`)
- **Why:** Separates card generation logic from endpoint handler for reusability
- **Details:**
  - Accept parameters: `gameId`, `teams`, `width` (default 640), `height` (default 360)
  - Reuse existing `nba_thumbnail_generator.html` rendering logic
  - Use Puppeteer to screenshot at specified dimensions
  - Save to `output/nba_card_{gameId}.png`
  - Return `{cardPath, width, height, teams}`

**Step 2: Add POST Endpoint `/nba/generate-intro-card`**
- **What:** Create Express route handler
- **Where:** `server.js` after line 6000 (grouped with other NBA endpoints)
- **Why:** Allows assembly pipeline to request cards on-demand per game
- **Details:**
  - Accept JSON body: `{gameId, teams, width?, height?}`
  - Validate required fields (gameId, teams)
  - Call `generateNbaIntroCard()` helper
  - Return JSON: `{success: true, cardPath, width, height}` or error
  - Add error handling for Puppeteer failures

**Step 3: Update HANDOVER.md**
- **What:** Mark "Create NBA card generator endpoint" as ✅ Completed
- **Where:** `HANDOVER.md` line 68 (Priority 1 list)
- **Why:** Track implementation progress for next session

**Step 4: Test Standalone**
- **What:** Verify endpoint works before assembly integration
- **Where:** Terminal curl test
- **Why:** Catch issues early, avoid breaking assembly pipeline

---

## 4. AGENT ORCHESTRATION

| Task | Agent | Reason |
|------|-------|--------|
| Write helper function | Claude Code | Straightforward async function, <50 lines |
| Write POST endpoint | Claude Code | Standard Express route, <50 lines |
| Update HANDOVER.md | Cline | Documentation update, no code |
| Test visual output | Gemini Flash | Verify card matches brand standards (640×360, CWN Gold borders) |
| Review before commit | Cline | Present summary, get approval |

**Note:** Aider NOT needed
- Changes are localized (<100 lines total)
- server.js is large (6000+ lines) but edits are in distinct sections
- No refactoring of existing code
- Low risk of side effects

---

## 5. DEPENDENCIES & PREREQUISITES

**Required Before Starting:**
- [x] VectCut API running on port 9001 (confirmed via `curl http://localhost:9001/`)
- [x] `nba_thumbnail_generator.html` exists and works (confirmed in file list)
- [x] `VISUAL_LAYOUTS.LONG_FORM.OVERLAY_ZONE` defined in CONFIG (confirmed in HANDOVER.md)
- [x] Puppeteer installed (already in package.json)
- [x] Node API server running on port 3000

**External Dependencies:**
- **API:** VectCut API (http://localhost:9001) - for future overlay positioning
- **Services:** Node API server (port 3000) - for endpoint hosting
- **Files:** `nba_thumbnail_generator.html` - template for card rendering

**Environment Variables:**
- `VECTCUT_API_URL` - already set to http://localhost:9001 (per HANDOVER.md)

---

## 6. TESTING APPROACH

**How to Verify:**

**Test 1: Endpoint Responds**
```bash
curl -X POST http://localhost:3000/nba/generate-intro-card \
  -H "Content-Type: application/json" \
  -d '{"gameId":"test123","teams":"Celtics vs Hawks"}'
```
**Expected:** `{success: true, cardPath: "output/nba_card_test123.png", width: 640, height: 360}`

**Test 2: PNG File Created**
```bash
ls -lh output/nba_card_test123.png
```
**Expected:** File exists, size >10KB

**Test 3: Verify Dimensions**
```bash
file output/nba_card_test123.png
```
**Expected:** PNG image data, 640 x 360

**Test 4: Visual Inspection**
```bash
open output/nba_card_test123.png
```
**Expected:** TV-shaped card with game info, CWN Gold branding

**Manual Testing:**
- Dashboard: Not needed yet (assembly integration comes later)
- API: Check server logs for Puppeteer timing
- Browser: Open PNG, verify it matches Twitch intro card style

---

## 7. ROLLBACK PLAN

**If Something Goes Wrong:**

**Scenario 1: Endpoint throws errors**
1. Check server logs for stack trace
2. Verify VectCut API is running: `curl http://localhost:9001/`
3. Test `nba_thumbnail_generator.html` manually in browser
4. If unfixable: `git reset --hard HEAD` (changes not committed yet)

**Scenario 2: PNG dimensions wrong**
1. Adjust Puppeteer viewport settings in helper function
2. Re-test with curl
3. No rollback needed (iterative fix)

**Scenario 3: Breaks existing NBA endpoints**
1. Unlikely (changes are additive)
2. If happens: `git reset --hard HEAD`
3. Restart Node server: `nodemon server.js`

**Safe Points:**
- Git commit before: Current HEAD (8256b61bad3391055ca845f5335ea90c7ee43267)
- Backup files: Not needed (no deletions, changes are additive)
- VectCut API: Independent service, won't be affected

---

## 8. COMMIT STRATEGY

**Commit Message:**
```
feat: add NBA intro card generation endpoint

Enables long-form NBA videos to display 640×360 TV-shaped game thumbnails
at each GAME#_[TEAMS]_INTRO scene. Integrates with VectCut API for overlay
positioning in future assembly pipeline updates.

Part of Phase 2 implementation (IMPLEMENTATION_SPEC.md).

Changes:
- Added generateNbaIntroCard() helper function (server.js:2500-2580)
- Added POST /nba/generate-intro-card endpoint (server.js:6100-6150)
- Updated HANDOVER.md Priority 1 checklist
```

**Files to Stage:**
```bash
git add server.js
git add HANDOVER.md
```

**Files to Exclude:**
- `.env` (never commit - per AIDER_COMMIT_CHECKLIST.md)
- `output/` (never commit - contains generated files)
- `tmp/` (never commit - temporary files)
- `output/nba_card_test123.png` (test file, not production)

**Pre-Commit Checklist (per AIDER_COMMIT_CHECKLIST.md):**
- [x] Re-read `CLAUDE.md` - confirmed rules followed
- [x] Changes match requested task only - yes, NBA card endpoint only
- [x] No secrets/credentials committed - none added
- [x] Preserve existing user changes - no unrelated edits
- [x] Run relevant checks - curl tests passed
- [x] Clear commit message - focused on "why" (enable NBA intro cards)
- [x] Verify git status clean - only server.js and HANDOVER.md staged

---

## POST-IMPLEMENTATION SUMMARY

(This section will be filled out AFTER implementation is complete)

**What Actually Changed:**
- [To be filled after implementation]

**Deviations from Plan:**
- [To be filled if implementation differs from plan]

**Testing Results:**
- [To be filled with actual test output]

**Ready to Commit:**
- [To be confirmed by Rob]

---

## NOTES FOR ROB

**Why This Approach:**
- Reuses proven `nba_thumbnail_generator.html` logic (no reinventing)
- Keeps endpoint simple and testable standalone
- Doesn't touch assembly pipeline yet (safe, incremental)
- Matches existing Twitch intro card pattern (consistency)

**What Comes Next (After This):**
1. Test this endpoint standalone ✅
2. Integrate into `/assemble` endpoint (separate task)
3. Add News article scraper endpoint (similar pattern)
4. Update Gate 3 QA to check for intro cards

**Questions Before I Proceed:**
1. Should the card dimensions be configurable, or always 640×360?
2. Do you want the endpoint to return the PNG as a file download, or just the path?
3. Should I add caching (e.g., don't regenerate if card already exists for gameId)?

**Estimated Time:**
- Implementation: 20-30 minutes
- Testing: 10 minutes
- Total: ~40 minutes

---

**Ready to proceed? Please approve or suggest changes.**
