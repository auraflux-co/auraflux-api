#!/bin/bash
# .cursor/hooks/serena-commit-qa.sh
#
# Fires after every Shell tool use (postToolUse, matcher: Shell).
# When the command was a git commit, injects additional_context that
# instructs the agent to run the Serena post-commit QA checklist.
#
# failClosed: true — if this script errors, commits are blocked.
# That is intentional: a broken hook means QA is silently skipped,
# which is worse than a blocked commit.
#
# Input JSON shape (postToolUse):
#   { "tool": "Shell", "input": { "command": "..." }, "output": {...} }

set -euo pipefail

# ── Smoke-test dependencies ────────────────────────────────────────────────────
# jq is required to parse the tool input JSON.
# Fail loudly if it is missing so the problem is obvious immediately.
if ! command -v jq >/dev/null 2>&1; then
  echo '{"error": "serena-commit-qa.sh: jq is not on PATH — install jq (brew install jq) to enable Serena post-commit QA"}' >&2
  exit 1
fi

# ── Parse input ────────────────────────────────────────────────────────────────
input=$(cat)

# Validate that stdin was valid JSON (not empty / malformed)
if ! echo "$input" | jq -e . >/dev/null 2>&1; then
  # Silently pass through — hook received non-JSON (shouldn't happen, but fail open here)
  echo '{}'
  exit 0
fi

# Extract the shell command from the tool input
command=$(echo "$input" | jq -r '.input.command // ""')

# ── Trigger only on git commit ─────────────────────────────────────────────────
# Matches: git commit -m "...", git commit --amend, etc.
# Does NOT match: git commit --dry-run (no actual commit)
if echo "$command" | grep -qE '^git commit' && ! echo "$command" | grep -q '\-\-dry-run'; then
  cat <<'EOF'
{
  "additional_context": "A git commit just completed. You MUST run the Serena post-commit QA checklist before continuing (defined in serena-pr-review.mdc → Post-commit QA section). Steps: (1) call initial_instructions to warm the Serena index, (2) run git diff HEAD~1 --name-only to get changed files, (3) call get_symbols_overview on each changed file, (4) check for terminology violations ('gate N' in new code), (5) check for branding violations (cwn/c0/clipzworld in app/ directory), (6) verify new portal extension runWorker functions call isFeatureEnabled, (7) verify new lib/routes/*.js files are mounted in server.js, (8) verify new lib/ modules have a test/*.test.js counterpart, (9) check .env.example for any new process.env.* references. Output a QA summary report before proceeding."
}
EOF
else
  echo '{}'
fi
