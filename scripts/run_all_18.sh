#!/usr/bin/env bash
# =============================================================================
# run_all_18.sh — AuraFlux 18-test autonomous E2E suite (CPD-142)
#
# Gemini acts as the customer in every test:
#   1. Operate (6 tests)  — Gemini crafts API payloads from content briefs
#   2. Guided  (6 tests)  — Gemini navigates wizard + Copilot from briefs
#   3. Managed (6 tests)  — Gemini drives Copilot conversation from briefs
#
# Required env vars:
#   GEMINI_API_KEY                 — Google Gemini API key
#   AURAFLUX_E2E_API_KEY_OPERATE   — Operate-tier API key
#   AURAFLUX_E2E_BASE              — API base (optional, has defaults)
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
AURAFLUX_E2E_BASE="${AURAFLUX_E2E_BASE:-$(_dotenv AURAFLUX_E2E_BASE)}"
AURAFLUX_E2E_BASE="${AURAFLUX_E2E_BASE:-https://auraflux-api.onrender.com}"
CLERK_SECRET_KEY="${CLERK_SECRET_KEY:-$(_dotenv CLERK_SECRET_KEY)}"

export GEMINI_API_KEY AURAFLUX_E2E_API_KEY_OPERATE AURAFLUX_E2E_BASE CLERK_SECRET_KEY

OPERATE_LOG="$LOGS_DIR/operate_gemini_e2e_${TIMESTAMP}.txt"
GUIDED_LOG=""
MANAGED_LOG=""
COMBINED_LOG="$LOGS_DIR/e2e_results_${TIMESTAMP}.json"

OPERATE_PASS=0
GUIDED_PASS=0
MANAGED_PASS=0

echo "========================================"
echo "AuraFlux 18-Test E2E Suite — Gemini as Customer"
echo "Started: $(date)"
echo "========================================"
echo ""

# ── 1. Operate — Gemini crafts API payloads ────────────────────────────────────
echo "▶ [1/3] Operate — 6 tests (Gemini → API payload → submit → audit)"
echo "  Gemini key: ${GEMINI_API_KEY:0:12}..."
echo "  Operate key: ${AURAFLUX_E2E_API_KEY_OPERATE:0:12}..."

PYTHONUNBUFFERED=1 python3 -u "$REPO_DIR/scripts/operate_gemini_e2e.py" 2>&1 | tee "$OPERATE_LOG" || true

OPERATE_PASS=$(grep -c "^  ✓" "$OPERATE_LOG" 2>/dev/null || echo 0)
echo "  Operate: ${OPERATE_PASS}/6 passed"
echo ""

# ── 2. Guided — Gemini navigates wizard + Copilot ─────────────────────────────
echo "▶ [2/3] Guided — 6 tests (Gemini → wizard choices → copilot msg → audit)"

# Ensure playwright is available
if ! node -e "require('playwright')" 2>/dev/null; then
  echo "  Installing playwright..."
  npm install --prefix "$REPO_DIR" playwright --silent 2>/dev/null || true
  npx --prefix "$REPO_DIR" playwright install chromium --silent 2>/dev/null || true
fi

node "$REPO_DIR/scripts/guided_gemini_e2e.js" 2>&1 || true

LATEST_GUIDED=$(ls -t "$LOGS_DIR"/guided_gemini_e2e_*.json 2>/dev/null | head -1 || echo "")
if [ -n "$LATEST_GUIDED" ]; then
  GUIDED_LOG="$LATEST_GUIDED"
  GUIDED_PASS=$(python3 -c "import json; d=json.load(open('$GUIDED_LOG')); print(d['summary']['passed'])" 2>/dev/null || echo 0)
fi
echo "  Guided: ${GUIDED_PASS}/6 passed"
echo ""

# ── 3. Managed — Gemini drives Copilot conversation ───────────────────────────
echo "▶ [3/3] Managed — 6 tests (Gemini → copilot conversation → audit)"

node "$REPO_DIR/scripts/managed_gemini_e2e.js" 2>&1 || true

LATEST_MANAGED=$(ls -t "$LOGS_DIR"/managed_gemini_e2e_*.json 2>/dev/null | head -1 || echo "")
if [ -n "$LATEST_MANAGED" ]; then
  MANAGED_LOG="$LATEST_MANAGED"
  MANAGED_PASS=$(python3 -c "import json; d=json.load(open('$MANAGED_LOG')); print(d['summary']['passed'])" 2>/dev/null || echo 0)
fi
echo "  Managed: ${MANAGED_PASS}/6 passed"
echo ""

# ── Combined report ───────────────────────────────────────────────────────────
TOTAL_PASS=$((OPERATE_PASS + GUIDED_PASS + MANAGED_PASS))

python3 - <<PYEOF
import json, os, datetime

operate_log  = "$OPERATE_LOG"
guided_log   = "$GUIDED_LOG"
managed_log  = "$MANAGED_LOG"

operate_output   = open(operate_log).read()  if os.path.exists(operate_log)  else ""
guided_results   = json.load(open(guided_log))["results"]  if guided_log  and os.path.exists(guided_log)  else []
managed_results  = json.load(open(managed_log))["results"] if managed_log and os.path.exists(managed_log) else []

report = {
    "suite":     "AuraFlux 18-Test E2E — Gemini as Customer (CPD-142)",
    "timestamp": datetime.datetime.utcnow().isoformat() + "Z",
    "summary": {
        "total":   18,
        "passed":  $TOTAL_PASS,
        "operate": {"total": 6, "passed": $OPERATE_PASS},
        "guided":  {"total": 6, "passed": $GUIDED_PASS},
        "managed": {"total": 6, "passed": $MANAGED_PASS},
    },
    "operate_raw_log": operate_log,
    "guided":  guided_results,
    "managed": managed_results,
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
