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
  "additional_context": "A git commit just completed. Run Serena post-commit QA (serena-pr-review.mdc). (1) initial_instructions, (2) activate_project for THIS repo — cwn-c0 if cwd/path is ~/cwn-c0, else cwn-production, (3) git diff HEAD~1 --name-only, (4) get_symbols_overview + find_symbol on each changed code file, (5) terminology/branding/feature-gate/route/test/env checks per serena-pr-review.mdc. Output QA summary before proceeding."
}
EOF
else
  echo '{}'
fi
