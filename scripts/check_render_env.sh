#!/usr/bin/env bash
# scripts/check_render_env.sh
#
# Pre-deploy guard: verify all required env vars are present in the Render
# API service before a deploy is triggered. Exits non-zero if any are missing.
#
# These vars must be set directly in the Render dashboard — never from local files.
# The Render API /env-vars endpoint only shows API-managed vars; dashboard-managed
# vars (ANTHROPIC, GEMINI, HEYGEN_API_KEY, R2_*) are confirmed via GET /health.
#
# Usage:
#   bash scripts/check_render_env.sh
#   SKIP_RENDER_ENV_CHECK=1 git commit ...   # bypass for docs-only commits

set -euo pipefail

: "${RENDER_API_KEY:?RENDER_API_KEY must be set}"
: "${RENDER_SERVICE_ID:?RENDER_SERVICE_ID must be set}"

# API-managed vars that must exist — only AuraFlux API (C1+) vars.
# Do NOT add C0 / local-dev / sports-pipeline vars here.
REQUIRED_KEYS=(
  DATABASE_URL
  RUNPOD_API_KEY
  RUNPOD_POD_ID
  STRIPE_SECRET_KEY
  STRIPE_WEBHOOK_SECRET
  JIRA_WEBHOOK_SECRET
  AURAFLUX_E2E_API_KEY_OPERATE
  AURAFLUX_E2E_API_KEY_GUIDED
  AURAFLUX_E2E_API_KEY_MANAGED
)

PRESENT=$(curl -sf \
  -H "Authorization: Bearer ${RENDER_API_KEY}" \
  "https://api.render.com/v1/services/${RENDER_SERVICE_ID}/env-vars?limit=100" \
  | python3 -c "
import sys, json
data = json.load(sys.stdin)
items = data if isinstance(data, list) else []
for item in items:
    ev = item.get('envVar', item)
    print(ev.get('key',''))
")

MISSING=()
for key in "${REQUIRED_KEYS[@]}"; do
  if ! echo "$PRESENT" | grep -qx "$key"; then
    MISSING+=("$key")
  fi
done

TOTAL=$(echo "$PRESENT" | grep -c '.' || true)
echo "[check_render_env] ${TOTAL} API-managed env vars found on Render."

if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo ""
  echo "❌  RENDER ENV CHECK FAILED — missing vars (add in Render dashboard):"
  for k in "${MISSING[@]}"; do
    echo "     - $k"
  done
  echo ""
  echo "    Add missing vars at: https://dashboard.render.com/web/${RENDER_SERVICE_ID}/env"
  echo "    To bypass (docs-only commit): SKIP_RENDER_ENV_CHECK=1 git commit"
  exit 1
fi

echo "✅  All required API-managed Render env vars present."
