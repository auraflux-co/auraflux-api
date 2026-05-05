#!/usr/bin/env bash
# scripts/restore_render_env.sh
#
# Restore ALL env vars from local .env to the Render service.
# Safe to run at any time — it does a GET→merge→PUT so no vars are lost.
#
# Usage:
#   bash scripts/restore_render_env.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$ROOT/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "❌  $ENV_FILE not found — nothing to restore."
  exit 1
fi

# Load RENDER_API_KEY and RENDER_SERVICE_ID from .env if not already set
if [[ -z "${RENDER_API_KEY:-}" ]]; then
  RENDER_API_KEY=$(grep -m1 '^RENDER_API_KEY=' "$ENV_FILE" | cut -d= -f2- | tr -d '"'\''')
fi
if [[ -z "${RENDER_SERVICE_ID:-}" ]]; then
  RENDER_SERVICE_ID=$(grep -m1 '^RENDER_SERVICE_ID=' "$ENV_FILE" | cut -d= -f2- | tr -d '"'\''')
fi

: "${RENDER_API_KEY:?Could not find RENDER_API_KEY in .env}"
: "${RENDER_SERVICE_ID:?Could not find RENDER_SERVICE_ID in .env}"

echo "[restore_render_env] Building payload from $ENV_FILE..."

python3 - "$ENV_FILE" "$RENDER_API_KEY" "$RENDER_SERVICE_ID" <<'PYEOF'
import sys, json, re, urllib.request, urllib.error

env_file, render_key, service_id = sys.argv[1], sys.argv[2], sys.argv[3]

# Keys that are meaningless or harmful on Render
LOCAL_ONLY = {
    'PUPPETEER_EXECUTABLE_PATH',  # Mac-specific binary path
    'DASHBOARD_PORT',             # local dev port
    'PORT',                       # Render manages this
}

# Parse .env
local_vars = {}
with open(env_file) as f:
    for line in f:
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        m = re.match(r'^([A-Za-z_][A-Za-z0-9_]*)=(.*)$', line)
        if not m:
            continue
        key, val = m.group(1), m.group(2).strip('"\'')
        if key in LOCAL_ONLY:
            continue
        local_vars[key] = val

# Always include the internal DATABASE_URL if not in .env
if 'DATABASE_URL' not in local_vars:
    local_vars['DATABASE_URL'] = (
        'postgresql://auraflux_pg_user:Ttd9KyZxeleITaDntPElWo6JwwJOSkhN'
        '@dpg-d7ojt8l8nd3s739hcli0-a/auraflux_pg'
    )

# ── Fetch existing Render vars (so we don't lose dashboard-only secrets) ──
headers = {'Authorization': f'Bearer {render_key}'}
req = urllib.request.Request(
    f'https://api.render.com/v1/services/{service_id}/env-vars?limit=100',
    headers=headers
)
with urllib.request.urlopen(req) as r:
    existing_raw = json.loads(r.read())

existing = {}
for item in (existing_raw if isinstance(existing_raw, list) else []):
    ev = item.get('envVar', item)
    existing[ev['key']] = ev.get('value', '')

# Merge: local .env values win; preserve dashboard-only vars not in .env
merged = {**existing, **local_vars}
payload = [{'key': k, 'value': v} for k, v in merged.items()]

print(f"  Local .env:      {len(local_vars)} vars")
print(f"  Render existing: {len(existing)} vars")
print(f"  Merged total:    {len(payload)} vars")

# PUT merged list
body = json.dumps(payload).encode()
req = urllib.request.Request(
    f'https://api.render.com/v1/services/{service_id}/env-vars',
    data=body,
    headers={**headers, 'Content-Type': 'application/json'},
    method='PUT',
)
with urllib.request.urlopen(req) as r:
    result = json.loads(r.read())

restored = len(result) if isinstance(result, list) else '?'
print(f"\n✅  Restored {restored} env vars to Render service {service_id}")
PYEOF
