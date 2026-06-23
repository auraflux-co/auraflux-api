#!/usr/bin/env bash
# Start 5 Gemini visual watchers (main + Q1–Q4 solos).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p logs

pkill -f "gemini_live_watch_all.js" 2>/dev/null || true
pkill -f "gemini_live_watcher.js" 2>/dev/null || true
sleep 1

nohup node scripts/gemini_live_watch_all.js >> logs/gemini_watch_all.log 2>&1 &
echo "started supervisor pid=$!"
echo "Summary: logs/gemini_watch_summary.jsonl | Rollup: logs/gemini_watch_rollup.txt"
