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
# Always re-load so ATLASSIAN_* vars are available even if JIRA_* are already set.
# Strips surrounding single and double quotes from values so DOMAIN="foo.atlassian.net"
# doesn't produce a value with literal quote characters.
if [ -f "$REPO_ROOT/.env" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || continue
    _key="${line%%=*}"
    _val="${line#*=}"
    # Strip CR, surrounding quotes, and trailing whitespace (trailing spaces
    # in .env values cause HTTP 000 from curl when used in auth strings).
    _val=$(printf '%s' "$_val" | sed $'s/\r//g; s/[[:space:]]*$//')
    _val="${_val#\"}"; _val="${_val%\"}"
    _val="${_val#\'}"; _val="${_val%\'}"
    export "${_key}=${_val}" 2>/dev/null || true
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
# Guard: skip API calls if JIRA_BASE doesn't look like a valid Atlassian URL.
# A bad/empty domain causes curl to fail immediately with HTTP 000.
[[ "$JIRA_BASE" =~ ^https://[a-zA-Z0-9] ]] || JIRA_BASE=""
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
    local jql="$1"
    # Atlassian deprecated /rest/api/3/search (HTTP 410) — use /rest/api/3/search/jql instead.
    HTTP_STATUS=$(curl -s --max-time 10 --connect-timeout 5 -o /tmp/auraflux_jira_issues.json -w "%{http_code}" \
      -H "Accept: application/json" -H "Content-Type: application/json" -u "$JIRA_AUTH" \
      -X POST --data "{\"jql\":\"${jql}\",\"maxResults\":25,\"fields\":[\"summary\",\"priority\",\"labels\"]}" \
      "${JIRA_BASE}/rest/api/3/search/jql" \
      2>/dev/null) || HTTP_STATUS="000"
    if [ "$HTTP_STATUS" -ge 200 ] && [ "$HTTP_STATUS" -lt 300 ]; then
      python3 -c '
import json,sys
d=json.load(open("/tmp/auraflux_jira_issues.json"))
for i in d.get("issues",[]):
    f=i["fields"]
    labels=f.get("labels",[])
    tag=" [BLOCKED]" if "blocked" in [l.lower() for l in labels] else ""
    print("  " + i["key"] + ": " + f["summary"][:80] + " [" + f["priority"]["name"] + "]" + tag)
' 2>/dev/null || echo "  (python parse failed)"
    else
      echo "  (Jira API fetch failed with HTTP ${HTTP_STATUS})"
    fi
  }
  # Non-blocked To Do (app work) — excludes marketing-site label and blocked label
  JIRA_TODO=$(     _jira 'project=CPD AND status="To Do" AND labels not in ("blocked","marketing-site") ORDER BY priority DESC')
  # All In Development / Review / Approved (these are active — show regardless of label)
  JIRA_IN_DEV=$(   _jira 'project=CPD AND status="In Development" ORDER BY priority DESC')
  JIRA_IN_REVIEW=$(_jira 'project=CPD AND status="In Review" ORDER BY priority DESC')
  JIRA_APPROVED=$( _jira 'project=CPD AND status="Approved" ORDER BY priority DESC')
  # Marketing site backlog — separate summary
  JIRA_MKTG=$(     _jira 'project=CPD AND status="To Do" AND labels = "marketing-site" ORDER BY priority DESC')
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
  # Filter to main branch AND only failures from the last 24 hours.
  # Without --branch: returns failures from any branch (feature branches, old PRs).
  # Without a time filter: returns all historical failures on main, which are not
  # actionable and cause false [BLOCKING] reports.
  _CI_CUTOFF=$(date -u -v-24H "+%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
    || date -u --date='24 hours ago' "+%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
    || echo "2000-01-01T00:00:00Z")
  GH_FAILING_CI=$(gh run list --repo "$REPO_SLUG" --branch main --status failure --limit 20 \
    --json displayTitle,headBranch,createdAt \
    --jq --arg cutoff "$_CI_CUTOFF" \
      '.[] | select(.createdAt > $cutoff) | "  \(.displayTitle) on \(.headBranch) (\(.createdAt))"' \
    2>/dev/null || echo "  none")
  [ -z "$GH_FAILING_CI" ] && GH_FAILING_CI="  none"
fi

# ── 4. Confluence ──────────────────────────────────────────────────────────────
echo "📄 Fetching recent Confluence activity..."
CONF_RECENT="(skipped — no API token)"
if [ -n "${JIRA_API_TOKEN:-}" ] && [ -n "$JIRA_BASE" ]; then
  HTTP_STATUS_CONF=$(curl -s --max-time 10 --connect-timeout 5 -o /tmp/auraflux_conf_pages.json -w "%{http_code}" \
    -H "Accept: application/json" -u "$JIRA_AUTH" \
    "${JIRA_BASE}/wiki/rest/api/content?spaceKey=${CONF_SPACE}&limit=10&expand=version" \
    2>/dev/null) || HTTP_STATUS_CONF="000"
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
# Use [A-Z][A-Z0-9_]* so digit-prefixed names (C0_*, R2_*, E2E_*) are captured
# in full instead of being truncated to a single letter by [A-Z_]+.
ENV_IN_CODE=$(grep -rh 'process\.env\.' \
  "$REPO_ROOT/lib" "$REPO_ROOT/server.js" "$REPO_ROOT/scripts" "$REPO_ROOT/test" "$REPO_ROOT/bin" \
  2>/dev/null | grep -oE 'process\.env\.[A-Z][A-Z0-9_]*' | sort -u | sed 's/process\.env\.//' || true)

# ── 6. Env consistency — frontend (NEXT_PUBLIC_* vars) ────────────────────────
FRONTEND_ENV_IN_CODE=$(grep -rh 'process\.env\.' "$REPO_ROOT/app/src" 2>/dev/null \
  | grep -oE 'process\.env\.NEXT_PUBLIC_[A-Z][A-Z0-9_]*' | sort -u \
  | sed 's/process\.env\.//' || true)

ENV_IN_EXAMPLE=$(grep -oE '^[# ]*([A-Z_][A-Z0-9_]+)=' "$REPO_ROOT/.env.example" 2>/dev/null | sed -E 's/^[# ]*//;s/=.*//' | sort -u || true)
ENV_MISSING=$(comm -23 <(echo "$ENV_IN_CODE" | sort) <(echo "$ENV_IN_EXAMPLE" | sort) 2>/dev/null || true)
FRONTEND_ENV_MISSING=$(comm -23 <(echo "$FRONTEND_ENV_IN_CODE" | sort) <(echo "$ENV_IN_EXAMPLE" | sort) 2>/dev/null || true)

# ── 7. Frontend UI inventory ──────────────────────────────────────────────────
echo "🖥️  Auditing frontend UI layer..."

# All customer-facing pages that exist on disk.
# The app uses Next.js route groups: (app)/ not dashboard/.
UI_PAGES=$(find "$REPO_ROOT/app/src/app/(app)" -name "page.tsx" 2>/dev/null \
  | sed "s|$REPO_ROOT/app/src/app/(app)||" | sed 's|/page\.tsx||' | sort || echo "(none)")

# Routes declared in sidebar nav — matches href: '/...' (without /dashboard prefix)
SIDEBAR_ROUTES=$(grep -oE "href: *'[^']+'" "$REPO_ROOT/app/src/components/layout/sidebar.tsx" 2>/dev/null \
  | sed "s/href: *'//;s/'$//" | grep '^/' | sort -u || echo "(none)")

# All apiFetch calls in api.ts — extract paths to verify backend routes exist
API_TS_PATHS=$(grep -oE "apiFetch\('[^']+'" "$REPO_ROOT/app/src/lib/api.ts" 2>/dev/null \
  | grep -oE "'[^']+'" | tr -d "'" | sort -u || echo "(none)")

# Backend routes — collect every path string declared in lib/routes/*.js.
# Using grep on route files directly is more reliable than parsing server.js
# app.use() calls, which miss prefix-less mounts like `app.use(billingRouter)`.
# Multi-line route declarations (router.get(\n  '/path', ...) are handled by
# grepping for the quoted path strings directly rather than same-line patterns.
BACKEND_ROUTES=$(grep -rh "router\.\(get\|post\|put\|delete\|patch\)" \
  "$REPO_ROOT/lib/routes/" 2>/dev/null \
  | grep -oE "'/?[a-z][a-z0-9/_:-]*'" | tr -d "'" | sed 's|^/||' | cut -d'/' -f1 \
  | sort -u || echo "(none)")
# Also add any path strings on lines that follow a router.method call (multi-line style)
BACKEND_ROUTES_ML=$(grep -rh "^ *'/?[a-z][a-z0-9/_:-]*'," \
  "$REPO_ROOT/lib/routes/" 2>/dev/null \
  | grep -oE "'/?[a-z][a-z0-9/_:-]*'" | tr -d "'" | sed 's|^/||' | cut -d'/' -f1 \
  | sort -u || true)
BACKEND_ROUTES=$(echo -e "${BACKEND_ROUTES}\n${BACKEND_ROUTES_ML}" | sort -u)

# TypeScript check on frontend
echo "🔷 Running frontend TypeScript check..."
# macOS ships gtimeout (brew install coreutils); Linux ships timeout
_TIMEOUT_CMD="timeout"
command -v timeout &>/dev/null || { command -v gtimeout &>/dev/null && _TIMEOUT_CMD="gtimeout"; } || _TIMEOUT_CMD=""
FRONTEND_TS_ERRORS="(skipped)"
if [ -f "$REPO_ROOT/app/tsconfig.json" ] || [ -f "$REPO_ROOT/app/package.json" ]; then
  if command -v tsc &>/dev/null || [ -x "$REPO_ROOT/app/node_modules/.bin/tsc" ]; then
    if [ -n "$_TIMEOUT_CMD" ]; then
      FRONTEND_TS_ERRORS=$(cd "$REPO_ROOT/app" && "$_TIMEOUT_CMD" 60 node_modules/.bin/tsc --noEmit 2>&1 | head -30 || echo "(tsc check failed or timed out)")
    else
      FRONTEND_TS_ERRORS=$(cd "$REPO_ROOT/app" && node_modules/.bin/tsc --noEmit 2>&1 | head -30 || echo "(tsc check failed)")
    fi
    if [ -z "$FRONTEND_TS_ERRORS" ]; then
      FRONTEND_TS_ERRORS="✅ No TypeScript errors"
    fi
  else
    FRONTEND_TS_ERRORS="(skipped — tsc not in node_modules/.bin; run: cd app && npm install)"
  fi
fi

# ── 7b. Marketing site health ─────────────────────────────────────────────────
echo "🌐 Checking marketing site (auraflux.co) health..."
MKTG_STATUS=""

_mktg_check() {
  local label="$1" url="$2" expect="$3"
  local http body
  body=$(curl -sL --max-time 8 --connect-timeout 5 -o /tmp/af_mktg_body.txt -w "%{http_code}" "$url" 2>/dev/null) || body="000"
  local content
  content=$(cat /tmp/af_mktg_body.txt 2>/dev/null || echo "")
  if [ "$body" = "000" ]; then
    MKTG_STATUS="${MKTG_STATUS}  ❌ ${label}: UNREACHABLE\n"
  elif [ -n "$expect" ] && ! grep -qF "$expect" <<< "$content"; then
    MKTG_STATUS="${MKTG_STATUS}  ⚠️  ${label}: HTTP ${body} but missing expected content: ${expect}\n"
  else
    MKTG_STATUS="${MKTG_STATUS}  ✅ ${label}: HTTP ${body}\n"
  fi
}

_mktg_check "Homepage"           "https://auraflux.co/"          "AuraFlux"
_mktg_check "Pricing page"       "https://auraflux.co/pricing"   "Operate"
_mktg_check "Contact page"       "https://auraflux.co/contact"   "AuraFlux"
_mktg_check "Privacy page"       "https://auraflux.co/privacy"   "Privacy"
_mktg_check "Terms page"         "https://auraflux.co/terms"     "Terms"
_mktg_check "Plans API"          "https://auraflux-api.onrender.com/api/public/plans" "operate"
_mktg_check "Chat API"           "https://auraflux-api.onrender.com/api/public/chat" ""
# Roadmap should redirect (3xx) — check it doesn't 200 a blank page
ROADMAP_HTTP=$(curl -s --max-time 8 -o /dev/null -w "%{http_code}" "https://auraflux.co/roadmap" 2>/dev/null || echo "000")
if [[ "$ROADMAP_HTTP" =~ ^3 ]]; then
  MKTG_STATUS="${MKTG_STATUS}  ✅ Roadmap redirect: HTTP ${ROADMAP_HTTP}\n"
else
  MKTG_STATUS="${MKTG_STATUS}  ⚠️  Roadmap page: HTTP ${ROADMAP_HTTP} (expected 3xx redirect)\n"
fi
# Chat widget injected on homepage?
# grep -c exits 1 when count=0; separate the fallback so we don't capture both outputs
CHAT_WIDGET=$(curl -sL --max-time 8 "https://auraflux.co/" 2>/dev/null | grep -c "af-chat-btn" 2>/dev/null) || true
CHAT_WIDGET="${CHAT_WIDGET:-0}"
if [ "${CHAT_WIDGET}" -gt 0 ] 2>/dev/null; then
  MKTG_STATUS="${MKTG_STATUS}  ✅ Chat widget injected on homepage\n"
else
  MKTG_STATUS="${MKTG_STATUS}  ⚠️  Chat widget NOT found on homepage\n"
fi
[ -z "$MKTG_STATUS" ] && MKTG_STATUS="  (no checks run)"

# ── 8. API-to-UI mapping: check apiFetch paths have a backend route ───────────
API_UNMAPPED=""
while IFS= read -r path; do
  [ -z "$path" ] && continue
  # Simplify to first segment: /billing/payment-method → billing
  segment=$(echo "$path" | sed 's|^/||' | cut -d'/' -f1)
  # Check 1: segment appears in our collected BACKEND_ROUTES set
  # Check 2: any route file contains the full path string (catches exact matches)
  if ! echo "$BACKEND_ROUTES" | grep -qx "$segment" && \
     ! grep -rq "['\"]${path}['\"]" "$REPO_ROOT/lib/routes/" 2>/dev/null && \
     ! grep -rq "['\"]/${segment}" "$REPO_ROOT/lib/routes/" 2>/dev/null; then
    API_UNMAPPED="${API_UNMAPPED}  MISSING backend route for: ${path}\n"
  fi
done <<< "$API_TS_PATHS"
API_UNMAPPED="${API_UNMAPPED:-(all api.ts paths have matching backend routes)}"

# ── 9. Write prompt and run Aider ─────────────────────────────────────────────
echo ""
echo "🤖 Running Aider review..."

cat > "$PROMPT_FILE" <<ENDOFPROMPT
You are performing an end-of-session health review of the AuraFlux platform.
This platform has THREE layers:
  1. Backend API — Express.js in lib/ and server.js
  2. Frontend Dashboard — Next.js in app/src/app/(app)/ (THE CUSTOMER PRODUCT at app.auraflux.co)
  3. Marketing Site — auraflux.co (Cloudflare Pages + Framer, proxied via _worker.js)

Jira tickets, Confluence HOW docs, GitHub PRs, and deployed code must all align across ALL three layers.

Write a structured report to logs/aider_session_review.md using the data below.

SESSION GIT CONTEXT
Commits: ${COMMIT_LOG:-none}
Files changed: ${CHANGED_FILES:-none}
Unmerged branches: ${OPEN_BRANCHES:-none}

JIRA BOARD — APP WORK (non-blocked, non-marketing-site)
To Do: ${JIRA_TODO:-none}
In Development: ${JIRA_IN_DEV:-none}
In Review: ${JIRA_IN_REVIEW:-none}
Approved: ${JIRA_APPROVED:-none}

JIRA — MARKETING SITE BACKLOG:
${JIRA_MKTG:-none}

GITHUB
Open PRs: ${GH_OPEN_PRS:-none}
CI failures: ${GH_FAILING_CI:-none}

CONFLUENCE (recent pages, space AF): ${CONF_RECENT:-none}

BACKEND ENV VARS in code but missing from .env.example: ${ENV_MISSING:-none}
FRONTEND NEXT_PUBLIC_* vars missing from .env.example: ${FRONTEND_ENV_MISSING:-none}

FRONTEND UI PAGES (app/src/app/(app)/*/page.tsx):
${UI_PAGES}

SIDEBAR NAV ROUTES (what customers can actually navigate to):
${SIDEBAR_ROUTES}

API CALLS in app/src/lib/api.ts (apiFetch paths):
${API_TS_PATHS}

API-TO-BACKEND MAPPING ISSUES:
${API_UNMAPPED}

FRONTEND TYPESCRIPT CHECK:
${FRONTEND_TS_ERRORS}

MARKETING SITE HEALTH (auraflux.co + public API endpoints):
$(printf '%b' "${MKTG_STATUS}")

Write these 11 sections. Be direct. No padding.

1. Session Summary (2-4 sentences covering app, API, and marketing site work)
2. Jira Consistency (stuck tickets, PR mismatches, un-transitioned merged work)
3. GitHub Consistency (stale PRs, CI failures, stale branches)
4. Confluence Consistency — does each changed UI page/feature have a HOW doc? List gaps.
5. Frontend UI Integrity — pages on disk vs sidebar nav (orphaned pages, missing nav entries), TypeScript errors
6. API-to-UI Mapping — apiFetch paths in api.ts vs actual backend routes (missing routes, stale calls)
7. Codebase Structural Integrity — backend routes, server.js, circular deps
8. C0 / C1+ Boundary (leaks, hardcoded branding)
9. Environment and Secrets (undocumented vars — both backend process.env.* and NEXT_PUBLIC_*)
10. Marketing Site Health — summarise check results; flag any endpoint down or content issues
11. Recommendations — mark each: [BLOCKING] [SHOULD FIX] [NICE TO HAVE]
    Separate sub-sections: App Recommendations | Marketing Site Recommendations

End the file with exactly these two lines:
<!-- last-reviewed-commit: ${HEAD_SHA} -->
<!-- reviewed-at: ${TIMESTAMP} -->
ENDOFPROMPT

cd "$REPO_ROOT"

# Resolve Anthropic API key (env first, then .env file)
_ANTHROPIC_KEY="${ANTHROPIC_API_KEY:-}"
if [ -z "$_ANTHROPIC_KEY" ] && [ -f "$REPO_ROOT/.env" ]; then
  _ANTHROPIC_KEY=$(grep '^ANTHROPIC_API_KEY=' "$REPO_ROOT/.env" 2>/dev/null | head -1 | cut -d'=' -f2- | tr -d '"'"'" )
fi
if [ -z "$_ANTHROPIC_KEY" ]; then
  echo "ERROR: ANTHROPIC_API_KEY not set. Export it or add it to .env" >&2
  exit 1
fi

echo "  Calling Anthropic API directly (avoids aider file-load token inflation)..."
PY_SCRIPT=$(mktemp /tmp/aider_review_XXXXXX.py)
trap 'rm -f "$PROMPT_FILE" "$LOG_FILE" "$PY_SCRIPT"' EXIT

cat > "$PY_SCRIPT" <<'PYEOF'
import sys, json, urllib.request, urllib.error

prompt_file, report_file, api_key = sys.argv[1], sys.argv[2], sys.argv[3]
prompt = open(prompt_file).read()

payload = json.dumps({
    "model": "claude-opus-4-5",
    "max_tokens": 4096,
    "messages": [{"role": "user", "content": prompt}]
}).encode()

req = urllib.request.Request(
    "https://api.anthropic.com/v1/messages",
    data=payload,
    headers={
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
    }
)
try:
    with urllib.request.urlopen(req, timeout=120) as r:
        data = json.loads(r.read())
    report = data["content"][0]["text"]
    with open(report_file, "w") as f:
        f.write(report)
    print(f"Report written — {len(report)} chars")
except urllib.error.HTTPError as e:
    print(f"API error {e.code}: {e.read().decode()}", file=sys.stderr)
    sys.exit(1)
PYEOF

python3 "$PY_SCRIPT" "$PROMPT_FILE" "$REPORT" "$_ANTHROPIC_KEY" 2>&1 | tee "$LOG_FILE"

if grep -q "last-reviewed-commit: ${HEAD_SHA}" "$REPORT" 2>/dev/null; then
  echo ""
  echo "══════════════════════════════════════════════"
  echo "  Report: logs/aider_session_review.md"
  echo "  Commit: $HEAD_SHA"
  echo "══════════════════════════════════════════════"
  head -5 "$REPORT"
else
  echo "Report footer does not match HEAD=${HEAD_SHA} — check logs/aider_session_review.md"
  exit 1
fi
