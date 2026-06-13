#!/bin/bash
# Wait for pipeline idle + operator OK, then start 24h Live Grid measurement run.
#
# Usage:
#   bash scripts/start_24h_grid_when_ready.sh          # waits for logs/start_24h_grid.ok
#   bash scripts/start_24h_grid_when_ready.sh --now    # skip OK file (idle only)
#
# Operator: finish shorts/VODs, then:
#   touch logs/start_24h_grid.ok

set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-3000}"
OK_FILE="logs/start_24h_grid.ok"
SKIP_OK=0
[ "${1:-}" = "--now" ] && SKIP_OK=1

log() { echo "[24h-grid $(date +%H:%M:%S)] $*"; }

jobs_active() {
  curl -sf -m 5 "http://127.0.0.1:${PORT}/jobs" 2>/dev/null | python3 -c "
import sys, json
done = {'published','done','completed','failed','killed',''}
try:
  jobs = json.load(sys.stdin)
  if not isinstance(jobs, list): jobs = []
  active = [j for j in jobs if j.get('stage') and j.get('stage') not in done]
  print(len(active))
except Exception:
  print(0)
" 2>/dev/null || echo 0
}

pipeline_idle() {
  local n
  n=$(jobs_active)
  if [ "$n" != "0" ]; then return 1; fi
  pgrep -f "tmp/asm_" >/dev/null 2>&1 && return 1
  pgrep -f "ffmpeg.*rtmp://" >/dev/null 2>&1 && return 1
  curl -sf -m 3 "http://127.0.0.1:${PORT}/live-grid/status" 2>/dev/null | grep -q '"running":[[:space:]]*true' && return 1
  return 0
}

ensure_env_24h() {
  if grep -q '^LIVE_GRID_WINDOW=' .env 2>/dev/null; then
    sed -i.bak 's/^LIVE_GRID_WINDOW=.*/LIVE_GRID_WINDOW=00:00-24:00/' .env
  else
    echo 'LIVE_GRID_WINDOW=00:00-24:00' >> .env
  fi
  grep -q '^LIVE_GRID_PLATFORM_BENCH=' .env 2>/dev/null || echo 'LIVE_GRID_PLATFORM_BENCH=on' >> .env
  grep -q '^LIVE_GRID_AVATAR_PIP=' .env 2>/dev/null || echo 'LIVE_GRID_AVATAR_PIP=auto' >> .env
}

log "Waiting for operator OK (${OK_FILE}) — touch when shorts + VODs are out..."
while [ "$SKIP_OK" -eq 0 ] && [ ! -f "$OK_FILE" ]; do sleep 30; done

log "Waiting for pipeline idle (no assembly / active jobs / grid live)..."
while ! pipeline_idle; do
  log "still busy ($(jobs_active) active jobs) — checking again in 60s"
  sleep 60
done

log "Idle. Applying 24h window env + safe_restart..."
ensure_env_24h
bash scripts/safe_restart.sh
sleep 8

log "Starting Live Grid (auto mode, public)..."
RESP=$(curl -sf -m 120 -X POST "http://127.0.0.1:${PORT}/live-grid/start" \
  -H 'Content-Type: application/json' \
  -d '{"programMode":"auto","privacyStatus":"public"}')
echo "$RESP" | python3 -m json.tool 2>/dev/null || echo "$RESP"

WATCH=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print((d.get('status') or d).get('broadcast',{}).get('watchUrl',''))" 2>/dev/null || true)
[ -n "$WATCH" ] && log "LIVE: $WATCH"

log "24h timer started — auto-stop in 24 hours..."
(
  sleep 86400
  curl -sf -m 30 -X POST "http://127.0.0.1:${PORT}/live-grid/stop" >/dev/null && log "24h complete — grid stopped"
) &

log "Done. Do not run heavy code/deploy on this machine while grid is live."
