#!/usr/bin/env bash
# scripts/aider_session_review.sh
# End-of-session health review: pulls live state from Jira, GitHub, Confluence,
# and the frontend (app/) then runs Aider to produce a structured report at
# logs/aider_session_review.md
#
# Usage: bash scripts/aider_session_review.sh [--since <commit-sha>]
# Requires: aider, gh (GitHub CLI), curl, python3

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_SLUG=$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null | sed -e 's|.*github.com[:/]\(.*\)\.git$|\1|' || echo "clipzworldnews/auraflux-api")
REPORT="$REPO_ROOT/logs/aider_session_review.md"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
PROMPT_FILE=$(mktemp)
LOG_FILE=$(mktemp)
trap 'rm -f "$PROMPT_FILE" "$LOG_FILE"' EXIT

# ── Load .env (KEY=VALUE lines only) ───────────────────────────────────────────
if [ -z "${JIRA_API_TOKEN:-}" ] && [ -f "$REPO_ROOT/.env" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] && export "$line" 2>/dev/null || true
  done < "$REPO_ROOT/.env"
fi

# Support ATLASSIAN_* as fallback for JIRA_*
JIRA_API_TOKEN="${JIRA_API_TOKEN:-${ATLASSIAN_API_TOKEN:-}}"
JIRA_USER_EMAIL="${JIRA_USER_EMAIL:-${ATLASSIAN_EMAIL:-}}"
JIRA_BASE_URL="${JIRA_BASE_URL:-${ATLASSIAN_DOMAIN:-}}"
# Atlassian Cloud expects https://<site>.atlassian.net — many .env files store host-only DOMAIN.
if [ -n "$JIRA_BASE_URL" ] && [[ ! "$JIRA_BASE_URL" =~ ^https?:// ]]; then
  JIRA_BASE_URL="https://${JIRA_BASE_URL}"
fi
JIRA_BASE="${JIRA_BASE_URL%/}"
JIRA_AUTH="${JIRA_USER_EMAIL}:${JIRA_API_TOKEN}"
# Confluence REST v1 uses the same site URL; space key must match your docs space (AuraFlux product space is usually AF).
CONF_SPACE="${CONFLUENCE_SPACE_KEY:-AF}"

# ── --since flag ───────────────────────────────────────────────────────────────
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
CHANGED_FILES=$(git -C "$REPO_ROOT" diff --name-only "$SINCE..HEAD" 2>/dev/null | head -80 || echo "(unable to diff)")
OPEN_BRANCHES=$(git -C "$REPO_ROOT" branch -r --no-merged main 2>/dev/null | grep -v HEAD | head -10 || echo "none")

# ── 2. Jira board state ────────────────────────────────────────────────────────
echo "📋 Fetching Jira board state..."
JIRA_TODO="(skipped — no API token)"
JIRA_IN_DEV=""
JIRA_IN_REVIEW=""
JIRA_APPROVED=""

if [ -n "${JIRA_API_TOKEN:-}" ] && [ -n "$JIRA_BASE" ]; then
  _jira() {
    local s="$1"
    HTTP_STATUS=$(curl -s -o /tmp/auraflux_jira_issues.json -w "%{http_code}" \
      -H "Accept: application/json" -u "$JIRA_AUTH" \
      "${JIRA_BASE}/rest/api/3/search?jql=project=CPD+AND+status=%22${s}%22+ORDER+BY+priority+DESC&maxResults=20&fields=summary,priority" \
      2>/dev/null)
    if [ "$HTTP_STATUS" -ge 200 ] && [ "$HTTP_STATUS" -lt 300 ]; then
      python3 -c '
import json,sys
d=json.load(open("/tmp/auraflux_jira_issues.json"))
for i in d.get("issues",[]):
    f=i["fields"]
    print("  " + i["key"] + ": " + f["summary"][:80] + " [" + f["priority"]["name"] + "]")
' 2>/dev/null || echo "  (python parse failed)"
    else
      echo "  (Jira API fetch failed with HTTP ${HTTP_STATUS})"
    fi
  }
  JIRA_TODO=$(     _jira "To+Do")
  JIRA_IN_DEV=$(   _jira "In+Development")
  JIRA_IN_REVIEW=$(_jira "In+Review")
  JIRA_APPROVED=$( _jira "Approved")
elif [ -n "${JIRA_API_TOKEN:-}" ] && [ -z "$JIRA_BASE" ]; then
  JIRA_TODO="(skipped — set ATLASSIAN_DOMAIN or JIRA_BASE_URL to your-site.atlassian.net; https:// is optional)"
fi

# ── 3. GitHub state ────────────────────────────────────────────────────────────
echo "🐙 Fetching GitHub state..."
GH_OPEN_PRS="(gh CLI not found)"
GH_FAILING_CI="(gh CLI not found)"
if command -v gh &>/dev/null; then
  GH_OPEN_PRS=$(gh pr list --repo "$REPO_SLUG" --state open \
    --json number,title,headRefName \
    --jq '.[] | "  #\(.number) \(.title) [\(.headRefName)]"' 2>/dev/null || echo "  (failed)")
  GH_FAILING_CI=$(gh run list --repo "$REPO_SLUG" --status failure --limit 5 \
    --json displayTitle,headBranch,createdAt \
    --jq '.[] | "  \(.displayTitle) on \(.headBranch)"' 2>/dev/null || echo "  none")
fi

# ── 4. Confluence ──────────────────────────────────────────────────────────────
echo "📄 Fetching recent Confluence activity..."
CONF_RECENT="(skipped — no API token)"
if [ -n "${JIRA_API_TOKEN:-}" ] && [ -n "$JIRA_BASE" ]; then
  HTTP_STATUS_CONF=$(curl -s -o /tmp/auraflux_conf_pages.json -w "%{http_code}" \
    -H "Accept: application/json" -u "$JIRA_AUTH" \
    "${JIRA_BASE}/wiki/rest/api/content?spaceKey=${CONF_SPACE}&limit=10&orderby=modified&expand=version" \
    2>/dev/null)
  if [ "$HTTP_STATUS_CONF" -ge 200 ] && [ "$HTTP_STATUS_CONF" -lt 300 ]; then
    CONF_RECENT=$(python3 -c '
import json,sys
d=json.load(open("/tmp/auraflux_conf_pages.json"))
for p in d.get("results",[]):
    print("  [" + p.get("id","") + "] " + p.get("title","") + " v" + str(p["version"]["number"]))
' 2>/dev/null || echo "  (python parse failed)")
  else
    CONF_RECENT="  (Confluence API fetch failed with HTTP ${HTTP_STATUS_CONF})"
  fi
fi

# ── 5. Env consistency — backend ──────────────────────────────────────────────
echo "🔑 Checking environment consistency..."
ENV_IN_CODE=$(grep -rh 'process\.env\.' \
  "$REPO_ROOT/lib" "$REPO_ROOT/server.js" "$REPO_ROOT/scripts" "$REPO_ROOT/test" "$REPO_ROOT/bin" \
  2>/dev/null | grep -oE 'process\.env\.[A-Z_]+' | sort -u | sed 's/process\.env\.//' || true)

# ── 6. Env consistency — frontend (NEXT_PUBLIC_* vars) ────────────────────────
FRONTEND_ENV_IN_CODE=$(grep -rh 'process\.env\.' "$REPO_ROOT/app/src" 2>/dev/null \
  | grep -oE 'process\.env\.NEXT_PUBLIC_[A-Z_]+' | sort -u \
  | sed 's/process\.env\.//' || true)

ENV_IN_EXAMPLE=$(grep -oE '^[# ]*([A-Z_][A-Z0-9_]+)=' "$REPO_ROOT/.env.example" 2>/dev/null | sed -E 's/^[# ]*//;s/=.*//' | sort -u || true)
ENV_MISSING=$(comm -23 <(echo "$ENV_IN_CODE" | sort) <(echo "$ENV_IN_EXAMPLE" | sort) 2>/dev/null || true)
FRONTEND_ENV_MISSING=$(comm -23 <(echo "$FRONTEND_ENV_IN_CODE" | sort) <(echo "$ENV_IN_EXAMPLE" | sort) 2>/dev/null || true)

# ── 7. Frontend UI inventory ──────────────────────────────────────────────────
echo "🖥️  Auditing frontend UI layer..."

# All dashboard pages that exist on disk
UI_PAGES=$(find "$REPO_ROOT/app/src/app/dashboard" -name "page.tsx" 2>/dev/null \
  | sed "s|$REPO_ROOT/app/src/app||" | sed 's|/page\.tsx||' | sort || echo "(none)")

# Routes declared in sidebar nav
SIDEBAR_ROUTES=$(grep -oE "href: *'/dashboard/[^']+'" "$REPO_ROOT/app/src/components/layout/sidebar.tsx" 2>/dev/null \
  | sed "s/href: *'//;s/'$//" | sort -u || echo "(none)")

# All apiFetch calls in api.ts — extract paths to verify backend routes exist
API_TS_PATHS=$(grep -oE "apiFetch\('[^']+'" "$REPO_ROOT/app/src/lib/api.ts" 2>/dev/null \
  | grep -oE "'[^']+'" | tr -d "'" | sort -u || echo "(none)")

# Backend routes mounted in server.js
BACKEND_ROUTES=$(grep -oE "app\.use\('/?[^']*'" "$REPO_ROOT/server.js" 2>/dev/null \
  | grep -oE "'[^']+'" | tr -d "'" | sort -u || echo "(none)")

# TypeScript check on frontend
echo "🔷 Running frontend TypeScript check..."
FRONTEND_TS_ERRORS="(skipped)"
if [ -f "$REPO_ROOT/app/tsconfig.json" ] || [ -f "$REPO_ROOT/app/package.json" ]; then
  FRONTEND_TS_ERRORS=$(cd "$REPO_ROOT/app" && npx --yes tsc --noEmit 2>&1 | head -30 || echo "(tsc not available)")
  if [ -z "$FRONTEND_TS_ERRORS" ]; then
    FRONTEND_TS_ERRORS="✅ No TypeScript errors"
  fi
fi

# ── 8. API-to-UI mapping: check apiFetch paths have a backend route ───────────
API_UNMAPPED=""
while IFS= read -r path; do
  [ -z "$path" ] && continue
  # Simplify to first segment: /support/chat → support
  segment=$(echo "$path" | sed 's|^/||' | cut -d'/' -f1)
  if ! echo "$BACKEND_ROUTES" | grep -q "$segment" && \
     ! grep -rq "router\.\(get\|post\|put\|delete\|patch\).*['\"].*${segment}" "$REPO_ROOT/lib/routes/" 2>/dev/null; then
    API_UNMAPPED="${API_UNMAPPED}  MISSING backend route for: ${path}\n"
  fi
done <<< "$API_TS_PATHS"
API_UNMAPPED="${API_UNMAPPED:-(all api.ts paths have matching backend routes)}"

# ── 9. Write prompt and run Aider ─────────────────────────────────────────────
echo ""
echo "🤖 Running Aider review..."

cat > "$PROMPT_FILE" <<ENDOFPROMPT
You are performing an end-of-session health review of the AuraFlux platform.
This platform has two layers:
  1. Backend API — Express.js in lib/ and server.js
  2. Frontend Dashboard — Next.js in app/src/app/dashboard/ (THIS IS THE CUSTOMER PRODUCT)

The UI is what customers see and use every day after sign-up. Jira tickets, Confluence HOW docs,
GitHub PRs, and deployed code must all align across BOTH layers.

Write a structured report to logs/aider_session_review.md using the data below.

SESSION GIT CONTEXT
Commits: ${COMMIT_LOG:-none}
Files changed: ${CHANGED_FILES:-none}
Unmerged branches: ${OPEN_BRANCHES:-none}

JIRA BOARD
To Do: ${JIRA_TODO:-none}
In Development: ${JIRA_IN_DEV:-none}
In Review: ${JIRA_IN_REVIEW:-none}
Approved: ${JIRA_APPROVED:-none}

GITHUB
Open PRs: ${GH_OPEN_PRS:-none}
CI failures: ${GH_FAILING_CI:-none}

CONFLUENCE (recent pages, space AF): ${CONF_RECENT:-none}

BACKEND ENV VARS in code but missing from .env.example: ${ENV_MISSING:-none}
FRONTEND NEXT_PUBLIC_* vars missing from .env.example: ${FRONTEND_ENV_MISSING:-none}

FRONTEND UI PAGES (app/src/app/dashboard/*/page.tsx):
${UI_PAGES}

SIDEBAR NAV ROUTES (what customers can actually navigate to):
${SIDEBAR_ROUTES}

API CALLS in app/src/lib/api.ts (apiFetch paths):
${API_TS_PATHS}

API-TO-BACKEND MAPPING ISSUES:
${API_UNMAPPED}

FRONTEND TYPESCRIPT CHECK:
${FRONTEND_TS_ERRORS}

Write these 10 sections. Be direct. No padding.

1. Session Summary (2-4 sentences covering both API and UI work)
2. Jira Consistency (stuck tickets, PR mismatches, un-transitioned merged work)
3. GitHub Consistency (stale PRs, CI failures, stale branches)
4. Confluence Consistency — does each changed UI page/feature have a HOW doc? List gaps.
5. Frontend UI Integrity — pages on disk vs sidebar nav (orphaned pages, missing nav entries), TypeScript errors
6. API-to-UI Mapping — apiFetch paths in api.ts vs actual backend routes (missing routes, stale calls)
7. Codebase Structural Integrity — backend routes, server.js, circular deps
8. C0 / C1+ Boundary (leaks, hardcoded branding)
9. Environment and Secrets (undocumented vars — both backend process.env.* and NEXT_PUBLIC_*)
10. Recommendations — mark each: [BLOCKING] [SHOULD FIX] [NICE TO HAVE]

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
  logs/aider_session_review.md \
  2>&1 | tee "$LOG_FILE"

if grep -q "last-reviewed-commit: ${HEAD_SHA}" "$REPORT" 2>/dev/null; then
  echo ""
  echo "══════════════════════════════════════════════"
  echo "  Report: logs/aider_session_review.md"
  echo "  Commit: $HEAD_SHA"
  echo "══════════════════════════════════════════════"
  head -5 "$REPORT"
else
  echo "Report footer does not match HEAD=${HEAD_SHA} — Aider may not have applied the update. See: $LOG_FILE"
  exit 1
fi
