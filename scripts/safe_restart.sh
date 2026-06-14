#!/bin/bash
# safe_restart.sh — restart auraflux when safe.
#
# With broadcast-sidecar (default): live streams run in pm2 process
# broadcast-sidecar — this script only restarts auraflux and does NOT
# stop Twitch/YouTube. Use scripts/deploy_c0.sh for code deploys.
#
# Without sidecar: blocks if Live Grid / ClipzWorld TV / RTMP ffmpeg detected.
#
# Usage:
#   bash scripts/safe_restart.sh
#   bash scripts/safe_restart.sh --force

set -u
PORT="${PORT:-3000}"
SIDECAR_PORT="${LIVE_SIDECAR_PORT:-3001}"
SIDECAR_URL="${LIVE_SIDECAR_URL:-http://127.0.0.1:${SIDECAR_PORT}}"
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

BLOCKERS=()
SIDECAR_UP=0
if curl -sf -m 2 "${SIDECAR_URL}/live-broadcast/health" >/dev/null 2>&1; then
  SIDECAR_UP=1
fi

if [ $SIDECAR_UP -eq 0 ]; then
  GRID=$(curl -s -m 3 "http://127.0.0.1:${PORT}/live-grid/status" 2>/dev/null)
  if echo "$GRID" | grep -q '"running":[[:space:]]*true'; then
    BLOCKERS+=("Live Grid is BROADCASTING on main server — start broadcast-sidecar or POST /live-grid/stop")
  fi

  TV=$(curl -s -m 3 "http://127.0.0.1:${PORT}/live-tv/status" 2>/dev/null)
  if echo "$TV" | grep -qE '"(running|streaming)":[[:space:]]*true'; then
    BLOCKERS+=("ClipzWorld TV is STREAMING on main server — start broadcast-sidecar or POST /live-tv/stop")
  fi

  if pgrep -f "ffmpeg.*rtmp://" >/dev/null 2>&1; then
    BLOCKERS+=("ffmpeg pushing RTMP without sidecar — migrate to broadcast-sidecar first")
  fi
else
  echo "ℹ️  broadcast-sidecar active — streams will survive this auraflux restart"
fi

if pgrep -f "tmp/asm_" >/dev/null 2>&1; then
  BLOCKERS+=("Assembly ffmpeg running (pgrep -f tmp/asm_) — wait for the job to finish")
fi

if [ ${#BLOCKERS[@]} -gt 0 ] && [ $FORCE -ne 1 ]; then
  echo "⛔ RESTART BLOCKED:"
  for b in "${BLOCKERS[@]}"; do echo "   • $b"; done
  echo ""
  echo "Use: bash scripts/deploy_c0.sh (sidecar deploy) or --force if you accept killing streams."
  exit 1
fi

[ $FORCE -eq 1 ] && [ ${#BLOCKERS[@]} -gt 0 ] && echo "⚠️  --force: restarting despite blockers."

pm2 restart auraflux
