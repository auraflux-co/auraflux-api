#!/usr/bin/env bash
# scripts/aider_session_review.sh
# Run at the end of a Cursor session to produce a structured Aider health report.
# Output: logs/aider_session_review.md
# Usage: bash scripts/aider_session_review.sh [--since <commit-sha>]
#
# Aider reads the codebase and recent commits, then writes a structured report
# covering: commit delta, structural integrity, C0/C1+ boundary, env vars,
# dead code, and Render deploy readiness.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPORT="$REPO_ROOT/logs/aider_session_review.md"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# --since can be a commit SHA or relative ref like HEAD~10
SINCE="${2:-}"
if [ "$1" = "--since" ] && [ -n "$2" ]; then
  SINCE="$2"
  shift 2
fi

# Default: commits since the last review marker in the report, or last 20
if [ -z "$SINCE" ]; then
  LAST=$(grep -m1 "<!-- last-reviewed-commit:" "$REPORT" 2>/dev/null | sed 's/.*: \(.*\) -->/\1/' || true)
  SINCE="${LAST:-HEAD~20}"
fi

HEAD_SHA=$(git -C "$REPO_ROOT" rev-parse HEAD)

echo "🔍 Running Aider session review..."
echo "   Since: $SINCE"
echo "   Head:  $HEAD_SHA"
echo "   Report: $REPORT"

# Build commit summary for the prompt
COMMIT_LOG=$(git -C "$REPO_ROOT" log --oneline "$SINCE..HEAD" 2>/dev/null || git -C "$REPO_ROOT" log --oneline -20)
CHANGED_FILES=$(git -C "$REPO_ROOT" diff --name-only "$SINCE..HEAD" 2>/dev/null | head -40 || echo "(unable to diff)")

PROMPT=$(cat <<PROMPT
You are performing an end-of-session structural health review of the AuraFlux API codebase.
Review the codebase and recent commits, then write a structured report to: logs/aider_session_review.md

## Recent commits reviewed
$COMMIT_LOG

## Files changed
$CHANGED_FILES

## Report structure (write ALL sections)

### 1. Commit Summary
Brief summary of what changed in this session (2-4 sentences).

### 2. Structural Integrity
- Do all new/modified route files in lib/routes/ correctly require their dependencies?
- Any missing requires, wrong relative paths (e.g. ./lib/ instead of ../ from inside lib/)?
- Any circular dependencies?
- Is server.js clean — only middleware setup, router mounts, and listen?

### 3. C0 / C1+ Boundary
- Any C0-only code (HeyGen, CapCut, Google Drive, NBA/Twitch scrapers) that crept into shared lib/ paths?
- Any C1+ paths that have hardcoded C0 branding (CWN, ClipzWorld, etc.)?

### 4. Environment Variables
- Any new process.env.XYZ references added that are NOT in .env.example?
- Any hardcoded secrets, API keys, or tokens in source files?

### 5. Dead Code
- Any functions/variables in server.js or lib/ that appear unreachable after recent route extractions?
- Any require() statements for modules that no longer exist or are no longer used?

### 6. Render Deploy Readiness
- Will the current code deploy cleanly to Render?
- Any issues: missing npm packages, bad file paths, process.exit() in wrong places, missing env var guards?

### 7. Recommendations
Prioritised list of follow-up actions (if any). Mark each: [BLOCKING] [SHOULD FIX] [NICE TO HAVE].

---
At the top of the file write:
<!-- last-reviewed-commit: $HEAD_SHA -->
<!-- reviewed-at: $TIMESTAMP -->

Be direct. If everything looks clean, say so clearly. Don't pad the report.
PROMPT
)

# Write the prompt to a temp file for aider
PROMPT_FILE=$(mktemp /tmp/aider_review_prompt.XXXXXX.md)
echo "$PROMPT" > "$PROMPT_FILE"

# Run aider in non-interactive mode
# --no-auto-commits: we don't want aider committing the report itself
# --message: single-shot prompt
# --yes: auto-accept all confirmations
cd "$REPO_ROOT"
aider \
  --no-auto-commits \
  --yes \
  --message "$(cat "$PROMPT_FILE")" \
  logs/aider_session_review.md \
  2>&1 | tee /tmp/aider_review_run.log

rm -f "$PROMPT_FILE"

if [ -f "$REPORT" ]; then
  echo ""
  echo "✅ Report written to $REPORT"
  echo "   First 5 lines:"
  head -5 "$REPORT"
else
  echo "⚠️  Report file not created — check /tmp/aider_review_run.log"
  exit 1
fi
