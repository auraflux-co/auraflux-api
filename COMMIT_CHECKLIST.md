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

**Last Updated**: 2026-04-09
**Maintained by**: CWN Production Team
