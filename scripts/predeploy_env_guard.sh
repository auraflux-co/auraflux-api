#!/usr/bin/env bash
# scripts/predeploy_env_guard.sh
#
# MANDATORY pre-deploy guard. Run this before triggering ANY Render deploy.
#
# What it does:
#   1. GETs current Render env vars
#   2. Compares against the canonical list from .env (truth source)
#   3. If any required vars are missing → auto-restores them from .env (safe GET-merge-PUT)
#   4. Verifies the restore succeeded
#   5. Exits 0 (deploy can proceed) or 1 (unrecoverable — stop the deploy)
#
# This is the permanent fix for the "env vars wiped on every deploy" problem.
# Root cause: render.yaml Blueprint sync clears sync:false vars with no value;
# agents calling PUT /env-vars with partial lists wipe the rest.
# This script ensures the full set is always restored before any deploy fires.
#
# Usage:
#   bash scripts/predeploy_env_guard.sh                  # check + auto-restore
#   bash scripts/predeploy_env_guard.sh --dry-run        # print what would change, no write
#   SKIP_PREDEPLOY_ENV_GUARD=1 bash scripts/...          # bypass (NOT recommended)

set -euo pipefail

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

if [[ "${SKIP_PREDEPLOY_ENV_GUARD:-0}" == "1" ]]; then
  echo "[predeploy_env_guard] SKIPPED (SKIP_PREDEPLOY_ENV_GUARD=1)"
  exit 0
fi

# ── Resolve credentials ──────────────────────────────────────────────────────
RKEY="${RENDER_API_KEY:-$(grep -m1 '^RENDER_API_KEY=' .env 2>/dev/null | cut -d= -f2-)}"
RSVC="${RENDER_SERVICE_ID:-$(grep -m1 '^RENDER_SERVICE_ID=' .env 2>/dev/null | cut -d= -f2-)}"

if [[ -z "$RKEY" || -z "$RSVC" ]]; then
  echo "❌  predeploy_env_guard: RENDER_API_KEY or RENDER_SERVICE_ID not set — cannot guard."
  exit 1
fi

echo "[predeploy_env_guard] Fetching current Render env vars for ${RSVC}..."

# ── 1. GET current env vars from Render ─────────────────────────────────────
CURRENT_JSON=$(curl -sf \
  -H "Authorization: Bearer ${RKEY}" \
  "https://api.render.com/v1/services/${RSVC}/env-vars?limit=100")

CURRENT_COUNT=$(echo "$CURRENT_JSON" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo 0)
echo "[predeploy_env_guard] ${CURRENT_COUNT} vars currently on Render."

# ── 2. Build canonical list from .env (skip local-only vars) ────────────────
LOCAL_SKIP_PREFIXES="http://localhost,http://127"
LOCAL_SKIP_KEYS="VECTCUT_API_URL,DASHBOARD_PORT,ATLASSIAN_API_TOKEN,ATLASSIAN_DOMAIN,ATLASSIAN_EMAIL,JIRA_PROJECT_KEY,JIRA_WEBHOOK_SECRET,CONFLUENCE_SPACE_KEY,NEW_RELIC_APP_NAME,NEW_RELIC_LICENSE_KEY,NEW_RELIC_USER_KEY,RENDER_API_KEY,GATE_TEST_MODE"

CANONICAL_JSON=$(python3 << PYEOF
import json

skip_keys = set("${LOCAL_SKIP_KEYS}".split(","))
canonical = {}

with open(".env") as f:
    for line in f:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k, v = k.strip(), v.strip()
        if k in skip_keys or not v:
            continue
        if v.startswith("http://localhost") or v.startswith("http://127"):
            continue
        canonical[k] = v

print(json.dumps(canonical))
PYEOF
)

CANONICAL_COUNT=$(echo "$CANONICAL_JSON" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))")
echo "[predeploy_env_guard] ${CANONICAL_COUNT} canonical vars in .env."

# ── 3. Find missing vars ─────────────────────────────────────────────────────
RESULT=$(python3 << PYEOF
import json, sys

current_raw = json.loads('''${CURRENT_JSON}''')
canonical = json.loads('''${CANONICAL_JSON}''')

current_keys = set()
for item in current_raw:
    ev = item.get("envVar", item)
    current_keys.add(ev.get("key", ""))

missing = {k: v for k, v in canonical.items() if k not in current_keys}
print(json.dumps(missing))
PYEOF
)

MISSING_COUNT=$(echo "$RESULT" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))")

if [[ "$MISSING_COUNT" -eq 0 ]]; then
  echo "✅  predeploy_env_guard: all vars present — deploy can proceed."
  exit 0
fi

# ── 4. Missing vars found — report them ─────────────────────────────────────
echo ""
echo "⚠️   predeploy_env_guard: ${MISSING_COUNT} vars missing from Render:"
echo "$RESULT" | python3 -c "
import sys, json
missing = json.load(sys.stdin)
for k in sorted(missing):
    v = missing[k]
    masked = v[:4] + '...' if len(v) > 4 else '***'
    print(f'     - {k} = {masked}')
"
echo ""

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[predeploy_env_guard] DRY RUN — no changes written."
  echo "❌  Would block deploy (${MISSING_COUNT} vars missing)."
  exit 1
fi

# ── 5. Auto-restore: GET current, merge missing vars, PUT full set ───────────
echo "[predeploy_env_guard] Auto-restoring ${MISSING_COUNT} missing vars from .env..."

python3 << PYEOF
import json, urllib.request as ur, urllib.error, sys

rkey = "${RKEY}"
rsvc = "${RSVC}"
current_raw = json.loads('''${CURRENT_JSON}''')
missing = json.loads('''${RESULT}''')

# Build the full merged list
existing = [{"key": item.get("envVar", item).get("key"), "value": item.get("envVar", item).get("value")} for item in current_raw]
to_add = [{"key": k, "value": v} for k, v in missing.items()]
merged = existing + to_add

payload = json.dumps(merged).encode()
req = ur.Request(
    f"https://api.render.com/v1/services/{rsvc}/env-vars",
    data=payload, method="PUT",
    headers={"Authorization": f"Bearer {rkey}", "Content-Type": "application/json"}
)
try:
    resp = ur.urlopen(req)
    result = json.loads(resp.read())
    print(f"[predeploy_env_guard] PUT ok — {len(result)} total vars now on Render.")
    new_keys = {item.get("envVar", item).get("key") for item in result}
    still_missing = [k for k in missing if k not in new_keys]
    if still_missing:
        print(f"ERROR: still missing after restore: {still_missing}", file=sys.stderr)
        sys.exit(1)
    print(f"[predeploy_env_guard] Restore verified — all {len(missing)} vars confirmed present.")
except urllib.error.HTTPError as e:
    print(f"HTTPError {e.code}: {e.read().decode()[:300]}", file=sys.stderr)
    sys.exit(1)
PYEOF

echo ""
echo "✅  predeploy_env_guard: restored ${MISSING_COUNT} vars — deploy can now proceed."
