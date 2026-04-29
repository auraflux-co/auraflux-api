#!/usr/bin/env bash
# scripts/aider_session_review.sh
# End-of-session health review: pulls live state from Jira, GitHub, and Confluence,
# then runs Aider to produce a structured report at logs/aider_session_review.md
#
# Usage: bash scripts/aider_session_review.sh [--since <commit-sha>]
# Requires: aider, gh (GitHub CLI), curl, jq
# Env vars: JIRA_USER_EMAIL, JIRA_API_TOKEN, JIRA_BASE_URL (or loaded from .env)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_SLUG=$(git -C "$REPO_ROOT" remote get-url origin | sed -e 's|.*github.com[:/]\(.*\)\.git$|\1|' 2>/dev/null || echo "clipzworldnews/auraflux-api")
REPORT="$REPO_ROOT/logs/aider_session_review.md"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Load .env if not already set — only parse KEY=VALUE lines, skip comments and bare words
if [ -z "${JIRA_API_TOKEN:-}" ] && [ -f "$REPO_ROOT/.env" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    # Skip blank lines and comments
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    # Only process lines with KEY=VALUE format
    if [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then
      export "$line" 2>/dev/null || true
    fi
  done < "$REPO_ROOT/.env"
fi

# Support both JIRA_* and ATLASSIAN_* variable naming conventions
JIRA_API_TOKEN="${JIRA_API_TOKEN:-${ATLASSIAN_API_TOKEN:-}}"
JIRA_USER_EMAIL="${JIRA_USER_EMAIL:-${ATLASSIAN_EMAIL:-}}"
JIRA_BASE_URL="${JIRA_BASE_URL:-${ATLASSIAN_DOMAIN:-}}"

JIRA_BASE="${JIRA_BASE_URL:-}"
JIRA_BASE="${JIRA_BASE%/}"
JIRA_AUTH="${JIRA_USER_EMAIL:-}:${JIRA_API_TOKEN:-}"

# --since override
SINCE=""
if [ "${1:-}" = "--since" ] && [ -n "${2:-}" ]; then
  SINCE="$2"; shift 2
fi
if [ -z "$SINCE" ]; then
  LAST=$(grep -m1 "<!-- last-reviewed-commit:" "$REPORT" 2>/dev/null | sed 's/.*: \(.*\) -->/\1/' || true)
  SINCE="${LAST:-HEAD~20}"
fi

HEAD_SHA=$(git -C "$REPO_ROOT" rev-parse HEAD)

echo ""
echo "══════════════════════════════════════════════"
echo "  AuraFlux — End-of-Session Health Review"
echo "  $(date -u '+%Y-%m-%d %H:%M UTC')"
echo "══════════════════════════════════════════════"
echo ""

# ── 1. Git context ─────────────────────────────────────────────────────────────
echo "📦 Collecting git context..."
COMMIT_LOG=$(git -C "$REPO_ROOT" log --oneline "$SINCE..HEAD" 2>/dev/null | head -30 || git -C "$REPO_ROOT" log --oneline -20)
CHANGED_FILES=$(git -C "$REPO_ROOT" diff --name-only "$SINCE..HEAD" 2>/dev/null | head -50 || echo "(unable to diff)")
OPEN_BRANCHES=$(git -C "$REPO_ROOT" branch -r --no-merged main 2>/dev/null | grep -v HEAD | head -10 || echo "none")

# ── 2. Jira board state ─────────────────────────────────────────────────────────
echo "📋 Fetching Jira board state..."
JIRA_TODO=""
JIRA_IN_DEV=""
JIRA_IN_REVIEW=""
JIRA_APPROVED=""

if [ -n "${JIRA_API_TOKEN:-}" ]; then
  _jira_issues() {
    local status="$1"
    curl -s \
      -H "Accept: application/json" \
      -u "$JIRA_AUTH" \
      "${JIRA_BASE}/rest/api/3/search?jql=project=CPD+AND+status=%22${status}%22+ORDER+BY+priority+DESC&maxResults=20&fields=summary,priority,issuetype" \
      2>/dev/null | \
      python3 -c "
import json,sys
d=json.load(sys.stdin)
for i in d.get('issues',[]):
    f=i['fields']
    print(f\"  {i['key']}: {f['summary'][:80]} [{f['priority']['name']}]\")
" 2>/dev/null || echo "  (unable to fetch)"
  }
  JIRA_TODO=$(     _jira_issues "To+Do")
  JIRA_IN_DEV=$(   _jira_issues "In+Development")
  JIRA_IN_REVIEW=$(_jira_issues "In+Review")
  JIRA_APPROVED=$( _jira_issues "Approved")
else
  JIRA_TODO="(JIRA_API_TOKEN not set — skipped)"
fi

# ── 3. GitHub state ─────────────────────────────────────────────────────────────
echo "🐙 Fetching GitHub state..."
GH_OPEN_PRS=""
GH_FAILING_CI=""

if command -v gh &>/dev/null; then
  GH_OPEN_PRS=$(gh pr list --repo "$REPO_SLUG" --state open --json number,title,headRefName,statusCheckRollup \
    --jq '.[] | "  #\(.number) \(.title) [\(.headRefName)] — CI: \((.statusCheckRollup // []) | map(.conclusion) | unique | join(","))"' 2>/dev/null || echo "  (gh pr list failed)")
  GH_FAILING_CI=$(gh run list --repo "$REPO_SLUG" --status failure --limit 5 \
    --json displayTitle,headBranch,createdAt \
    --jq '.[] | "  \(.displayTitle) on \(.headBranch) at \(.createdAt)"' 2>/dev/null || echo "  none")
else
  GH_OPEN_PRS="(gh CLI not found)"
  GH_FAILING_CI="(gh CLI not found)"
fi

# ── 4. Confluence recent pages ──────────────────────────────────────────────────
echo "📄 Fetching recent Confluence activity..."
CONF_RECENT=""

if [ -n "${JIRA_API_TOKEN:-}" ]; then
  CONF_RECENT=$(curl -s \
    -H "Accept: application/json" \
    -u "$JIRA_AUTH" \
    "${JIRA_BASE/jira/wiki}/wiki/rest/api/content?spaceKey=CP&limit=5&orderby=modified&expand=version" \
    2>/dev/null | \
    python3 -c "
import json,sys
d=json.load(sys.stdin)
for p in d.get('results',[]):
    print(f\"  [{p.get('id')}] {p.get('title')} — v{p['version']['number']} by {p['version']['by'].get('displayName','?')}\")
" 2>/dev/null || echo "  (unable to fetch)")
else
  CONF_RECENT="(skipped — no API token)"
fi

# ── 5. Environment consistency ──────────────────────────────────────────────────
echo "🔑 Checking environment consistency..."
ENV_IN_CODE=$(grep -rh 'process\.env\.' "$REPO_ROOT/lib" "$REPO_ROOT/server.js" "$REPO_ROOT/scripts" "$REPO_ROOT/test" "$REPO_ROOT/bin" 2>/dev/null \
  | grep -oE 'process\.env\.[A-Z_]+' | sort -u | sed 's/process\.env\.//')
ENV_IN_EXAMPLE=$(grep -oE '^[A-Z_]+' "$REPO_ROOT/.env.example" 2>/dev/null | sort -u || echo "")
ENV_MISSING=$(comm -23 <(echo "$ENV_IN_CODE" | sort) <(echo "$ENV_IN_EXAMPLE" | sort) 2>/dev/null || echo "")

# ── 6. Build the Aider prompt ───────────────────────────────────────────────────
echo ""
echo "🤖 Running Aider review..."

# Clean up any stale temp files from previous runs
rm -f /tmp/aider_review_*

PROMPT_FILE=$(mktemp /tmp/aider_review_XXXXXX)

cat > "$PROMPT_FILE" <<ENDPROMPT
You are performing an end-of-session health review of the AuraFlux API platform.
Review the information below and write a structured report to logs/aider_session_review.md.

---

## SESSION GIT CONTEXT

Commits since last review:
${COMMIT_LOG:-none}

Files changed:
${CHANGED_FILES:-none}

Unmerged remote branches:
${OPEN_BRANCHES:-none}

---

## JIRA BOARD STATE

To Do (backlog):
${JIRA_TODO:-none}

In Development:
${JIRA_IN_DEV:-none}

In Review:
${JIRA_IN_REVIEW:-none}

Approved (awaiting merge):
${JIRA_APPROVED:-none}

---

## GITHUB STATE

Open PRs:
${GH_OPEN_PRS:-none}

Recent CI failures:
${GH_FAILING_CI:-none}

---

## CONFLUENCE RECENT ACTIVITY

Recently modified pages:
${CONF_RECENT:-none}

---

## ENVIRONMENT VARIABLES

Vars referenced in code but NOT in .env.example:
${ENV_MISSING:-none - all vars documented}

---

## REPORT STRUCTURE

Write ALL sections below. Be direct. If everything is clean, say so clearly.

### 1. Session Summary
What was done this session (2-4 sentences based on commits).

### 2. Jira Consistency
- Are any tickets stuck in unexpected states?
- Are In Development / In Review tickets matched to open GitHub PRs?
- Any tickets that should be Done based on merged commits but are not?
- Any gaps in the Epic to Story hierarchy?

### 3. GitHub Consistency
- Any open PRs with no corresponding Jira ticket in flight?
- Any CI failures that need attention?
- Any branches that should have been deleted after merge?

### 4. Confluence Consistency
- Are recent code changes reflected in Confluence docs?
- Any architecture/ops pages that look stale given what changed in code?
- Missing docs for new features or routes added this session?

### 5. Codebase Structural Integrity
- Do all route files in lib/routes/ correctly require their dependencies?
- Is server.js clean (middleware + router mounts only)?
- Any circular dependencies or bad relative paths?

### 6. C0 / C1+ Boundary
- Any C0-only code that crept into shared lib/ paths?
- Any hardcoded C0 branding in C1+ paths?

### 7. Environment and Secrets
- Any env vars in code missing from .env.example?
- Any hardcoded secrets or tokens?
- Any new features that need Render env vars before deploying?

### 8. Render Deploy Readiness
- Will the current main branch deploy cleanly?
- Any issues: missing packages, bad paths, missing env guards?

### 9. Recommendations
Prioritised list. Mark each: [BLOCKING] [SHOULD FIX] [NICE TO HAVE]

---
<!-- last-reviewed-commit: ${HEAD_SHA} -->
<!-- reviewed-at: ${TIMESTAMP} -->
ENDPROMPT

cd "$REPO_ROOT"
aider \
  --no-auto-commits \
  --yes \
  --message "$(cat "$PROMPT_FILE")" \
  logs/aider_session_review.md \
  2>&1 | tee /tmp/aider_review_run.log

rm -f "$PROMPT_FILE"

if [ -f "$REPORT" ] && grep -q "last-reviewed-commit" "$REPORT" 2>/dev/null; then
  echo ""
  echo "══════════════════════════════════════════════"
  echo "  ✅ Report written: logs/aider_session_review.md"
  echo "  Commit reviewed: $HEAD_SHA"
  echo "══════════════════════════════════════════════"
  echo ""
  head -10 "$REPORT"
else
  echo ""
  echo "⚠️  Report may be incomplete — check /tmp/aider_review_run.log"
  exit 1
fi
