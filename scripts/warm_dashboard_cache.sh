#!/bin/bash
# Warm dashboard disk caches (stats catalog + calendar YouTube/Upload-Post).
# Usage:
#   bash scripts/warm_dashboard_cache.sh          # foreground
#   bash scripts/warm_dashboard_cache.sh --bg     # background (deploy hook)

set -euo pipefail
cd "$(dirname "$0")/.."

if [ "${1:-}" = "--bg" ]; then
  mkdir -p logs
  nohup node scripts/warm_dashboard_cache.js >> logs/dashboard_cache_warm.log 2>&1 &
  echo "✅ Dashboard cache warm started in background (pid $!) — tail logs/dashboard_cache_warm.log"
  exit 0
fi

exec node scripts/warm_dashboard_cache.js
