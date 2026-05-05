#!/usr/bin/env bash
# =============================================================================
# run_all_18.sh — AuraFlux 18-test autonomous E2E suite (CPD-142)
#
# Runs all three tier test suites in sequence:
#   1. Operate (6 tests)  — Python API test via AURAFLUX_E2E_API_KEY_OPERATE
#   2. Guided  (6 tests)  — Node Playwright browser: wizard + Copilot panel
#   3. Managed (6 tests)  — Node Playwright browser: Copilot page only
#
# Output:
#   logs/e2e_results_TIMESTAMP.json  — combined structured report
#   logs/operate_e2e_TIMESTAMP.txt   — operate raw output
#   logs/guided_e2e_TIMESTAMP.json   — guided per-scenario results
#   logs/managed_e2e_TIMESTAMP.json  — managed per-scenario results
#
# Required env vars (in .env):
#   AURAFLUX_E2E_API_KEY_OPERATE
#   AURAFLUX_E2E_BASE (optional, defaults to https://auraflux-api.onrender.com)
#   AURAFLUX_E2E_EMAIL           (optional, defaults to demo@auraflux.co)
#   AURAFLUX_E2E_PASSWORD        (optional, defaults to AuraFlux2026!)
#   AURAFLUX_E2E_MANAGED_EMAIL   (optional, defaults to managed-demo@auraflux.co)
#   AURAFLUX_E2E_MANAGED_PASSWORD (optional, defaults to AuraFlux2026!)
# =============================================================================

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOGS_DIR="$REPO_DIR/logs"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

mkdir -p "$LOGS_DIR"

# Load .env
if [ -f "$REPO_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source <(grep -v '^#' "$REPO_DIR/.env" | grep -v '^\s*$' | grep '=' | grep -v 'Chrome\|chrome\|chromium')
  set +a
fi

OPERATE_LOG="$LOGS_DIR/operate_e2e_${TIMESTAMP}.txt"
GUIDED_LOG="$LOGS_DIR/guided_e2e_${TIMESTAMP}.json"
MANAGED_LOG="$LOGS_DIR/managed_e2e_${TIMESTAMP}.json"
COMBINED_LOG="$LOGS_DIR/e2e_results_${TIMESTAMP}.json"

OPERATE_PASS=0
GUIDED_PASS=0
MANAGED_PASS=0
OPERATE_TOTAL=6
GUIDED_TOTAL=6
MANAGED_TOTAL=6

echo "========================================"
echo "AuraFlux 18-Test E2E Suite (CPD-142)"
echo "Started: $(date)"
echo "========================================"
echo ""

# ── 1. Operate ────────────────────────────────────────────────────────────────
echo "▶ [1/3] Operate — 6 tests via API"
echo "  Key: ${AURAFLUX_E2E_API_KEY_OPERATE:0:12}..."

if python3 "$REPO_DIR/scripts/operate_e2e_test.py" 2>&1 | tee "$OPERATE_LOG"; then
  OPERATE_PASS=6
  echo "  ✓ Operate: 6/6 passed"
else
  # Parse pass count from output
  OPERATE_PASS=$(grep -c "✓.*passed\|✓.*completed" "$OPERATE_LOG" 2>/dev/null || echo 0)
  echo "  ✗ Operate: ${OPERATE_PASS}/6 passed — see $OPERATE_LOG"
fi
echo ""

# ── 2. Guided ─────────────────────────────────────────────────────────────────
echo "▶ [2/3] Guided — 6 tests via dashboard + Copilot"
echo "  Account: ${AURAFLUX_E2E_EMAIL:-demo@auraflux.co}"

# Ensure playwright is available
if ! node -e "require('playwright')" 2>/dev/null; then
  echo "  Installing playwright..."
  npm install --prefix "$REPO_DIR" playwright --silent 2>/dev/null || true
  npx --prefix "$REPO_DIR" playwright install chromium --silent 2>/dev/null || true
fi

GUIDED_EXIT=0
node "$REPO_DIR/scripts/guided_e2e_browser.js" 2>&1 || GUIDED_EXIT=$?

if [ -f "$LOGS_DIR"/guided_e2e_*.json ]; then
  # Get most recent guided log
  LATEST_GUIDED=$(ls -t "$LOGS_DIR"/guided_e2e_*.json | head -1)
  cp "$LATEST_GUIDED" "$GUIDED_LOG" 2>/dev/null || true
  GUIDED_PASS=$(python3 -c "import json; d=json.load(open('$GUIDED_LOG')); print(sum(1 for r in d['results'] if r['passed']))" 2>/dev/null || echo 0)
fi

echo "  $([ "$GUIDED_EXIT" = "0" ] && echo '✓' || echo '✗') Guided: ${GUIDED_PASS}/6 passed"
echo ""

# ── 3. Managed ────────────────────────────────────────────────────────────────
echo "▶ [3/3] Managed — 6 tests via Copilot only"
echo "  Account: ${AURAFLUX_E2E_MANAGED_EMAIL:-managed-demo@auraflux.co}"

MANAGED_EXIT=0
node "$REPO_DIR/scripts/managed_e2e_browser.js" 2>&1 || MANAGED_EXIT=$?

if [ -f "$LOGS_DIR"/managed_e2e_*.json ]; then
  LATEST_MANAGED=$(ls -t "$LOGS_DIR"/managed_e2e_*.json | head -1)
  cp "$LATEST_MANAGED" "$MANAGED_LOG" 2>/dev/null || true
  MANAGED_PASS=$(python3 -c "import json; d=json.load(open('$MANAGED_LOG')); print(sum(1 for r in d['results'] if r['passed']))" 2>/dev/null || echo 0)
fi

echo "  $([ "$MANAGED_EXIT" = "0" ] && echo '✓' || echo '✗') Managed: ${MANAGED_PASS}/6 passed"
echo ""

# ── Combined report ───────────────────────────────────────────────────────────
TOTAL_PASS=$((OPERATE_PASS + GUIDED_PASS + MANAGED_PASS))
TOTAL=$((OPERATE_TOTAL + GUIDED_TOTAL + MANAGED_TOTAL))

python3 - <<PYEOF
import json, os, datetime

operate_log = "$OPERATE_LOG"
guided_log  = "$GUIDED_LOG"  if os.path.exists("$GUIDED_LOG")  else None
managed_log = "$MANAGED_LOG" if os.path.exists("$MANAGED_LOG") else None

operate_output = open(operate_log).read() if os.path.exists(operate_log) else ""
guided_results  = json.load(open(guided_log))["results"]  if guided_log  else []
managed_results = json.load(open(managed_log))["results"] if managed_log else []

report = {
    "suite": "AuraFlux 18-Test E2E (CPD-142)",
    "timestamp": datetime.datetime.utcnow().isoformat() + "Z",
    "summary": {
        "total": $TOTAL,
        "passed": $TOTAL_PASS,
        "operate": {"total": $OPERATE_TOTAL, "passed": $OPERATE_PASS},
        "guided":  {"total": $GUIDED_TOTAL,  "passed": $GUIDED_PASS},
        "managed": {"total": $MANAGED_TOTAL, "passed": $MANAGED_PASS},
    },
    "operate_raw_log": operate_log,
    "guided":  guided_results,
    "managed": managed_results,
}

with open("$COMBINED_LOG", "w") as f:
    json.dump(report, f, indent=2)
print(f"Report written: $COMBINED_LOG")
PYEOF

echo "========================================"
echo "FINAL RESULT: ${TOTAL_PASS}/${TOTAL} passed"
echo "  Operate: ${OPERATE_PASS}/${OPERATE_TOTAL}"
echo "  Guided:  ${GUIDED_PASS}/${GUIDED_TOTAL}"
echo "  Managed: ${MANAGED_PASS}/${MANAGED_TOTAL}"
echo "Completed: $(date)"
echo "========================================"
echo ""
echo "Full report: $COMBINED_LOG"

# Exit non-zero if any failures
[ "$TOTAL_PASS" = "$TOTAL" ] && exit 0 || exit 1
