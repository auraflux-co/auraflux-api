# AI Commit Checklist

**Purpose**: Help AI tools (Aider, Cline, etc.) create informative commits that make Claude Code's validation work easier.

**Applies to**: All AI coding assistants that create git commits in this repository.

---

## ⛔ HARD REQUIREMENT — STATUS.md Must Be Updated

**This is not optional. A pre-commit hook will block your commit if you skip this.**

Before every commit that changes code (`.js`, `.html`, `.py`, `.json`, `.sh`):

1. Open `STATUS.md`
2. Update the **`🤖 Last Agent Action`** table — your agent name, task, files changed, timestamp
3. Update the **Phase Progress** table if a phase status changed
4. Update the **`Last Updated`** date at the top of the file
5. `git add STATUS.md` before committing

**To bypass** (use only for docs-only commits or emergencies):
```bash
git commit --no-verify -m "docs: ... [skip STATUS — docs only]"
```
Always document WHY you bypassed in the commit message.

---

## Pre-Commit Checklist

### 0. Update ALL Referencing .md Docs First ⚠️
- [ ] Before staging anything, search for `.md` files that mention the files you changed
- [ ] Update every doc where the work is listed, described, or referenced
- [ ] Common docs to check: `STATUS.md`, `CLAUDE.md`, `OVERNIGHT_TASKS.md`, `SERVER_SPLIT_PLAN.md`, `README.md`, `MORNING_BRIEFING.md`
- [ ] The pre-commit hook will **warn** you about docs you may have missed (5-second pause)
- [ ] Example: if you change `server.js`, check every `.md` that mentions `server.js` line numbers, architecture, or functions

**Why:** Other agents (Aider, Claude Code, Cline) read these docs at session start. Stale docs = agents working from wrong assumptions.

### 1. Descriptive Commit Messages with File Locations
- [ ] Include specific file paths and line numbers where changes were made
- [ ] Example: `fix: add .replace(/\s+/g, '_') to scene headers (server.js:6231, server.js:6015)`
- [ ] NOT: `fix: implement multi-word name fix`

### 2. Reference Issue/Task Documentation
- [ ] Reference the task document that describes the issue being fixed
- [ ] Example: `fix: multi-word name bug in scene headers (URGENT_TEST_FAILURE_INVESTIGATION.md)`
- [ ] Include test case IDs if applicable: `Fixes Test 2 (37 scenes) and Test 4 (22 scenes)`

### 3. Break Large Changes into Logical Commits
- [ ] Separate refactors from bug fixes
- [ ] Separate test data changes from code changes
- [ ] Example sequence:
  1. `refactor: extract parseScriptIntoScenes to client/scriptParser.js`
  2. `fix: add underscore replacement to scene header generation`
  3. `test: update ExtraEmily → Emily in test_suite_12cases.json`

### 4. Update Documentation in Same Commit
- [ ] If you fix a bug documented in TODO.md or investigation docs, update those files
- [ ] Move completed tasks from "TODO" to "Recently Completed" sections
- [ ] Example: Include TODO.md update when landing the multi-word name fix

### 5. Add Code Comments Referencing Fixes
- [ ] Add inline comments near the fix explaining WHY the change was needed
- [ ] Reference the investigation document
- [ ] Example:
  ```javascript
  // Fix for multi-word names (URGENT_TEST_FAILURE_INVESTIGATION.md)
  // Convert spaces to underscores to prevent Gemini header parsing failures
  const headerName = displayName.toUpperCase().replace(/\s+/g, '_');
  ```

### 6. Use Conventional Commit Format
- [ ] `fix:` for bug fixes
- [ ] `feat:` for new features
- [ ] `refactor:` for code restructuring
- [ ] `test:` for test changes
- [ ] `docs:` for documentation-only changes
- [ ] `chore:` for build/tooling changes

### 7. Include Before/After for Complex Refactors
- [ ] When extracting large amounts of code, explain the structure change
- [ ] Example:
  ```
  refactor: extract script generation to client modules
  
  BEFORE: server.js (4,870 lines) - all logic inline
  AFTER: 
    - server.js (828 lines) - route handlers only
    - client/scriptParser.js - parseScriptIntoScenes
    - client/promptBuilder.js - Gemini prompt construction
  
  No functional changes, purely organizational.
  ```

---

## Quick Reference Templates

### Bug Fix Commit
```
fix: <short description> (<file>:<line>)

Fixes <issue description from investigation doc>

Changes:
- <file>:<line> - <specific change>
- <file>:<line> - <specific change>

Validates: <test case IDs that should now pass>

References: <investigation doc filename>
```

### Refactor Commit
```
refactor: <short description>

BEFORE: <old structure>
AFTER: <new structure>

No functional changes.

Files affected:
- <file> (deleted <N> lines)
- <file> (created, <N> lines)
```

### Test Data Change Commit
```
test: <description of test data change>

Changes:
- <test file>:<line> - <what changed>

Reason: <why this test data needed to change>

References: <investigation doc if applicable>
```

---

## Commit Message Template

```
<type>: <summary> (<file>:<line>)

<Detailed description of what changed and why>

Changes:
- <file>:<line> - <change description>
- <file>:<line> - <change description>

<Optional sections>:
Validates: <test cases that should pass>
References: <investigation docs>
Breaking changes: <if any>
Migration notes: <if needed>
```

---

## Why This Matters

When Claude Code validates Aider's work, having detailed commit messages helps:

1. **Understand what changed without re-reading entire files** (especially after refactors)
2. **Verify the fix matches the investigation** (can cross-reference line numbers)
3. **Know which tests to re-run** (test case IDs in commit message)
4. **Update project documentation** (TODO.md, investigation docs) accurately
5. **Debug if tests still fail** (clear before/after state)

---

## Common Mistakes to Avoid

❌ **Vague commits**: `fix: update server.js`
✅ **Specific commits**: `fix: add .replace(/\s+/g, '_') to Twitch scene headers (server.js:6231)`

❌ **Missing context**: `refactor: extract code`
✅ **Full context**: `refactor: extract parseScriptIntoScenes to client/scriptParser.js (server.js:6231 → client/scriptParser.js:1)`

❌ **No test validation**: `fix: scene header bug`
✅ **Test validation**: `fix: scene header bug - validates Test 2 (37 scenes) and Test 4 (22 scenes)`

❌ **Missing documentation updates**: Fixing a bug but not updating TODO.md or investigation docs
✅ **Complete commits**: Include TODO.md status update when landing a documented fix

---

## Example: Multi-Word Name Bug Fix (Ideal Commit Sequence)

### Commit 1: Test Data Fix
```
test: fix ExtraEmily → Emily in test suite (test_suite_12cases.json:48)

Changed Test 2 streamer #5 displayName from "ExtraEmily" to "Emily"
to match actual Twitch display name.

Validates: Test 2 baseline expectations

References: URGENT_TEST_FAILURE_INVESTIGATION.md (Fix #3)
```

### Commit 2: Code Fix (Twitch)
```
fix: add underscore replacement to Twitch scene headers (server.js:6231)

Multi-word streamer names like "Jay Cinco" were generating scene headers
with spaces (=== JAY CINCO_INTRO ===), breaking Gemini's header parsing.

Changes:
- server.js:6231 - Added .replace(/\s+/g, '_') to name normalization
- Added inline comment referencing investigation doc

Validates: Test 2 (37 scenes expected)

References: URGENT_TEST_FAILURE_INVESTIGATION.md (Fix #1)
```

### Commit 3: Code Fix (NBA)
```
fix: add underscore replacement to NBA scene headers (server.js:6015)

Multi-word team names like "Trail Blazers" were generating scene headers
with spaces (=== GAME4_JAZZ_TRAIL BLAZERS_INTRO ===), breaking Gemini's
header parsing.

Changes:
- server.js:6015 - Added .replace(/\s+/g, '_') to team name normalization
- Added inline comment referencing investigation doc

Validates: Test 4 (22 scenes expected)

References: URGENT_TEST_FAILURE_INVESTIGATION.md (Fix #2)
```

### Commit 4: Documentation Update
```
docs: mark multi-word name bug fix complete (TODO.md)

Moved multi-word name bug from "High Priority (URGENT - BLOCKING)"
to "Recently Completed" section.

All 3 fixes validated:
- Fix #1: Twitch scene headers (server.js:6231) ✅
- Fix #2: NBA scene headers (server.js:6015) ✅
- Fix #3: Test data correction (test_suite_12cases.json:48) ✅

Ready for test suite re-run (expecting 12/12 pass).
```

---

## After Committing — Push to GitHub

**`git commit` only saves locally. GitHub is not updated until you push.**

```bash
git push origin main
```

Run this at the end of every work session. There is no queue — GitHub updates instantly on push.

**Quick full deploy sequence:**
```bash
git add -A
git commit -m "your message"
git push origin main
```

---

## After Pushing — Restart Node.js (if server.js changed)

**`server.js` changes are NOT live until the server restarts.**

If you changed `server.js` (or any file it `require()`s like `lib/config.js`, `lib/logger.js`, `lib/metrics.js`):

```bash
# If running with nodemon (auto-restarts on file save — already handled):
nodemon server.js

# If running with plain node, kill and restart manually:
pkill -f "node server.js" && node server.js

# Or if nodemon is already running, just touch the file to trigger reload:
touch server.js
```

**When to restart:**
- ✅ Always after committing `server.js` changes
- ✅ Always after committing changes to `lib/` modules
- ⏭️ Skip if only `.md`, `.html`, or `data/` files changed (no server restart needed)

> **Note:** nodemon (configured in `nodemon.json`) watches `server.js` and `lib/` automatically — if you're running `nodemon server.js`, it will restart itself on save. A manual restart is only needed if you're running plain `node server.js`.

---

## ⚠️ Atomic Staging (Multi-Agent Concurrency Rule)

**When multiple agents (Claude Code, Cline, Aider) may be committing concurrently, staging and committing MUST happen as a single atomic operation. Never leave files staged between tool calls.**

### Why this matters

The git index is shared global state. If Agent A stages `fileA.md` and then Agent B runs `git commit` for their own work before Agent A commits, Agent B's commit will sweep in Agent A's staged files under Agent B's commit message. The result: mislabeled commits in git history, and Agent A's commit silently fails with no clear error.

### The rule

✅ **Atomic — safe:**
```bash
git add file1.md file2.md file3.md && git commit -m "..."
```

❌ **Non-atomic — risky in multi-agent sessions:**
```bash
git add file1.md file2.md file3.md
# ... any other tool call or delay here opens a race window ...
git commit -m "..."
```

### Practical guidance

1. **Chain `git add` and `git commit` with `&&`** in a single `Bash` tool call. Don't split them across tool calls when other agents are active.
2. **Stage by explicit file list**, never `git add -A` or `git add .` — concurrent edits from another agent will hitchhike.
3. **Before staging, run `git status` in the same tool call** to verify nothing unexpected is already in the index: `git status --short && git add <files> && git commit -m "..."`
4. **If you see another agent's files in the staged set**, use `git restore --staged <their-file>` to unstage before committing. But be aware that this itself opens a race window — the other agent may re-stage their work mid-operation.
5. **Watch the commit hash in reflog after committing.** If `git reflog -3` doesn't show your commit at `HEAD@{0}`, your commit was stolen — investigate immediately rather than retrying blindly.
6. **Retry strategy for lost commits**: Do NOT retry the same `git commit` blindly. First run `git log --stat HEAD~5..HEAD` to see if your files landed under a different agent's commit message. If they did, consider a follow-up clarification commit (rather than reverting and re-committing, which risks another collision).

### Historical incident (2026-04-10)

Claude Code was writing a docs-sync commit (`CLAUDE.md`, `.gitignore`, `ROLLBACK_FORCE_ADVANCE_SPEC.md`, archived handoffs, `scripts/claude_consult.sh`). Cline was concurrently committing a one-line fix to `cwn_production.html` (`generateVideo()` title payload). The timeline:

1. Claude Code ran `git add <6 files>` as one Bash call
2. Claude Code ran `git commit -m "..."` as a separate Bash call
3. Between steps 1 and 2, Cline's `git commit` executed — picking up Claude Code's 6 staged files under Cline's message "fix: pass title to HeyGen API in generateVideo()"
4. Cline's actual `cwn_production.html` change was NOT committed (still unstaged as of this writing)
5. Result: commit `6ce68c4` has a misleading message; Claude Code had to add a follow-up `54650ed` clarifying the mislabeling in STATUS.md

**Root cause:** Non-atomic `git add` + `git commit`. If Claude Code had chained them with `&&` in a single Bash tool call, the race window would not have existed.

**See:** STATUS.md Last Agent Action rows 51-53 for the full postmortem.

---

## Hook Install / Update

The pre-commit hook is tracked at `scripts/pre-commit.sh`. If you're on a fresh clone or the hook was updated:

```bash
cp scripts/pre-commit.sh .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
```

**Last Updated**: 2026-04-10 (added Atomic Staging rule after concurrent-commit incident)
**Maintained by**: CWN Production Team
