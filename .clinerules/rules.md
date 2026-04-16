# Cline Rules — cwn-production
# Read automatically at the start of every Cline task.

## ⚠️ CRITICAL — Shell command rules (read this first, every time)

**EXIT CODE 1 CAUSES INFINITE RETRY LOOPS. Follow these rules without exception:**

- ALWAYS append `|| true` to grep, find, rg, ag, ls — every search command, every time
- `grep -n "foo" file.js || true` ← correct
- `grep -n "foo" file.js` ← WRONG — will cause retry loop if no match
- This applies even mid-task when you think a match will definitely exist
- If you see "Retrying... attempt 2/3" you broke this rule — stop, fix the command, add || true

## File reading rules (prevents context overflow)
- Never read server.js, cwn_production.html, or any lib/ file in full
- Always grep -n first to find the target lines, then read only 50 lines around the match
- Example: `grep -n "handleAssemble" server.js || true` → then read ±50 lines

## Scope rules
- Only edit files explicitly listed in the handoff's "Files to change" table
- Do not explore or read files outside your assigned domain
- If a file is not in your handoff, do not touch it

## Before every commit
- Update STATUS.md → "🤖 Last Agent Action" table
- Commit only files listed in the handoff
- Never commit .env, output/, tmp/, data/jobs.json, or credential files

## On task start
- Read CLAUDE.md, STATUS.md, and AGENT_FILE_REGISTRY.md before any edits
- Check STATUS.md → "🔒 Active File Locks" before touching any Tier 1 or Tier 2 file
