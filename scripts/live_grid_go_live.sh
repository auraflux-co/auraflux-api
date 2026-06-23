#!/usr/bin/env bash
# Wait until target time (default 6:00 PM America/New_York), preflight, start live grid.
# Requires: NEW Studio listing on LIVE_GRID_RTMP_URL stream key — update .env BROADCAST_ID first.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="${1:-$ROOT/config/live_grid_go_live.json}"
SIDECAR="${LIVE_SIDECAR_URL:-http://127.0.0.1:3001}"
TARGET_TIME="${GO_LIVE_TIME:-18:00}"

cd "$ROOT"

load_env() {
  [[ -f "$ROOT/.env" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[A-Z][A-Z0-9_]*= ]] || continue
    export "$line"
  done < "$ROOT/.env"
}

wait_until_et() {
  local target="$1"
  python3 - "$target" <<'PY'
import sys, time
from datetime import datetime
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
h, m = map(int, sys.argv[1].split(":"))
while True:
    now = datetime.now(ET)
    tgt = now.replace(hour=h, minute=m, second=0, microsecond=0)
    if now >= tgt:
        print(f"Go-live time reached ({now.strftime('%H:%M:%S %Z')})")
        break
    sec = (tgt - now).total_seconds()
    print(f"Waiting {int(sec)}s until {tgt.strftime('%H:%M %Z')} ({now.strftime('%H:%M:%S')})…")
    time.sleep(min(sec, 30))
PY
}

load_env

broadcast_id_ok() {
  python3 - "$CONFIG" "$1" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1]))
bid = sys.argv[2]
dead = set(cfg.get("deadBroadcastIds") or [])
sys.exit(0 if bid and bid not in dead else 1)
PY
}

BID="${LIVE_GRID_BROADCAST_ID:-}"
if ! broadcast_id_ok "$BID"; then
  if [[ "${WAIT_FOR_BROADCAST_ID:-}" == "1" ]]; then
    echo "Waiting for NEW LIVE_GRID_BROADCAST_ID in .env (not in dead list)…"
    while true; do
      load_env
      BID="${LIVE_GRID_BROADCAST_ID:-}"
      if broadcast_id_ok "$BID"; then
        echo "New broadcast ID: $BID"
        break
      fi
      sleep 15
    done
  elif [[ -z "$BID" ]]; then
    echo "ERROR: LIVE_GRID_BROADCAST_ID not set in .env"
    echo "Create a NEW listing in YouTube Studio on stream key q213-xgt5-… then paste the video ID."
    exit 1
  else
    echo "ERROR: LIVE_GRID_BROADCAST_ID is a closed listing ($BID)."
    echo "Create NEW listing in Studio → update .env → re-run (or WAIT_FOR_BROADCAST_ID=1 bash scripts/live_grid_go_live.sh)"
    exit 1
  fi
fi

echo "=== Live Grid Go Live ==="
echo "Broadcast: $BID"
echo "Watch: ${LIVE_GRID_WATCH_URL:-https://youtube.com/live/$BID}"
echo "Target:  $TARGET_TIME America/New_York"
echo ""
echo "Before encoder starts: Studio → Go live on listing $BID (or right after RTMP connects)."
echo ""

wait_until_et "$TARGET_TIME"

echo "Running E2E lockdown preflight…"
bash "$ROOT/scripts/live_grid_e2e_lockdown.sh" preflight || {
  echo "E2E lockdown failed — run: bash scripts/live_grid_e2e_lockdown.sh restore"
  exit 1
}

echo "Starting grid (locked payload)…"
python3 - "$ROOT" "$SIDECAR" <<'PY'
import json, sys, os, urllib.request

sys.path.insert(0, sys.argv[1])
from lib.live_grid.e2e_lockdown import buildLockedStartPayload

base = sys.argv[2].rstrip("/")
body = buildLockedStartPayload()
req = urllib.request.Request(
    f"{base}/live-grid/start",
    data=json.dumps(body).encode(),
    headers={"Content-Type": "application/json"},
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=120) as r:
        out = json.loads(r.read().decode())
except urllib.error.HTTPError as e:
    print(e.read().decode())
    raise SystemExit(1)
print(json.dumps(out, indent=2))
watch = (out.get("status") or {}).get("broadcast") or {}
url = watch.get("watchUrl") or watch.get("watch_url")
if url:
    print(f"\nLIVE → {url}")
    print("YouTube receives RTMP automatically — do not click Studio Go Live.")
PY
