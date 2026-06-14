#!/usr/bin/env bash
# =============================================================================
# run_all_18.sh — AuraFlux 18-test autonomous E2E suite (CPD-142)
#
# Gemini acts as the customer in every test — ALL 18 produce real video output:
#   1. Operate (6 tests)  — Gemini crafts API payloads from briefs → WAN → video
#   2. Guided  (6 tests)  — Gemini navigates wizard UI → WAN → video + Copilot audit
#   3. Managed (6 tests)  — Gemini drives Copilot conversation → extracts params → WAN → video
#
# Required env vars:
#   GEMINI_API_KEY                 — Google Gemini API key
#   AURAFLUX_E2E_API_KEY_OPERATE   — API key for the Operate demo account
#   AURAFLUX_E2E_API_KEY_GUIDED    — API key for the Guided demo account
#   AURAFLUX_E2E_API_KEY_MANAGED   — API key for the Managed demo account
#   CLERK_SECRET_KEY               — Clerk backend secret key (for browser tests)
#   AURAFLUX_E2E_BASE              — API base URL (optional, has default)
#   AURAFLUX_APP_BASE              — App base URL (optional, has default)
# =============================================================================

set -uo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOGS_DIR="$REPO_DIR/logs"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

mkdir -p "$LOGS_DIR"

# ── Load specific keys from .env ──────────────────────────────────────────────
_dotenv() {
  local key="$1"
  grep -m1 "^${key}=" "$REPO_DIR/.env" 2>/dev/null | cut -d= -f2- | tr -d "'\""
}

GEMINI_API_KEY="${GEMINI_API_KEY:-$(_dotenv GEMINI_API_KEY)}"
AURAFLUX_E2E_API_KEY_OPERATE="${AURAFLUX_E2E_API_KEY_OPERATE:-$(_dotenv AURAFLUX_E2E_API_KEY_OPERATE)}"
AURAFLUX_E2E_API_KEY_GUIDED="${AURAFLUX_E2E_API_KEY_GUIDED:-$(_dotenv AURAFLUX_E2E_API_KEY_GUIDED)}"
AURAFLUX_E2E_API_KEY_MANAGED="${AURAFLUX_E2E_API_KEY_MANAGED:-$(_dotenv AURAFLUX_E2E_API_KEY_MANAGED)}"
AURAFLUX_E2E_BASE="${AURAFLUX_E2E_BASE:-$(_dotenv AURAFLUX_E2E_BASE)}"
AURAFLUX_E2E_BASE="${AURAFLUX_E2E_BASE:-https://auraflux-api.onrender.com}"
AURAFLUX_APP_BASE="${AURAFLUX_APP_BASE:-$(_dotenv AURAFLUX_APP_BASE)}"
AURAFLUX_APP_BASE="${AURAFLUX_APP_BASE:-https://app.auraflux.co}"
CLERK_SECRET_KEY="${CLERK_SECRET_KEY:-$(_dotenv CLERK_SECRET_KEY)}"

export GEMINI_API_KEY AURAFLUX_E2E_API_KEY_OPERATE AURAFLUX_E2E_API_KEY_GUIDED \
       AURAFLUX_E2E_API_KEY_MANAGED AURAFLUX_E2E_BASE AURAFLUX_APP_BASE CLERK_SECRET_KEY

# ── Guard: fail loudly if any required key is missing ─────────────────────────
_require_env() {
  local key="$1"
  local val="${!key:-}"
  if [ -z "$val" ]; then
    echo "ERROR: $key is not set. Add it to .env or export it before running." >&2
    exit 2
  fi
}
_require_env GEMINI_API_KEY
_require_env AURAFLUX_E2E_API_KEY_OPERATE
_require_env AURAFLUX_E2E_API_KEY_GUIDED
_require_env AURAFLUX_E2E_API_KEY_MANAGED
_require_env CLERK_SECRET_KEY

OPERATE_LOG="$LOGS_DIR/operate_gemini_e2e_${TIMESTAMP}_stdout.txt"
COMBINED_LOG="$LOGS_DIR/e2e_results_${TIMESTAMP}.json"

OPERATE_PASS=0
GUIDED_PASS=0
MANAGED_PASS=0

echo "========================================"
echo "AuraFlux 18-Test E2E Suite — Gemini as Customer"
echo "All 18 tests produce real video output."
echo "Started: $(date)"
echo "API:     $AURAFLUX_E2E_BASE"
echo "App:     $AURAFLUX_APP_BASE"
echo "========================================"
echo ""

# ── 1. Operate — Gemini crafts API payloads ────────────────────────────────────
echo "▶ [1/3] Operate — 6 tests (Gemini → API payload → WAN → video)"
echo "  Gemini key: ${GEMINI_API_KEY:0:12}..."
echo "  Operate key: ${AURAFLUX_E2E_API_KEY_OPERATE:0:12}..."

PYTHONUNBUFFERED=1 python3 -u "$REPO_DIR/scripts/operate_gemini_e2e.py" 2>&1 | tee "$OPERATE_LOG" || true

# Pass count from JSON (reliable) — falls back to stdout grep
LATEST_OPERATE_JSON=$(ls -t "$LOGS_DIR"/operate_gemini_e2e_*.json 2>/dev/null | head -1 || echo "")
if [ -n "$LATEST_OPERATE_JSON" ]; then
  OPERATE_PASS=$(python3 -c "import json; d=json.load(open('$LATEST_OPERATE_JSON')); print(d['summary']['passed'])" 2>/dev/null || echo 0)
else
  OPERATE_PASS=$(grep -c "^  ✓" "$OPERATE_LOG" 2>/dev/null || echo 0)
fi
echo "  Operate: ${OPERATE_PASS}/6 passed"
echo ""

# ── 2. Guided — Gemini navigates wizard + video polling ───────────────────────
echo "▶ [2/3] Guided — 6 tests (Gemini → wizard UI → WAN → video + Copilot audit)"
echo "  Guided key: ${AURAFLUX_E2E_API_KEY_GUIDED:0:12}..."

# Ensure playwright is available
if ! node -e "require('playwright')" 2>/dev/null; then
  echo "  Installing playwright..."
  npm install --prefix "$REPO_DIR" playwright --silent 2>/dev/null || true
  npx --prefix "$REPO_DIR" playwright install chromium --silent 2>/dev/null || true
fi

node "$REPO_DIR/scripts/guided_gemini_e2e.js" 2>&1 || true

LATEST_GUIDED=$(ls -t "$LOGS_DIR"/guided_gemini_e2e_*.json 2>/dev/null | head -1 || echo "")
if [ -n "$LATEST_GUIDED" ]; then
  GUIDED_PASS=$(python3 -c "import json; d=json.load(open('$LATEST_GUIDED')); print(d['summary']['passed'])" 2>/dev/null || echo 0)
fi
echo "  Guided: ${GUIDED_PASS}/6 passed"
echo ""

# ── 3. Managed — Gemini drives Copilot → extracts params → video ──────────────
echo "▶ [3/3] Managed — 6 tests (Gemini → Copilot conversation → WAN → video)"
echo "  Managed key: ${AURAFLUX_E2E_API_KEY_MANAGED:0:12}..."

node "$REPO_DIR/scripts/managed_gemini_e2e.js" 2>&1 || true

LATEST_MANAGED=$(ls -t "$LOGS_DIR"/managed_gemini_e2e_*.json 2>/dev/null | head -1 || echo "")
if [ -n "$LATEST_MANAGED" ]; then
  MANAGED_PASS=$(python3 -c "import json; d=json.load(open('$LATEST_MANAGED')); print(d['summary']['passed'])" 2>/dev/null || echo 0)
fi
echo "  Managed: ${MANAGED_PASS}/6 passed"
echo ""

# ── Combined report ───────────────────────────────────────────────────────────
TOTAL_PASS=$((OPERATE_PASS + GUIDED_PASS + MANAGED_PASS))

python3 - <<PYEOF
import json, os, datetime

operate_json  = "$LATEST_OPERATE_JSON"
guided_json   = "$LATEST_GUIDED"
managed_json  = "$LATEST_MANAGED"

operate_results  = json.load(open(operate_json))["results"]  if operate_json  and os.path.exists(operate_json)  else []
guided_results   = json.load(open(guided_json))["results"]   if guided_json   and os.path.exists(guided_json)   else []
managed_results  = json.load(open(managed_json))["results"]  if managed_json  and os.path.exists(managed_json)  else []

report = {
    "suite":     "AuraFlux 18-Test E2E — Gemini as Customer — All 18 produce video (CPD-142)",
    "timestamp": datetime.datetime.utcnow().isoformat() + "Z",
    "summary": {
        "total":   18,
        "passed":  $TOTAL_PASS,
        "operate": {"total": 6, "passed": $OPERATE_PASS},
        "guided":  {"total": 6, "passed": $GUIDED_PASS},
        "managed": {"total": 6, "passed": $MANAGED_PASS},
    },
    "operate":  operate_results,
    "guided":   guided_results,
    "managed":  managed_results,
}

with open("$COMBINED_LOG", "w") as f:
    json.dump(report, f, indent=2)
print(f"Report: $COMBINED_LOG")
PYEOF

echo "========================================"
echo "FINAL RESULT: ${TOTAL_PASS}/18 passed"
echo "  Operate: ${OPERATE_PASS}/6"
echo "  Guided:  ${GUIDED_PASS}/6"
echo "  Managed: ${MANAGED_PASS}/6"
echo "Completed: $(date)"
echo "========================================"
echo ""
echo "Full report: $COMBINED_LOG"

[ "$TOTAL_PASS" = "18" ] && exit 0 || exit 1
