# Cline Custom Instructions — paste this into Cline/Roo Code → Settings → Custom Instructions

## RULE 1 — Shell commands (CRITICAL — read every task)

EXIT CODE 1 = infinite retry loop. No exceptions:

- Every grep, find, rg, ag, ls MUST end with `|| true`
- `grep -n "foo" file.js || true` ← correct
- `grep -n "foo" file.js` ← WRONG
- If you see "Retrying... attempt 2/3" — you missed a `|| true`, stop and fix it

## RULE 2 — Never read large files in full

- Never open server.js, cwn_production.html, or any lib/ file without grepping first
- grep -n to find target lines → read only ±50 lines around the match

## RULE 3 — Scope

- Only edit files listed in the handoff's "Files to change" table
- Do not explore or read files outside your assigned domain

## RULE 4 — Before every commit

- Update STATUS.md → "🤖 Last Agent Action" table
- Never commit .env, output/, tmp/, data/jobs.json, or credential files

## RULE 5 — Task start sequence

1. Read BRANCH_NOTES.md (if it exists on the branch)
2. Read CLAUDE.md
3. Read STATUS.md
4. Read AGENT_FILE_REGISTRY.md
5. Then begin work
