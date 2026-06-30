#!/bin/bash
# deploy_c0.sh — deploy code to C0 WITHOUT killing live broadcasts.
#
# Restarts ONLY the auraflux API/dashboard process. The broadcast sidecar
# (ClipzWorld TV + Live Grid ffmpeg) keeps running on pm2 process
# broadcast-sidecar.
#
# PM2 restart counter (↺): increments on every deploy — high counts during
# active dev sessions are expected, not necessarily instability.
#
# Usage:
#   bash scripts/deploy_c0.sh
#
# First-time setup (once):
#   pm2 start ecosystem.config.js   # starts auraflux + broadcast-sidecar + job-monitor
#   pm2 save

set -euo pipefail
cd "$(dirname "$0")/.."

SIDECAR_PORT="${LIVE_SIDECAR_PORT:-3001}"
SIDECAR_URL="${LIVE_SIDECAR_URL:-http://127.0.0.1:${SIDECAR_PORT}}"

if ! curl -sf -m 2 "${SIDECAR_URL}/live-broadcast/health" >/dev/null 2>&1; then
  echo "⚠️  Broadcast sidecar not running at ${SIDECAR_URL}"
  echo "   Start it: pm2 start ecosystem.config.js --only broadcast-sidecar"
  echo "   Without sidecar, pm2 restart auraflux WILL drop Twitch/YouTube mid-stream."
  if [ "${DEPLOY_FORCE:-}" != "1" ]; then
    echo "   Set DEPLOY_FORCE=1 to restart auraflux anyway."
    exit 1
  fi
else
  HEALTH=$(curl -sf -m 3 "${SIDECAR_URL}/live-broadcast/health")
  echo "✅ Sidecar up — streams survive this deploy"
  echo "   ${HEALTH}"
fi

# Block if assembly running (same as safe_restart minus stream check — sidecar owns streams)
BLOCKERS=()
if pgrep -f "tmp/asm_" >/dev/null 2>&1; then
  BLOCKERS+=("Assembly ffmpeg running — wait for job to finish")
fi
if [ ${#BLOCKERS[@]} -gt 0 ]; then
  echo "⛔ Deploy blocked:"
  for b in "${BLOCKERS[@]}"; do echo "   • $b"; done
  exit 1
fi

echo "🚀 Restarting auraflux only (broadcast-sidecar untouched)…"
pm2 restart auraflux --update-env

GRID_RUNNING=$(curl -sf -m 3 "${SIDECAR_URL}/live-grid/status" 2>/dev/null | grep -q '"running":[[:space:]]*true' && echo 1 || echo 0)
if [ "$GRID_RUNNING" = "0" ]; then
  echo "🔄 Grid offline — reloading broadcast-sidecar (picks up feeder/code changes)…"
  pm2 restart broadcast-sidecar
else
  echo "ℹ️  Grid is live on sidecar — code changes apply on next grid stop + sidecar restart"
fi

echo "✅ Deploy complete — dashboard/API on :3000; streams on sidecar :${SIDECAR_PORT}"

# Ensure dashboard cache warmer is registered (pm2 cron — every 20 min by default)
if pm2 describe dashboard-cache-warm >/dev/null 2>&1; then
  pm2 restart dashboard-cache-warm --update-env >/dev/null 2>&1 || true
else
  pm2 start ecosystem.config.js --only dashboard-cache-warm --update-env >/dev/null 2>&1 || true
fi
pm2 save >/dev/null 2>&1 || true
bash scripts/warm_dashboard_cache.sh --bg
