#!/usr/bin/env bash
# deploy.sh — Build + deploy _worker.js to Cloudflare Pages (auraflux-marketing)
#
# What it does:
#   1. Detects the latest Framer-content deployment (≥100KB homepage — not a pure worker)
#   2. Stamps that hash URL into FRAMER_ORIGIN in the worker before uploading
#   3. Uploads _worker.js via CF Direct Upload API
#
# Usage:
#   CF_API_TOKEN=<token> bash cloudflare/marketing/deploy.sh
#   OR: set CF_API_TOKEN in repo .env

set -euo pipefail

ACCOUNT_ID="${CF_ACCOUNT_ID:-df04bc264530390035c77664f1b403d9}"
PROJECT_NAME="${CF_PAGES_PROJECT:-auraflux-marketing}"
WORKER_SRC="$(dirname "$0")/_worker.js"
WORKER_BUILD="/tmp/_worker_build.js"

# ── Load CF_API_TOKEN from .env if not set ────────────────────────────────────
if [[ -z "${CF_API_TOKEN:-}" ]]; then
  REPO_ENV="$(dirname "$0")/../../.env"
  if [[ -f "$REPO_ENV" ]]; then
    CF_API_TOKEN="$(grep -E '^CF_API_TOKEN=' "$REPO_ENV" | cut -d= -f2- | tr -d "\"'" | head -1 || true)"
  fi
fi

if [[ -z "${CF_API_TOKEN:-}" ]]; then
  echo "ERROR: CF_API_TOKEN not set."
  echo "  export CF_API_TOKEN=<cloudflare-pages-edit-token>"
  exit 1
fi

# ── Step 1: Detect latest Framer content snapshot ────────────────────────────
echo "🔍  Finding latest Framer content snapshot..."

FRAMER_HASH=""
DEPLOYMENTS=$(python3 -c "
import urllib.request, json, sys
req = urllib.request.Request(
    'https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/pages/projects/$PROJECT_NAME/deployments?per_page=20',
    headers={'Authorization': 'Bearer $CF_API_TOKEN'}
)
with urllib.request.urlopen(req, timeout=10) as r:
    d = json.loads(r.read())
for dep in d.get('result', []):
    print(dep.get('url',''))
")

while IFS= read -r DEPLOY_URL; do
  if [[ -z "$DEPLOY_URL" ]]; then continue; fi
  SIZE=$(python3 -c "
import urllib.request
try:
    req = urllib.request.Request('$DEPLOY_URL/', headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=8) as r:
        print(len(r.read()))
except:
    print(0)
" 2>/dev/null || echo 0)
  if [[ "$SIZE" -gt 100000 ]]; then
    FRAMER_HASH="$DEPLOY_URL"
    echo "    ✓ Found: $DEPLOY_URL (${SIZE}B)"
    break
  fi
  echo "    skip: $DEPLOY_URL (${SIZE}B — worker-only)"
done <<< "$DEPLOYMENTS"

if [[ -z "$FRAMER_HASH" ]]; then
  echo "⚠️   No Framer snapshot found — using existing FRAMER_ORIGIN in worker"
  cp "$WORKER_SRC" "$WORKER_BUILD"
else
  # Stamp the detected hash into the worker
  python3 -c "
import re
with open('$WORKER_SRC') as f:
    content = f.read()
# Replace the FRAMER_ORIGIN constant
content = re.sub(
    r\"const FRAMER_ORIGIN = '[^']*';\",
    \"const FRAMER_ORIGIN = '$FRAMER_HASH';\",
    content
)
with open('$WORKER_BUILD', 'w') as f:
    f.write(content)
print('  Stamped FRAMER_ORIGIN = $FRAMER_HASH')
"
fi

# ── Step 2: Deploy via curl (same approach that's proven to work) ─────────────
echo ""
echo "🚀  Deploying to Cloudflare Pages [$PROJECT_NAME]..."

RESPONSE=$(curl -sS -X POST \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/pages/projects/$PROJECT_NAME/deployments" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -F "manifest={}" \
  -F "_worker.js=@$WORKER_BUILD;type=application/javascript")

SUCCESS=$(echo "$RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('success','false'))" 2>/dev/null)
PREVIEW_URL=$(echo "$RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('result',{}).get('url',''))" 2>/dev/null)

if [[ "$SUCCESS" == "True" || "$SUCCESS" == "true" ]]; then
  echo "✅  Deployed!"
  echo "    Preview: $PREVIEW_URL"
  echo "    Live:    https://auraflux.co  (propagates in ~60s)"
else
  echo "❌  Deploy failed:"
  echo "$RESPONSE" | python3 -m json.tool
  exit 1
fi

# Update FRAMER_ORIGIN in source file to match what was deployed
if [[ -n "$FRAMER_HASH" ]]; then
  python3 -c "
import re
with open('$WORKER_SRC') as f:
    content = f.read()
content = re.sub(
    r\"const FRAMER_ORIGIN = '[^']*';\",
    \"const FRAMER_ORIGIN = '$FRAMER_HASH';\",
    content
)
with open('$WORKER_SRC', 'w') as f:
    f.write(content)
"
  echo "    FRAMER_ORIGIN updated in _worker.js source"
fi
