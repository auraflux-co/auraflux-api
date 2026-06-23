#!/usr/bin/env bash
# Live stream monitor — one process per stream (main or solo Q1–Q4).
# Usage: bash scripts/monitor_live_stream.sh <label> <broadcastId> [quadrant|main]
set -euo pipefail

LABEL="${1:?label required}"
BID="${2:?broadcastId required}"
ROLE="${3:-solo}"
SIDECAR="${LIVE_SIDECAR_URL:-https://auraflux-broadcast-staging.onrender.com}"
INTERVAL="${MONITOR_INTERVAL_SEC:-60}"
SERVICE_ID="${RENDER_BROADCAST_SERVICE_ID:-srv-d8qs41ernols73ej7720}"
LOG_TAG="[monitor:${LABEL}]"

alert() { echo "${LOG_TAG} ALERT: $*"; }
ok()    { echo "${LOG_TAG} OK: $*"; }
info()  { echo "${LOG_TAG} $*"; }

check_youtube_page() {
  local url="https://youtube.com/live/${BID}"
  if command -v yt-dlp >/dev/null 2>&1; then
    local live
    live=$(yt-dlp -j --no-download "$url" 2>/dev/null | python3 -c "
import sys,json
try:
  d=json.load(sys.stdin)
  print('live' if d.get('is_live') else d.get('live_status','unknown'))
except: print('error')
" 2>/dev/null || echo "error")
    echo "$live"
  else
    curl -sL -o /dev/null -w "%{http_code}" "$url" 2>/dev/null || echo "000"
  fi
}

check_sidecar() {
  local status
  status=$(curl -sS --max-time 15 "${SIDECAR}/live-grid/status" 2>/dev/null) || { echo "sidecar_down"; return; }
  echo "$status" | python3 -c "
import sys,json
d=json.load(sys.stdin)
role='${ROLE}'
bid='${BID}'
if role=='main':
  b=d.get('broadcast',{})
  yt=d.get('youtube',{})
  print(json.dumps({
    'grid': d.get('running'),
    'encoder': 'main',
    'yt_lifecycle': yt.get('lifeCycleStatus'),
    'live_on_yt': yt.get('liveOnYouTube'),
    'bid_match': b.get('id')==bid,
    'uptime': d.get('uptimeSec'),
  }))
else:
  q=int(role.replace('Q',''))
  ss=d.get('soloStreams',{})
  seat=next((s for s in ss.get('seats',[]) if s.get('quadrant')==q), {})
  print(json.dumps({
    'grid': d.get('running'),
    'encoder': f'Q{q}',
    'running': seat.get('running'),
    'restarts': seat.get('restarts'),
    'bid_match': seat.get('broadcastId')==bid,
    'feed_unhealthy': next((x.get('feedUnhealthy') for x in d.get('quadrants',[]) if x.get('quadrant')==q), None),
  }))
" 2>/dev/null || echo '{"parse_error":true}'
}

info "started — bid=${BID} role=${ROLE} interval=${INTERVAL}s sidecar=${SIDECAR}"
LAST_RESTARTS=-1
TICK=0

while true; do
  TICK=$((TICK + 1))
  TS=$(TZ=America/New_York date '+%H:%M:%S %Z')
  YT=$(check_youtube_page)
  SC=$(check_sidecar)

  RESTARTS=$(echo "$SC" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('restarts',-1))" 2>/dev/null || echo -1)
  RUNNING=$(echo "$SC" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('running', d.get('grid','?')))" 2>/dev/null || echo "?")
  YT_LC=$(echo "$SC" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('yt_lifecycle',''))" 2>/dev/null || echo "")

  ISSUES=()
  [[ "$YT" != "live" && "$YT" != "is_live" && "$ROLE" == "main" ]] && ISSUES+=("youtube_cdn=${YT}")
  [[ "$YT_LC" == "ready" && "$ROLE" == "main" ]] && ISSUES+=("youtube_lifecycle=ready(upcoming)")
  [[ "$YT_LC" == "complete" ]] && ISSUES+=("youtube_lifecycle=complete")
  [[ "$RUNNING" == "False" || "$RUNNING" == "false" ]] && ISSUES+=("encoder_not_running")
  [[ "$RESTARTS" != "-1" && "$LAST_RESTARTS" != "-1" && "$RESTARTS" -gt "$LAST_RESTARTS" ]] && ISSUES+=("restart_spike=${LAST_RESTARTS}->${RESTARTS}")
  [[ "$RESTARTS" != "-1" ]] && LAST_RESTARTS=$RESTARTS

  FEED=$(echo "$SC" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('feed_unhealthy',''))" 2>/dev/null || echo "")
  [[ "$FEED" == "True" || "$FEED" == "true" ]] && ISSUES+=("feed_unhealthy")

  if ((${#ISSUES[@]})); then
    alert "${TS} tick=${TICK} ${ISSUES[*]} | sidecar=${SC} | yt_page=${YT}"
  else
    ok "${TS} tick=${TICK} live | sidecar=${SC} | yt_page=${YT}"
  fi

  sleep "$INTERVAL"
done
