#!/usr/bin/env bash
# deploy.sh — Push _worker.js to Cloudflare Pages (auraflux-marketing project)
#
# Usage:
#   CF_API_TOKEN=<your-token> bash cloudflare/marketing/deploy.sh
#
# Or set CF_API_TOKEN in .env and run: bash cloudflare/marketing/deploy.sh
#
# The token needs: Cloudflare Pages:Edit permission on the auraflux.co account.
# Create one at: https://dash.cloudflare.com/profile/api-tokens
#   → "Create Custom Token" → "Cloudflare Pages:Edit"

set -euo pipefail

ACCOUNT_ID="${CF_ACCOUNT_ID:-df04bc264530390035c77664f1b403d9}"
PROJECT_NAME="${CF_PAGES_PROJECT:-auraflux-marketing}"
WORKER_FILE="$(dirname "$0")/_worker.js"

if [[ -z "${CF_API_TOKEN:-}" ]]; then
  # Try loading from repo .env
  if [[ -f "$(dirname "$0")/../../.env" ]]; then
    source <(grep -E "^CF_API_TOKEN=" "$(dirname "$0")/../../.env" || true)
  fi
fi

if [[ -z "${CF_API_TOKEN:-}" ]]; then
  echo "ERROR: CF_API_TOKEN not set."
  echo "  export CF_API_TOKEN=<your-pages-edit-token>"
  echo "  or add CF_API_TOKEN=... to .env"
  exit 1
fi

echo "Deploying $WORKER_FILE → Cloudflare Pages [$PROJECT_NAME]…"

# Upload the worker as a new Pages deployment via Direct Upload API
RESPONSE=$(curl -sS -X POST \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/pages/projects/$PROJECT_NAME/deployments" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -F "manifest={}" \
  -F "_worker.js=@$WORKER_FILE;type=application/javascript")

SUCCESS=$(echo "$RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('success','false'))" 2>/dev/null)
URL=$(echo "$RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('result',{}).get('url',''))" 2>/dev/null)

if [[ "$SUCCESS" == "True" || "$SUCCESS" == "true" ]]; then
  echo "✅  Deployed successfully!"
  echo "    Preview: $URL"
  echo "    Live:    https://auraflux.co (may take 60s to propagate)"
else
  echo "❌  Deploy failed. Response:"
  echo "$RESPONSE" | python3 -m json.tool
  exit 1
fi
