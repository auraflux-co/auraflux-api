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

if ! command -v jq >/dev/null 2>&1; then
  echo '{"error": "serena-commit-qa.sh: jq is not on PATH — install jq (brew install jq) to enable Serena post-commit QA"}' >&2
  exit 1
fi

input=$(cat)

if ! echo "$input" | jq -e . >/dev/null 2>&1; then
  echo '{}'
  exit 0
fi

command=$(echo "$input" | jq -r '.input.command // ""')

if echo "$command" | grep -qE '^git commit' && ! echo "$command" | grep -q '\-\-dry-run'; then
  # Default cwn-production when hook runs from this repo; cwn-c0 when cwd is ~/cwn-c0
  repo_root=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
  if [[ "$repo_root" == *"/cwn-c0" ]]; then
    project='cwn-c0'
  else
    project='cwn-production'
  fi

  cat <<EOF
{
  "additional_context": "A git commit just completed. You MUST run the Serena post-commit QA checklist before continuing (serena-pr-review.mdc). Steps: (1) initial_instructions, (2) activate_project(\\"${project}\\"), (3) git diff HEAD~1 --name-only, (4) get_symbols_overview on each changed file, (5) terminology ('gate N' in new code), (6) branding (cwn/c0/clipzworld in app/), (7) isFeatureEnabled in new portal extension runWorker, (8) new lib/routes/*.js mounted in server.js, (9) new lib/ modules have test/*.test.js, (10) new process.env.* in .env.example. Output the QA summary report before proceeding."
}
EOF
else
  echo '{}'
fi
