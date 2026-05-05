#!/usr/bin/env bash
# scripts/check_render_env.sh
#
# Pre-deploy guard: verify all required env vars are present in the Render
# service before a deploy is triggered. Exits non-zero if any are missing,
# which blocks the commit/deploy.
#
# Usage:
#   bash scripts/check_render_env.sh              # check against live Render
#   SKIP_RENDER_ENV_CHECK=1 git commit ...         # bypass for docs-only commits
#
# Required env:  RENDER_API_KEY, RENDER_SERVICE_ID

set -euo pipefail

: "${RENDER_API_KEY:?RENDER_API_KEY must be set}"
: "${RENDER_SERVICE_ID:?RENDER_SERVICE_ID must be set}"

# Keys that must exist in the Render service env — add new required vars here.
REQUIRED_KEYS=(
  ANTHROPIC_API_KEY
  GEMINI_API_KEY
  HEYGEN_API_KEY
  RUNPOD_API_KEY
  RUNPOD_POD_ID
  DATABASE_URL
  RENDER_API_KEY
  RENDER_SERVICE_ID
  STRIPE_SECRET_KEY
  ATLASSIAN_API_TOKEN
  AURAFLUX_E2E_API_KEY_OPERATE
)

echo "[check_render_env] Fetching env vars from Render service ${RENDER_SERVICE_ID}..."

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
echo "[check_render_env] ${TOTAL} env vars found in Render."

if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo ""
  echo "❌  RENDER ENV CHECK FAILED — the following required vars are MISSING:"
  for k in "${MISSING[@]}"; do
    echo "     - $k"
  done
  echo ""
  echo "    Fix: run  bash scripts/restore_render_env.sh  then retry."
  echo "    To bypass (docs-only commit): set SKIP_RENDER_ENV_CHECK=1"
  exit 1
fi

echo "✅  All required Render env vars present (${#REQUIRED_KEYS[@]}/${#REQUIRED_KEYS[@]})."
