#!/bin/bash
# CPD-1197 — Sync Content Memory performance from YouTube Analytics.
# Usage:
#   bash scripts/intelligence_sync_cron.sh           # sync only
#   bash scripts/intelligence_sync_cron.sh --backfill  # backfill jobs + sync

set -euo pipefail
cd "$(dirname "$0")/.."

EXTRA_ARGS=()
if [ "${1:-}" = "--backfill" ]; then
  EXTRA_ARGS+=(--backfill)
fi

mkdir -p logs
exec node scripts/intelligence_sync.js "${EXTRA_ARGS[@]}" >> logs/intelligence_sync.log 2>&1
