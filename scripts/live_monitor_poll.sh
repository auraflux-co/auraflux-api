#!/usr/bin/env bash
# One-shot or loop poll for live-monitor — used by Cursor subagents / operator.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
API="${LIVE_MONITOR_URL:-http://127.0.0.1:3000/broadcast/live-monitor}"
INTERVAL="${LIVE_MONITOR_POLL_SEC:-60}"
LOOP="${1:-once}"

poll() {
  curl -sf "$API" | python3 -c "
import json, sys
d = json.load(sys.stdin)
print('--- live-monitor', d.get('updatedAt', '?'))
print('level:', d.get('level'), '| stable:', d.get('isStable'), '| streak:', d.get('stableStreak'), '/', d.get('stableTicksRequired'))
g = d.get('grid') or {}
print('on-air: Q{} {} mode {}'.format(g.get('onAirQuad','?'), g.get('onAirLogin',''), g.get('audioMode','?')))
av = d.get('av') or {}
print('av: video', av.get('videoLevel'), av.get('videoScore'), '| audio', av.get('audioLevel'), av.get('audioScore'))
if d.get('gridChanges'):
    print('grid changes:', d['gridChanges'])
if d.get('blockers'):
    print('BLOCKERS:', d['blockers'])
if d.get('isStable'):
    print('STABLE — monitoring can stop')
"
}

if [[ "$LOOP" == "loop" ]]; then
  while true; do
    poll || echo "(poll failed — is auraflux up?)"
    sleep "$INTERVAL"
  done
else
  poll
fi
