#!/bin/bash
# safe_restart.sh — the ONLY sanctioned way to restart the auraflux pm2 process.
#
# CPD-996 family: a pm2 restart while the live grid / ClipzWorld TV is broadcasting
# kills the ffmpeg encoder mid-push. YouTube keeps the broadcast "live" with no
# input (viewers see infinite spinner) and if API quota is exhausted the boot
# reconcile guard cannot end the orphan. A restart during assembly kills the
# assembly ffmpeg (exit 255) and strands the job at gates.
#
# Usage:
#   bash scripts/safe_restart.sh           # refuses if anything live is detected
#   bash scripts/safe_restart.sh --force   # restart anyway (you own the orphan)

set -u
PORT="${PORT:-3000}"
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

BLOCKERS=()

# 1. Live grid broadcasting?
GRID=$(curl -s -m 3 "http://127.0.0.1:${PORT}/live-grid/status" 2>/dev/null)
if echo "$GRID" | grep -q '"running":[[:space:]]*true'; then
  BLOCKERS+=("Live Grid is BROADCASTING (GET /live-grid/status running:true) — end the stream first: POST /live-grid/stop")
fi

# 2. ClipzWorld TV streaming?
TV=$(curl -s -m 3 "http://127.0.0.1:${PORT}/live-tv/status" 2>/dev/null)
if echo "$TV" | grep -qE '"(running|streaming)":[[:space:]]*true'; then
  BLOCKERS+=("ClipzWorld TV is STREAMING (GET /live-tv/status) — end it first: POST /live-tv/stop")
fi

# 3. Assembly in flight?
if pgrep -f "tmp/asm_" >/dev/null 2>&1; then
  BLOCKERS+=("Assembly ffmpeg running (pgrep -f tmp/asm_) — wait for the job to finish")
fi

# 4. Any ffmpeg pushing to an RTMP ingest (belt and braces — catches paths 1+2
#    even if the status endpoints are unreachable)?
if pgrep -f "ffmpeg.*rtmp://" >/dev/null 2>&1; then
  BLOCKERS+=("An ffmpeg process is pushing to RTMP (pgrep -f 'ffmpeg.*rtmp://')")
fi

if [ ${#BLOCKERS[@]} -gt 0 ] && [ $FORCE -ne 1 ]; then
  echo "⛔ RESTART BLOCKED — live work detected:"
  for b in "${BLOCKERS[@]}"; do echo "   • $b"; done
  echo ""
  echo "Stop the stream/job first, or rerun with --force if you accept an orphaned broadcast."
  exit 1
fi

[ $FORCE -eq 1 ] && [ ${#BLOCKERS[@]} -gt 0 ] && echo "⚠️  --force: restarting despite live work. You own the cleanup."

pm2 restart auraflux
