#!/usr/bin/env bash
# Known-good Live Grid baseline — apply / verify / restore after troubleshooting.
# Profile: config/live_grid_profile_baseline.json (2026-06-17 overnight lock-in)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="$ROOT/config/live_grid_profile_baseline.json"
ENV_FILE="$ROOT/.env"
MARK_BEGIN="# === LIVE GRID BASELINE (do not edit by hand — scripts/live_grid_baseline.sh) ==="
MARK_END="# === END LIVE GRID BASELINE ==="

usage() {
  cat <<EOF
Usage: bash scripts/live_grid_baseline.sh <command>

  apply    Write baseline LIVE_GRID_* vars into .env (grid should be OFF)
  verify   Check .env, ecosystem, and running master match baseline
  preflight  Env + RTMP plan + unit tests (safe while grid OFF)
  restore  apply + pm2 restart broadcast-sidecar (does not start grid)
  probe    10s HLS silence-gap count (0 = good)

Return here after experiments:  bash scripts/live_grid_baseline.sh restore
EOF
}

require_profile() {
  [[ -f "$PROFILE" ]] || { echo "Missing $PROFILE"; exit 1; }
}

baseline_env_lines() {
  python3 - "$PROFILE" <<'PY'
import json, sys
p = json.load(open(sys.argv[1]))
for k, v in p["env"].items():
    print(f"{k}={v}")
PY
}

apply_baseline() {
  require_profile
  local tmp block
  block="$(baseline_env_lines)"
  tmp="$(mktemp)"
  if grep -q "$MARK_BEGIN" "$ENV_FILE" 2>/dev/null; then
    awk -v begin="$MARK_BEGIN" -v end="$MARK_END" -v block="$block" '
      $0 == begin { print; print block; skip=1; next }
      skip && $0 == end { skip=0; print; next }
      !skip { print }
    ' "$ENV_FILE" > "$tmp"
  else
    {
      echo ""
      echo "$MARK_BEGIN"
      echo "$block"
      echo "$MARK_END"
    } >> "$ENV_FILE"
    cp "$ENV_FILE" "$tmp"
  fi
  mv "$tmp" "$ENV_FILE"
  echo "Applied baseline env block to .env"
  echo "Next: pm2 restart broadcast-sidecar --update-env"
}

verify_baseline() {
  require_profile
  local fail=0
  echo "=== Baseline verify ($PROFILE) ==="

  while IFS='=' read -r k v; do
    [[ -z "$k" ]] && continue
    if grep -q "^${k}=${v}$" "$ENV_FILE" 2>/dev/null; then
      echo "  OK  .env $k=$v"
    else
      actual="$(grep "^${k}=" "$ENV_FILE" 2>/dev/null | tail -1 || echo 'missing')"
      echo "  FAIL .env $k (want $v, got ${actual#*=})"
      fail=1
    fi
  done < <(baseline_env_lines)

  for k in LIVE_GRID_LOCAL_HLS LIVE_GRID_AUDIO_DIRECT LIVE_GRID_AUDIO_COPY; do
    if grep -q "${k}: 'on'" "$ROOT/ecosystem.config.js" 2>/dev/null; then
      echo "  OK  ecosystem $k=on"
    else
      echo "  FAIL ecosystem missing $k=on in broadcast-sidecar"
      fail=1
    fi
  done

  if pgrep -fl "ffmpeg.*tee.*preview/index.m3u8" >/dev/null 2>&1; then
    local master_line
    master_line="$(pgrep -fl "ffmpeg.*tee.*preview/index.m3u8" | head -1 || true)"
    if echo "$master_line" | grep -q 'pad=1080:1080'; then
      echo "  FAIL master square-pads RTMP (set LIVE_GRID_YOUTUBE_SQUARE_PAD=off)"
      fail=1
    else
      echo "  OK  master RTMP not square-padded"
    fi
    if echo "$master_line" | grep -qE '\-s 1920x1080'; then
      echo "  OK  master explicit 1920x1080 RTMP size"
    else
      echo "  WARN master missing -s 1920x1080 (restart sidecar after compositor update)"
    fi
    if grep -q '^LIVE_GRID_AUDIO_COPY=off' "$ENV_FILE" 2>/dev/null; then
      if echo "$master_line" | grep -q 'volume@aq'; then
        echo "  OK  master hot-switch volume gates (AUDIO_COPY=off)"
      else
        echo "  FAIL master missing volume@aq gates"
        fail=1
      fi
      if echo "$master_line" | grep -q 'amix=inputs=4'; then
        echo "  OK  master amix for hot-switch audio"
      else
        echo "  FAIL master missing amix=inputs=4"
        fail=1
      fi
    elif echo "$master_line" | grep -qE '\-map [0-3]:a' && echo "$master_line" | grep -q '\-c:a copy'; then
      echo "  OK  master direct audio copy (AUDIO_COPY=on)"
    else
      echo "  FAIL master audio map/encode mismatch"
      fail=1
    fi
  else
    echo "  SKIP master not running (start grid to verify runtime)"
  fi

  if [[ "$fail" -eq 0 ]]; then
    echo "Baseline OK"
  else
    echo "Baseline DRIFT — run: bash scripts/live_grid_baseline.sh apply && pm2 restart broadcast-sidecar --update-env"
    exit 1
  fi
}

probe_baseline() {
  local url="${1:-http://127.0.0.1:3000/broadcast/preview-hls/index.m3u8}"
  echo "Probing 10s HLS gaps: $url"
  local n
  n="$(ffmpeg -hide_banner -loglevel error -i "$url" -t 10 -vn -sn -ac 1 -ar 16000 \
    -af silencedetect=noise=-38dB:d=0.06 -f null - 2>&1 | grep -c silence_end || true)"
  echo "silence_end events in 10s: $n (baseline target: 0)"
  [[ "$n" -le 1 ]] || exit 1
}

preflight_baseline() {
  echo "=== Live Grid preflight ==="
  node -e "
    const { runPreflight } = require('./lib/live_grid/preflight');
    const r = runPreflight();
    console.log(JSON.stringify(r, null, 2));
    if (!r.ok) process.exit(1);
  "
}

restore_baseline() {
  if curl -sf http://127.0.0.1:3001/live-grid/status 2>/dev/null | grep -q '"running":true'; then
    echo "Stopping live grid before restore..."
    curl -sf -X POST http://127.0.0.1:3001/live-grid/stop >/dev/null || true
    sleep 2
  fi
  apply_baseline
  pm2 restart broadcast-sidecar --update-env
  echo "Baseline restored. Start grid when ready: curl -X POST http://127.0.0.1:3001/live-grid/start"
}

cmd="${1:-}"
case "$cmd" in
  apply) apply_baseline ;;
  verify) verify_baseline ;;
  preflight) preflight_baseline ;;
  restore) restore_baseline ;;
  probe) probe_baseline "${2:-}" ;;
  -h|--help|help|"") usage ;;
  *) echo "Unknown command: $cmd"; usage; exit 1 ;;
esac
