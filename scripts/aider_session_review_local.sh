#!/usr/bin/env bash
# scripts/aider_session_review_local.sh
# End-of-session health review for the cwn-c0 localhost stack.
#
# This is NOT the Render/Next.js review — that's aider_session_review.sh.
# This covers: server.js (Express), cwn_production.html (dashboard),
# lib/ modules, pm2 process health, SQLite jobs DB, and env consistency.
#
# Usage: bash scripts/aider_session_review_local.sh [--since <commit-sha>]
# Requires: aider, gh (GitHub CLI), curl, python3

set -euo pipefail

# ── Paths ──────────────────────────────────────────────────────────────────────
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CWN_C0="${REPO_ROOT}/../cwn-c0"
REPORT="$REPO_ROOT/logs/aider_session_review_local.md"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
PROMPT_FILE=$(mktemp)
trap 'rm -f "$PROMPT_FILE"' EXIT

# ── Resolve the actual git repo to review (cwn-c0 if it exists, else this repo) ─
if [ -d "$CWN_C0/.git" ]; then
  TARGET_REPO="$CWN_C0"
else
  TARGET_REPO="$REPO_ROOT"
fi
REPO_SLUG=$(git -C "$TARGET_REPO" remote get-url origin 2>/dev/null \
  | sed -e 's|.*github.com[:/]\(.*\)\.git$|\1|' || echo "unknown/cwn-c0")

echo ""
echo "══════════════════════════════════════════════"
echo "  CWN-C0 Local Stack — End-of-Session Review"
echo "  $(date -u '+%Y-%m-%d %H:%M UTC')"
echo "══════════════════════════════════════════════"
echo ""

# ── Load .env ──────────────────────────────────────────────────────────────────
ENV_FILE="${TARGET_REPO}/.env"
if [ -f "$ENV_FILE" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] && export "$line" 2>/dev/null || true
  done < "$ENV_FILE"
fi
JIRA_API_TOKEN="${JIRA_API_TOKEN:-${ATLASSIAN_API_TOKEN:-}}"
JIRA_USER_EMAIL="${JIRA_USER_EMAIL:-${ATLASSIAN_EMAIL:-}}"
JIRA_BASE_URL="${JIRA_BASE_URL:-${ATLASSIAN_DOMAIN:-}}"
if [ -n "$JIRA_BASE_URL" ] && [[ ! "$JIRA_BASE_URL" =~ ^https?:// ]]; then
  JIRA_BASE_URL="https://${JIRA_BASE_URL}"
fi
JIRA_BASE="${JIRA_BASE_URL%/}"
JIRA_AUTH="${JIRA_USER_EMAIL}:${JIRA_API_TOKEN}"
CONF_SPACE="${CONFLUENCE_SPACE_KEY:-AF}"

# ── --since flag ───────────────────────────────────────────────────────────────
SINCE=""
if [ "${1:-}" = "--since" ] && [ -n "${2:-}" ]; then SINCE="$2"; shift 2; fi
if [ -z "$SINCE" ]; then
  LAST=$(grep -m1 "<!-- last-reviewed-commit:" "$REPORT" 2>/dev/null \
    | sed 's/.*: \(.*\) -->/\1/' || true)
  SINCE="${LAST:-HEAD~20}"
fi
HEAD_SHA=$(git -C "$TARGET_REPO" rev-parse HEAD)

# ── 1. Git context ─────────────────────────────────────────────────────────────
echo "📦 Collecting git context..."
COMMIT_LOG=$(git -C "$TARGET_REPO" log --oneline "$SINCE..HEAD" 2>/dev/null \
  | head -30 || git -C "$TARGET_REPO" log --oneline -20)
CHANGED_FILES=$(git -C "$TARGET_REPO" diff --name-only "$SINCE..HEAD" 2>/dev/null \
  | head -80 || echo "(unable to diff)")

# ── 2. pm2 process health ─────────────────────────────────────────────────────
echo "⚙️  Checking pm2 health..."
PM2_STATUS="(pm2 not found)"
if command -v pm2 &>/dev/null; then
  PM2_STATUS=$(pm2 jlist 2>/dev/null | python3 -c '
import json,sys
procs=json.load(sys.stdin)
for p in procs:
  name=p.get("name","?")
  status=p.get("pm2_env",{}).get("status","?")
  restarts=p.get("pm2_env",{}).get("restart_time",0)
  uptime=p.get("pm2_env",{}).get("pm_uptime",0)
  memory=p.get("monit",{}).get("memory",0)
  print(f"  {name}: {status} | restarts={restarts} | mem={memory//1024//1024}MB")
' 2>/dev/null || pm2 list --no-color 2>/dev/null | tail -20 || echo "  (failed)")
fi

# ── 3. Recent server errors (last 50 error lines) ─────────────────────────────
echo "📋 Scanning recent error logs..."
RECENT_ERRORS="(none)"
if command -v pm2 &>/dev/null; then
  RECENT_ERRORS=$(pm2 logs auraflux --lines 200 --nostream 2>/dev/null \
    | grep -iE "\[ERROR\]|\[BLOCKING\]|GATE.*FAIL|KILL|hard.fail|throw|TypeError|ReferenceError|Cannot read|undefined.*undefined" \
    | grep -v "^\s*$" | tail -20 \
    || echo "  (no errors found)")
fi

# ── 4. Stuck / failed jobs in SQLite ─────────────────────────────────────────
echo "🗃️  Checking jobs database..."
DB_PATH="${TARGET_REPO}/data/cwn.db"
DB_STUCK="(no DB found)"
if [ -f "$DB_PATH" ] && command -v python3 &>/dev/null; then
  DB_STUCK=$(python3 - "$DB_PATH" <<'PYEOF'
import sys, json
try:
  import sqlite3
  conn = sqlite3.connect(sys.argv[1])
  cur = conn.cursor()
  # Jobs created in last 48h that aren't published/done
  cur.execute("""
    SELECT id, content_type, status, stage, created_at
    FROM jobs
    WHERE created_at > datetime('now', '-48 hours')
    AND status NOT IN ('published', 'done', 'dismissed')
    ORDER BY created_at DESC LIMIT 20
  """)
  rows = cur.fetchall()
  if not rows:
    print("  No stuck jobs in last 48h")
  else:
    for r in rows:
      print(f"  {r[0]} [{r[1]}] status={r[2]} stage={r[3]} created={r[4]}")
except Exception as e:
  print(f"  (DB check failed: {e})")
PYEOF
)
fi

# ── 5. Env consistency ────────────────────────────────────────────────────────
echo "🔑 Checking environment consistency..."
ENV_IN_CODE=$(grep -rh 'process\.env\.' \
  "${TARGET_REPO}/lib" "${TARGET_REPO}/server.js" \
  2>/dev/null | grep -oE 'process\.env\.[A-Z_]+' | sort -u \
  | sed 's/process\.env\.//' || true)
ENV_EXAMPLE="${TARGET_REPO}/.env.example"
ENV_IN_EXAMPLE=$(grep -oE '^[A-Z_]+' "$ENV_EXAMPLE" 2>/dev/null | sort -u || true)
ENV_MISSING=$(comm -23 <(echo "$ENV_IN_CODE" | sort) \
  <(echo "$ENV_IN_EXAMPLE" | sort) 2>/dev/null || true)

# ── 6. Route inventory ────────────────────────────────────────────────────────
echo "🛣️  Auditing routes..."
SERVER_ROUTES=$(grep -oE "app\.(get|post|put|delete|patch)\('[^']+'" \
  "${TARGET_REPO}/server.js" 2>/dev/null \
  | grep -oE "'[^']+'" | tr -d "'" | sort -u | head -60 || echo "(none)")

# Check for routes registered in server.js but called from dashboard
DASHBOARD_FETCHES=$(grep -oE "fetch\('[^']+'\|\"[^\"]+\"" \
  "${TARGET_REPO}/cwn_production.html" 2>/dev/null \
  | grep -oE "/[a-z][^'\"]*" | sort -u | head -40 \
  || grep -oE 'xhr\.open\s*\([^,]+,\s*['"'"'"][^'"'"'"]+' \
     "${TARGET_REPO}/cwn_production.html" 2>/dev/null \
  | grep -oE '/[a-z][^'"'"'"]*' | sort -u | head -40 \
  || echo "(unable to parse)")

# ── 7. Library modules without tests ─────────────────────────────────────────
echo "🧪 Checking test coverage..."
LIB_MODULES=$(find "${TARGET_REPO}/lib" -name "*.js" -not -path "*/node_modules/*" \
  2>/dev/null | sed "s|${TARGET_REPO}/lib/||" | sort || echo "(none)")
TEST_FILES=$(find "${TARGET_REPO}/test" -name "*.test.js" 2>/dev/null \
  | sed "s|${TARGET_REPO}/test/||" | sort || echo "(none)")
UNTESTED_MODULES=""
while IFS= read -r mod; do
  base=$(basename "$mod" .js)
  if ! echo "$TEST_FILES" | grep -q "$base"; then
    UNTESTED_MODULES="${UNTESTED_MODULES}  ${mod}\n"
  fi
done <<< "$LIB_MODULES"
UNTESTED_MODULES="${UNTESTED_MODULES:-(all lib modules have test files)}"

# ── 8. Jira board ─────────────────────────────────────────────────────────────
echo "📋 Fetching Jira board state..."
JIRA_TODO="(skipped — no API token)"
JIRA_IN_DEV=""
JIRA_IN_REVIEW=""
if [ -n "${JIRA_API_TOKEN:-}" ] && [ -n "$JIRA_BASE" ]; then
  _jira() {
    local s="$1"
    curl -s -H "Accept: application/json" -u "$JIRA_AUTH" \
      "${JIRA_BASE}/rest/api/3/search?jql=project=CPD+AND+status=%22${s}%22+ORDER+BY+priority+DESC&maxResults=15&fields=summary,priority" \
      2>/dev/null | python3 -c '
import json,sys
d=json.load(sys.stdin)
for i in d.get("issues",[]):
    f=i["fields"]
    print("  " + i["key"] + ": " + f["summary"][:80] + " [" + f["priority"]["name"] + "]")
' 2>/dev/null || echo "  (fetch failed)"
  }
  JIRA_TODO=$(     _jira "To+Do")
  JIRA_IN_DEV=$(   _jira "In+Development")
  JIRA_IN_REVIEW=$(_jira "In+Review")
fi

# ── 9. GitHub open PRs + CI ───────────────────────────────────────────────────
echo "🐙 Fetching GitHub state..."
GH_OPEN_PRS="(gh CLI not found)"
GH_FAILING_CI="(gh CLI not found)"
if command -v gh &>/dev/null; then
  GH_OPEN_PRS=$(gh pr list --repo "$REPO_SLUG" --state open \
    --json number,title,headRefName \
    --jq '.[] | "  #\(.number) \(.title) [\(.headRefName)]"' 2>/dev/null \
    || echo "  (none or failed)")
  GH_FAILING_CI=$(gh run list --repo "$REPO_SLUG" --status failure --limit 5 \
    --json displayTitle,headBranch,createdAt \
    --jq '.[] | "  \(.displayTitle) on \(.headBranch)"' 2>/dev/null \
    || echo "  none")
fi

# ── 10. Confluence ─────────────────────────────────────────────────────────────
echo "📄 Fetching Confluence activity..."
CONF_RECENT="(skipped — no API token)"
if [ -n "${JIRA_API_TOKEN:-}" ] && [ -n "$JIRA_BASE" ]; then
  CONF_RECENT=$(curl -s -H "Accept: application/json" -u "$JIRA_AUTH" \
    "${JIRA_BASE}/wiki/rest/api/content?spaceKey=${CONF_SPACE}&limit=8&orderby=modified&expand=version" \
    2>/dev/null | python3 -c '
import json,sys
d=json.load(sys.stdin)
for p in d.get("results",[]):
    print("  [" + p.get("id","") + "] " + p.get("title","") + " v" + str(p["version"]["number"]))
' 2>/dev/null || echo "  (fetch failed)")
fi

# ── 11. Write prompt and run Aider ─────────────────────────────────────────────
echo ""
echo "🤖 Running Aider review..."

cat > "$PROMPT_FILE" <<ENDOFPROMPT
You are performing an end-of-session health review of the CWN-C0 localhost stack.

This is a LOCAL-ONLY Node.js/Express server (NOT Render, NOT Next.js).
  - Backend: server.js + lib/ modules (Express, pm2 managed, port 3000)
  - Dashboard: cwn_production.html (vanilla JS, served at /)
  - Database: SQLite at data/cwn.db
  - No deployment pipeline — changes are live immediately on pm2 restart

Write a structured report to logs/aider_session_review_local.md using the data below.

SESSION GIT CONTEXT (cwn-c0 repo)
Commits since last review: ${COMMIT_LOG:-none}
Files changed: ${CHANGED_FILES:-none}

PM2 PROCESS HEALTH
${PM2_STATUS}

RECENT SERVER ERRORS (last 200 log lines, error-level only)
${RECENT_ERRORS}

STUCK / FAILED JOBS (last 48h, not published/dismissed)
${DB_STUCK}

BACKEND ROUTES in server.js (app.get/post/put/delete/patch):
${SERVER_ROUTES}

DASHBOARD FETCH CALLS (cwn_production.html → server endpoints):
${DASHBOARD_FETCHES}

JIRA BOARD
To Do: ${JIRA_TODO:-none}
In Development: ${JIRA_IN_DEV:-none}
In Review: ${JIRA_IN_REVIEW:-none}

GITHUB
Open PRs: ${GH_OPEN_PRS:-none}
CI failures: ${GH_FAILING_CI:-none}

CONFLUENCE (recent pages, space ${CONF_SPACE}): ${CONF_RECENT:-none}

ENV VARS in code but missing from .env.example:
${ENV_MISSING:-none}

LIB MODULES WITHOUT TEST FILES:
${UNTESTED_MODULES}

Write these 9 sections. Be direct. No padding.

1. Session Summary (2-4 sentences: what changed, what was fixed, what was shipped)
2. Server Health (pm2 status, recent errors, restarts — flag anything concerning)
3. Pipeline Health (stuck jobs, gate failures, jobs requiring attention)
4. Jira Consistency (stuck tickets, In Development without open PRs, merged work not transitioned to Done)
5. GitHub + Confluence Consistency (stale PRs, CI failures, HOW page gaps for changed features)
6. Route Integrity (dashboard fetch calls vs registered server.js routes — flag 404 candidates)
7. Codebase Structural Integrity (missing tests, env vars not in .env.example, dead code candidates from changed files)
8. C0 / C1+ Boundary (hardcoded branding, plan-gate violations in changed files)
9. Recommendations — mark each: [BLOCKING] [SHOULD FIX] [NICE TO HAVE]

End the file with exactly these two lines:
<!-- last-reviewed-commit: ${HEAD_SHA} -->
<!-- reviewed-at: ${TIMESTAMP} -->
ENDOFPROMPT

cd "$REPO_ROOT"
aider \
  --no-auto-commits \
  --no-gitignore \
  --yes \
  --message "$(cat "$PROMPT_FILE")" \
  "$REPORT" \
  --read "${TARGET_REPO}/server.js" \
  --read "${TARGET_REPO}/cwn_production.html" \
  --read "${TARGET_REPO}/lib/assembly.js" \
  2>&1

if grep -q "last-reviewed-commit: ${HEAD_SHA}" "$REPORT" 2>/dev/null; then
  echo ""
  echo "══════════════════════════════════════════════"
  echo "  Report: logs/aider_session_review_local.md"
  echo "  Repo:   $TARGET_REPO"
  echo "  Commit: $HEAD_SHA"
  echo "══════════════════════════════════════════════"
  head -5 "$REPORT"
else
  echo "⚠️  Report footer does not match HEAD=${HEAD_SHA} — Aider may not have written the report."
  exit 1
fi
