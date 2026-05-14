#!/usr/bin/env bash
# scripts/render_env_set.sh — SAFE single env-var setter for Render
#
# NEVER use `PUT /v1/services/{id}/env-vars` directly with a partial list.
# That endpoint REPLACES ALL vars, wiping everything not in the payload.
# This script always fetches → merges → replaces so no vars are lost.
#
# Usage:
#   bash scripts/render_env_set.sh KEY=value           # set one var
#   bash scripts/render_env_set.sh KEY1=v1 KEY2=v2     # set multiple
#   bash scripts/render_env_set.sh DATABASE_URL=...    # add missing var
#
# This is the ONLY safe way for agents to set Render env vars.

set -euo pipefail

if [[ $# -eq 0 ]]; then
  echo "Usage: bash scripts/render_env_set.sh KEY=value [KEY2=value2 ...]"
  exit 1
fi

RKEY="${RENDER_API_KEY:-$(grep -m1 '^RENDER_API_KEY=' .env 2>/dev/null | cut -d= -f2-)}"
RSVC="${RENDER_SERVICE_ID:-$(grep -m1 '^RENDER_SERVICE_ID=' .env 2>/dev/null | cut -d= -f2-)}"

if [[ -z "$RKEY" || -z "$RSVC" ]]; then
  echo "❌  RENDER_API_KEY or RENDER_SERVICE_ID not set." >&2
  exit 1
fi

echo "[render_env_set] Fetching current env vars..."
CURRENT_JSON=$(curl -sf \
  -H "Authorization: Bearer ${RKEY}" \
  "https://api.render.com/v1/services/${RSVC}/env-vars?limit=100")

CURRENT_COUNT=$(echo "$CURRENT_JSON" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))")
echo "[render_env_set] ${CURRENT_COUNT} vars currently on Render."

# Build merged payload: existing vars + overrides from CLI args
python3 << PYEOF
import json, urllib.request as ur, urllib.error, sys

rkey = "${RKEY}"
rsvc = "${RSVC}"
args = sys.argv[1:]

current_raw = json.loads(r"""${CURRENT_JSON}""")

# Parse existing vars into a dict
existing = {}
for item in current_raw:
    ev = item.get("envVar", item)
    existing[ev.get("key", "")] = ev.get("value", "")

# Apply overrides from CLI
overrides = {}
for arg in args:
    if "=" not in arg:
        print(f"ERROR: invalid argument '{arg}' — expected KEY=value", file=sys.stderr)
        sys.exit(1)
    k, _, v = arg.partition("=")
    overrides[k.strip()] = v.strip()

existing.update(overrides)

# Build payload
payload = [{"key": k, "value": v} for k, v in existing.items() if k]
print(f"[render_env_set] Setting {len(overrides)} var(s): {list(overrides.keys())}", file=sys.stderr)
print(f"[render_env_set] Total after merge: {len(payload)} vars", file=sys.stderr)

req = ur.Request(
    f"https://api.render.com/v1/services/{rsvc}/env-vars",
    data=json.dumps(payload).encode(), method="PUT",
    headers={"Authorization": f"Bearer {rkey}", "Content-Type": "application/json"}
)
try:
    resp = ur.urlopen(req)
    result = json.loads(resp.read())
    new_keys = {item.get("envVar", item).get("key") for item in result}
    missing = [k for k in overrides if k not in new_keys]
    if missing:
        print(f"ERROR: vars not confirmed on Render: {missing}", file=sys.stderr)
        sys.exit(1)
    print(f"✅  render_env_set: {len(result)} total vars on Render — {list(overrides.keys())} set.", file=sys.stderr)
except urllib.error.HTTPError as e:
    print(f"HTTPError {e.code}: {e.read().decode()[:300]}", file=sys.stderr)
    sys.exit(1)
PYEOF "$@"
