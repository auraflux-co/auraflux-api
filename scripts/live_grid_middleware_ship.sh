#!/usr/bin/env bash
# Apply / verify / restore Live Grid middleware flags (.env) — run when grid is OFF.
# Does NOT restart pm2 — you restart broadcast-sidecar after stream ends when ready.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="$ROOT/config/live_grid_profile_middleware_lab.json"
ENV_FILE="$ROOT/.env"
BACKUP="$ROOT/config/.env.pre_middleware_backup"

load_profile_env() {
  python3 - "$PROFILE" <<'PY'
import json, sys
for k, v in json.load(open(sys.argv[1])).get("env", {}).items():
    print(f"{k}={v}")
PY
}

apply_env() {
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "ERROR: $ENV_FILE missing"
    exit 1
  fi
  cp "$ENV_FILE" "$BACKUP"
  echo "Backed up .env → config/.env.pre_middleware_backup"
  while IFS= read -r line; do
    key="${line%%=*}"
    val="${line#*=}"
    if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
      if [[ "$(uname)" == Darwin ]]; then
        sed -i '' "s|^${key}=.*|${key}=${val}|" "$ENV_FILE"
      else
        sed -i "s|^${key}=.*|${key}=${val}|" "$ENV_FILE"
      fi
    else
      echo "${key}=${val}" >> "$ENV_FILE"
    fi
  done < <(load_profile_env)
  echo "Applied middleware profile env keys from $PROFILE"
  echo ""
  echo "Next steps (after stream ended):"
  echo "  1. pm2 restart broadcast-sidecar --update-env"
  echo "  2. Private lab start — see config/live_grid_profile_middleware_lab.json shipChecklist"
}

verify_env() {
  echo "=== Middleware env verify ==="
  local ok=1
  while IFS= read -r line; do
    key="${line%%=*}"
    want="${line#*=}"
    have="$(grep "^${key}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true)"
    if [[ "$have" == "$want" ]]; then
      echo "OK  $key=$have"
    else
      echo "MISMATCH  $key want=$want have=${have:-<unset>}"
      ok=0
    fi
  done < <(load_profile_env)
  curl -sf "${LIVE_SIDECAR_URL:-http://127.0.0.1:3001}/live-grid/status" | python3 - <<'PY' || true
import json,sys
try:
  d=json.load(sys.stdin)
  m=(d.get("middleware") or {})
  print("status.middleware:", json.dumps(m, indent=2))
except Exception as e:
  print("sidecar status skip:", e)
PY
  [[ "$ok" -eq 1 ]] || exit 1
  echo "Verify passed."
}

restore_env() {
  if [[ ! -f "$BACKUP" ]]; then
    echo "No backup at $BACKUP — set LIVE_GRID_OUTPUT_MIDDLEWARE=off LIVE_GRID_STAGED_SWAP=off manually"
    exit 1
  fi
  cp "$BACKUP" "$ENV_FILE"
  echo "Restored .env from backup. Restart sidecar when grid is off."
}

cmd="${1:-apply}"
case "$cmd" in
  apply) apply_env ;;
  verify) verify_env ;;
  restore) restore_env ;;
  *)
    echo "Usage: bash scripts/live_grid_middleware_ship.sh [apply|verify|restore]"
    exit 1
    ;;
esac
