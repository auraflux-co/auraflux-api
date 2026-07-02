#!/bin/bash
# CPD-1197 — Sync Content Memory performance from YouTube Analytics.
# CPD-1209 — optional competitor catalog sync (yt-dlp, slow).
# Usage:
#   bash scripts/intelligence_sync_cron.sh                 # sync only
#   bash scripts/intelligence_sync_cron.sh --backfill      # backfill jobs + sync
#   bash scripts/intelligence_sync_cron.sh --competitors   # + competitor catalog sync

set -euo pipefail
cd "$(dirname "$0")/.."

EXTRA_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --backfill) EXTRA_ARGS+=(--backfill) ;;
    --competitors) EXTRA_ARGS+=(--competitors) ;;
  esac
done

mkdir -p logs
exec node scripts/intelligence_sync.js "${EXTRA_ARGS[@]}" >> logs/intelligence_sync.log 2>&1
