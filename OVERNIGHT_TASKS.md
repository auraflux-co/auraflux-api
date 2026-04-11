# CWN Overnight Task Schedule

**Window:** 1:00 AM – 7:00 AM Eastern (daily)
**Agent:** Aider (gemini/gemini-2.5-pro)
**Output:** Morning briefing written to `MORNING_BRIEFING.md` after each run
**Status:** ⚠️ PARTIAL PAUSE (2026-04-11) — see banner below

---

## ⚠️ 2026-04-11 OVERNIGHT PAUSE — Cline is actively working on server.js and cwn_production.html

**Do NOT** run any Aider task tonight (2026-04-11 → 2026-04-12) that touches:
- `server.js`
- `cwn_production.html`
- `lib/config.js`
- `.env`

**Reason:** Cline is implementing the Gate 2 Self-Healing Pipeline (Phase 1) overnight. See `CLINE_HANDOFF_GATE2_SEGMENT_STRUCTURE.md` for the full scope. Cline will touch all of the files listed above in a single atomic commit. If Aider touches any of them concurrently, we will get another concurrent-commit incident like the one on 2026-04-10 (commit `6ce68c4` mislabeling — see COMMIT_CHECKLIST.md Atomic Staging rule).

**Aider SAFE tasks for this overnight window:**
- Documentation updates (any `.md` file EXCEPT the handoff docs actively in use)
- `lib/error_logger.js` enhancements (isolated from Cline's scope)
- `.env.example` (new file, no conflict)
- Any pure text / prompt engineering work that doesn't touch JavaScript
- `data/cwn_style_guides.json` updates if any queued

**Aider BLOCKED tasks for this overnight window:**
- [~] Server.js Module Split (next: lib/streamers.js) — PAUSE until Cline finishes Gate 2
- [ ] Phonetic Auto-Injection from streamers.json — PAUSE (touches HeyGen send logic in server.js)
- [ ] Input Validation & Sanitization — PAUSE (touches server.js POST endpoints)
- [ ] Rate Limiting per Endpoint — PAUSE (touches server.js)
- [ ] Remove Duplicate `/generate-thumbnail` Route — PAUSE (touches server.js)
- [ ] Fix Legacy Publish Stub Routes — PAUSE (touches server.js)

**Resume normal schedule:** Once Cline commits the Gate 2 implementation (expected morning of 2026-04-11 or early afternoon), the pause lifts. Rob or Claude Code will remove this banner.

**If Aider has already started a server.js task tonight before this banner was added:** abort the task, revert any uncommitted changes, note it in MORNING_BRIEFING.md, and move to a SAFE task instead.

---

**Normal Status:** APPROVED — all tasks cleared to run during overnight window (restores after pause lifts)

---

## How the Overnight System Works

1. `launchd` triggers `scripts/overnight_runner.sh` at 1:00 AM daily (macOS scheduler)
2. The runner script starts Aider non-interactively with `--message` — no terminal needed
3. Aider reads this file, picks the first `[ ]` task, works on it, commits, and pushes
4. After completing, Aider updates `MORNING_BRIEFING.md` with what changed
5. When Rob/Claude/Cline start their day, they read `MORNING_BRIEFING.md` first

**Morning startup command:**
```bash
# Read this first every morning before touching anything
cat MORNING_BRIEFING.md
```

## Automation Setup (One-Time Install)

```bash
# Install the launchd scheduler (runs overnight_runner.sh at 1am daily)
cp scripts/com.cwn.overnight.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.cwn.overnight.plist

# Verify it's loaded
launchctl list | grep cwn
```

**To check if it ran:** `cat logs/overnight_$(date +%Y-%m-%d).log`
**To run manually right now:** `bash scripts/overnight_runner.sh`
**To stop/uninstall:** `launchctl unload ~/Library/LaunchAgents/com.cwn.overnight.plist`

**Important:** Your Mac must be awake at 1am for launchd to fire. If it's asleep, the job runs the next time the Mac wakes up after 1am. Keep the Mac plugged in and awake overnight (or use `pmset` to schedule a wake).

---

## Aider Task Queue

Tasks are listed in priority order. Aider works through them top-to-bottom each night.
Mark `[x]` when complete. Add new tasks at the bottom with a date.

### 🟢 APPROVED — Ready to Run (1am-7am ET)

#### [~] server.js Module Split — IN PROGRESS
**Priority:** High — reduces context limit issues for all agents
**Estimate:** 2-3 modules per night × 5 nights
**Why overnight:** Safe to do when no one is actively using the server
**Phase 1 DONE (Cline, 2026-04-09):** lib/config.js, lib/logger.js, lib/metrics.js extracted ✅
**Next:** lib/streamers.js (item 4 in SERVER_SPLIT_PLAN.md)
**What Aider does each night:**
- Extract 2-3 modules per the order in SERVER_SPLIT_PLAN.md (start at item 4)
- Run `node --check server.js` after each extraction
- Update SERVER_MAP.md with new function locations
- Commit each module separately with clear message
- Write summary to MORNING_BRIEFING.md

### 🟡 QUEUED — Ready When Module Split Reduces Context

These tasks were identified by Aider but couldn't be completed due to the server.js context limit error. Once the module split reduces server.js size, these become executable.

#### [ ] Input Validation & Sanitization (Security)
**File:** `server.js` → after split: `lib/routes/*.js`
**What:** Add `express-validator` checks to all POST endpoints
**Specific endpoints needing validation:**
- `/assemble` — validate `asmId`, `segments[]`, `contentType`, `formType`
- `/generate-full-script` — validate `type`, `items[]`, `formType`
- `/publish` — validate `driveUrl`, `platforms[]`, `title`
- `/generate-thumbnail` — validate `contentType`, `streamers[]`
**Risk:** Low — additive only, doesn't change existing logic
**Estimate:** 2 hours

#### [ ] Rate Limiting per Endpoint
**File:** `server.js` → after split: `lib/routes/*.js`
**What:** Add `express-rate-limit` middleware
**Limits:**
- `/generate-full-script`: 10 req/min (Gemini cost protection)
- `/assemble`: 5 req/min (FFmpeg resource protection)
- `/publish`: 20 req/min (Upload-Post API protection)
- `/generate-thumbnail`: 30 req/min
- All others: 60 req/min default
**Risk:** Low — additive middleware
**Estimate:** 1 hour

#### [ ] Structured Logging Enhancement
**File:** `lib/error_logger.js`
**What:** Add log levels (DEBUG/INFO/WARN/ERROR), request IDs, and duration tracking
**Current state:** Basic JSON logging exists, needs levels + correlation IDs
**Risk:** Low — lib/error_logger.js is small and isolated
**Estimate:** 1 hour

#### [ ] Remove Duplicate `/generate-thumbnail` Route
**File:** `server.js` lines 9242 and 9575 — TWO routes with same path
**What:** The second definition (line 9575) silently overrides the first (line 9242)
**Fix:** Audit both, keep the correct one, remove the duplicate
**Risk:** Medium — need to verify which one is actually being used
**Estimate:** 30 min

#### [ ] Fix Legacy Publish Stub Routes
**File:** `server.js` lines 7539–7705
**What:** `/publish/youtube`, `/publish/tiktok`, `/publish/instagram` are stubs that just call `/publish`
**Fix:** Either remove them (if dashboard doesn't use them) or document they're intentional
**Risk:** Low — stubs only, no logic
**Estimate:** 30 min

#### [x] Add `.env.example` File
**File:** New `.env.example`
**What:** Document all required env vars with placeholder values (no real keys)
**Why:** New agents/sessions don't know what's needed without reading CLAUDE.md
**Risk:** None — new file only
**Estimate:** 20 min

#### [ ] Phonetic Auto-Injection from streamers.json
**File:** `server.js` (HeyGen send function)
**What:** Read `phonetic` field from `streamers.json` at script gen time, auto-inject into HeyGen `input_text`
**Why:** Currently manual — Bobby G mispronounces names that have phonetic entries
**Risk:** Medium — touches HeyGen send logic
**Estimate:** 1 hour
**Blocked by:** Scene count fix must be validated first ✅ (done)

---

### ✅ COMPLETED OVERNIGHT TASKS

_(None yet — system not yet active)_

---

## Aider Session Instructions

When Aider runs overnight, it should:

1. **Read these files first** (already in `.aider.conf.yml` read list):
   - `CLAUDE.md`
   - `STATUS.md`
   - `COMMIT_CHECKLIST.md`
   - `QA_GATES.md`

2. **Pick the top non-blocked task** from the QUEUED section above

3. **Work on ONE task only** — don't try to do multiple in one session

4. **⚠️ Context Limit Rules (CRITICAL — read before adding any files)**

   Sonnet's context limit is 200k tokens. `server.js` alone is ~150k tokens.
   Violating these rules causes `input length + max_tokens > 200000` errors.

   **For tasks that DON'T touch server.js** (new files, small lib files):
   - Add only the specific file(s) needed
   - Do NOT add server.js to the chat
   - Example: `.env.example`, `lib/error_logger.js`

   **For tasks that DO touch server.js:**
   - Start aider with: `aider server.js` (map-tokens 0 is set globally in .aider.conf.yml)
   - Gemini 2.5 Pro has a 1M token context window — server.js fits comfortably
   - Do NOT add any other large files to the chat
   - If you still hit the limit, use `/drop` to remove read-only files

   **If you hit a context error mid-session:**
   - Run `/drop` to remove all files
   - Re-add only the single file you need
   - If still too large, note it in `MORNING_BRIEFING.md` and skip to next task

5. **After completing:**
   - Run `node --check server.js` (or the affected file)
   - Commit with a clear message
   - Update `STATUS.md` → `🤖 Last Agent Action` table (required by pre-commit hook)
   - Update `MORNING_BRIEFING.md` (see template below)
   - Mark task `[x]` in this file

6. **If anything goes wrong:**
   - Do NOT commit broken code
   - Write the error to `MORNING_BRIEFING.md` under "⚠️ Issues"
   - Leave the code unchanged

---

## Morning Briefing Template

Aider writes this file after each overnight run. See `MORNING_BRIEFING.md`.

```markdown
# Morning Briefing — [DATE]

**Overnight Run:** [START TIME] – [END TIME] ET
**Tasks Attempted:** [N]
**Tasks Completed:** [N]
**Commits Made:** [N]

## ✅ What Was Done

### [Task Name]
- What changed: [plain English description]
- Files modified: [list]
- Commit: [hash] — [message]
- Test result: [node --check passed / server started / etc]

## ⚠️ Issues (if any)

### [Issue description]
- What happened: [description]
- Files affected: [list]
- Status: [reverted / left as-is / needs manual review]

## 🔍 Things to Verify Today

- [ ] [Specific thing to check]
- [ ] [Specific thing to check]

## 📋 Next Overnight Queue

Next tasks scheduled:
1. [Task name]
2. [Task name]
```

---

## Scheduling Notes

- **Do not run overnight tasks** if a production job is in progress (check `output/` for recent MP4s)
- **Do not run server.js split** until all agents have been notified and paused feature work
- **Aider should exit cleanly** by 6:45 AM ET to leave buffer before workday starts
- **If Aider hits context limit** — skip that task, note it in MORNING_BRIEFING.md, move to next task
