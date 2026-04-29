#!/bin/bash
# .cursor/hooks/serena-commit-qa.sh
#
# Fires after every Shell tool use (postToolUse, matcher: Shell).
# When the command was a git commit, injects additional_context that
# instructs the agent to run the Serena post-commit QA checklist.
#
# Input JSON shape (postToolUse):
#   { "tool": "Shell", "input": { "command": "..." }, "output": {...} }

set -euo pipefail

input=$(cat)

# Extract the shell command from the tool input
command=$(echo "$input" | jq -r '.input.command // ""' 2>/dev/null || echo "")

# Only act on git commit calls (not git commit --amend, not git status, etc.)
if echo "$command" | grep -qE '^git commit'; then
  cat <<'EOF'
{
  "additional_context": "A git commit just completed. Run the Serena post-commit QA checklist now (serena-pr-review.mdc → Post-commit QA section). Steps: (1) call initial_instructions to warm the Serena index, (2) get_symbols_overview on each changed file from git diff HEAD~1 --name-only, (3) check for 'gate' terminology violations in new code, (4) check for CWN/C0/clipzworld branding in app/ directory, (5) verify new portal extension runWorker functions call isFeatureEnabled, (6) verify new lib/routes/*.js files are mounted in server.js, (7) verify new lib/ modules have a test/*.test.js counterpart, (8) check .env.example for any new process.env.* references. Report any issues found before continuing."
}
EOF
else
  echo '{}'
fi
