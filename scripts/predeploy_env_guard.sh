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
# AGENTS: Never use raw `PUT /env-vars` with a partial list — it wipes everything.
# Use the safe helper instead:
#   bash scripts/predeploy_env_guard.sh --set KEY=value [KEY2=value2 ...]
# This does GET→merge→PUT so no existing vars are lost.
#
# Usage:
#   bash scripts/predeploy_env_guard.sh                        # check + auto-restore
#   bash scripts/predeploy_env_guard.sh --dry-run              # print what would change, no write
#   bash scripts/predeploy_env_guard.sh --set FOO=bar BAZ=qux  # safely add/update vars
#   SKIP_PREDEPLOY_ENV_GUARD=1 bash scripts/...                # bypass (NOT recommended)

set -euo pipefail

DRY_RUN=0
SET_MODE=0
SET_PAIRS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --set)
      SET_MODE=1; shift
      while [[ $# -gt 0 && "$1" != --* ]]; do
        SET_PAIRS+=("$1"); shift
      done
      ;;
    *) shift ;;
  esac
done

if [[ "${SKIP_PREDEPLOY_ENV_GUARD:-0}" == "1" ]]; then
  echo "[predeploy_env_guard] SKIPPED (SKIP_PREDEPLOY_ENV_GUARD=1)"
  exit 0
fi

# ── --set mode: safely add/update specific vars without wiping others ────────
if [[ "$SET_MODE" -eq 1 ]]; then
  if [[ ${#SET_PAIRS[@]} -eq 0 ]]; then
    echo "Usage: $0 --set KEY=value [KEY2=value2 ...]"; exit 1
  fi
  RKEY="${RENDER_API_KEY:-$(grep -m1 '^RENDER_API_KEY=' .env 2>/dev/null | cut -d= -f2-)}"
  RSVC="${RENDER_SERVICE_ID:-$(grep -m1 '^RENDER_SERVICE_ID=' .env 2>/dev/null | cut -d= -f2-)}"
  python3 << PYEOF
import json, urllib.request as ur, sys

rkey = "${RKEY}"
rsvc = "${RSVC}"
pairs_raw = """${SET_PAIRS[*]:-}"""

def fetch_all_env_vars(rkey, rsvc):
    """Fetch ALL Render env vars, paging through every 100-item page."""
    all_items = []
    url = f"https://api.render.com/v1/services/{rsvc}/env-vars?limit=100"
    while url:
        req = ur.Request(url, headers={"Authorization": f"Bearer {rkey}", "Accept": "application/json"})
        with ur.urlopen(req) as r:
            page = json.loads(r.read())
        if not isinstance(page, list):
            print(f"ERROR fetching env vars: {page}", file=sys.stderr)
            sys.exit(1)
        all_items.extend(page)
        url = None if len(page) < 100 else f"https://api.render.com/v1/services/{rsvc}/env-vars?limit=100&cursor={all_items[-1].get('cursor','')}"
    return all_items

current_raw = fetch_all_env_vars(rkey, rsvc)

# Start with existing vars
merged = {item.get("envVar", item)["key"]: item.get("envVar", item)["value"] for item in current_raw}

# Apply the --set overrides
for pair in pairs_raw.strip().split():
    k, _, v = pair.partition("=")
    if k:
        merged[k] = v
        print(f"  SET {k} = {v[:20]}{'...' if len(v)>20 else ''}")

payload = json.dumps([{"key": k, "value": v} for k, v in merged.items()]).encode()
req = ur.Request(f"https://api.render.com/v1/services/{rsvc}/env-vars",
    data=payload, method="PUT",
    headers={"Authorization": f"Bearer {rkey}", "Content-Type": "application/json"})
resp = ur.urlopen(req)
result = json.loads(resp.read())
print(f"✅ Set {len([p for p in pairs_raw.split() if '=' in p])} var(s) — {len(result)} total vars preserved on Render.")
PYEOF
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

# ── 1. GET current env vars from Render (paginated — fetches ALL pages) ─────
CURRENT_JSON=$(python3 << 'FETCHEOF'
import json, urllib.request as ur, sys, os

rkey = open(".env").read()
rkey = [l.split("=",1)[1].strip() for l in rkey.splitlines() if l.startswith("RENDER_API_KEY=")][0]
rsvc = [l.split("=",1)[1].strip() for l in open(".env").read().splitlines() if l.startswith("RENDER_SERVICE_ID=")][0]

# Override from env vars if set (allows CI usage)
rkey = os.environ.get("RENDER_API_KEY", rkey)
rsvc = os.environ.get("RENDER_SERVICE_ID", rsvc)

all_items = []
url = f"https://api.render.com/v1/services/{rsvc}/env-vars?limit=100"
while url:
    req = ur.Request(url, headers={"Authorization": f"Bearer {rkey}", "Accept": "application/json"})
    with ur.urlopen(req) as r:
        page = json.loads(r.read())
    if not isinstance(page, list):
        print(f"[]", file=sys.stdout)
        sys.exit(0)
    all_items.extend(page)
    url = None if len(page) < 100 else f"https://api.render.com/v1/services/{rsvc}/env-vars?limit=100&cursor={all_items[-1].get('cursor','')}"

print(json.dumps(all_items))
FETCHEOF
)

CURRENT_COUNT=$(echo "$CURRENT_JSON" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo 0)
echo "[predeploy_env_guard] ${CURRENT_COUNT} vars currently on Render (all pages fetched)."

# ── 2. Build canonical list from .env (skip local-only vars) ────────────────
LOCAL_SKIP_PREFIXES="http://localhost,http://127"
# Keys to skip — local-dev-only vars that must never reach Render.
# DO NOT add production vars here (NODE_ENV, TZ, NODE_OPTIONS, etc.) — if a
# destructive PUT ever wipes Render vars, the guard can only restore what it
# knows about. Production vars belong in .env, not in this skip list.
LOCAL_SKIP_KEYS="VECTCUT_API_URL,DASHBOARD_PORT,ATLASSIAN_API_TOKEN,ATLASSIAN_DOMAIN,ATLASSIAN_EMAIL,JIRA_PROJECT_KEY,JIRA_WEBHOOK_SECRET,CONFLUENCE_SPACE_KEY,NEW_RELIC_APP_NAME,NEW_RELIC_LICENSE_KEY,NEW_RELIC_USER_KEY,RENDER_API_KEY,GATE_TEST_MODE,PORT,PUPPETEER_EXECUTABLE_PATH,USE_LOCAL_FFMPEG"

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

# ── 2b. Warn for REQUIRED vars that are empty/missing in .env ───────────────
python3 << 'REQEOF'
# REQUIRED keys that must have a value in .env (not just on Render).
# If empty → warn loudly but don't block (they may already be set on Render).
REQUIRED_KEYS = [
    ("GITHUB_API_TOKEN", "BLOCKING — marketing site reverts on deploy. Generate at https://github.com/settings/tokens (Fine-grained, Contents:read+write on auraflux-co/auraflux-api)"),
    ("SENTRY_DSN",       "Sentry disabled — get from https://auraflux.sentry.io → Settings → Projects → Client Keys"),
]
env = {}
with open(".env") as f:
    for line in f:
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, _, v = line.partition("=")
            env[k.strip()] = v.strip()

warned = False
for key, hint in REQUIRED_KEYS:
    if not env.get(key):
        if not warned:
            print("\n⚠️   predeploy_env_guard: REQUIRED vars missing from .env (must be filled in by operator):")
            warned = True
        print(f"     - {key}: {hint}")
if warned:
    print()
REQEOF

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
