#!/usr/bin/env bash
# Push Live Grid secrets from c0 .env + youtube_tokens to Render broadcast service (CPD-1042).
set -euo pipefail

SERVICE_ID="${1:?usage: sync_broadcast_env_to_render.sh <render-service-id>}"
C0_ENV="${C0_ENV:-$HOME/cwn-c0/.env}"
C0_TOKENS="${C0_TOKENS:-$HOME/cwn-c0/data/youtube_tokens.json}"
RENDER_API_KEY="${RENDER_API_KEY:?set RENDER_API_KEY}"

if [ ! -f "$C0_ENV" ]; then
  echo "missing C0_ENV at $C0_ENV" >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a
source "$C0_ENV"
set +a

YT_REFRESH="${YOUTUBE_REFRESH_TOKEN:-}"
if [ -z "$YT_REFRESH" ] && [ -f "$C0_TOKENS" ]; then
  YT_REFRESH="$(node -e "const t=require(process.argv[1]); process.stdout.write(t.refresh_token||'')" "$C0_TOKENS")"
fi

if [ -z "$YT_REFRESH" ]; then
  echo "No YOUTUBE_REFRESH_TOKEN or youtube_tokens.json refresh_token" >&2
  exit 1
fi

payload="$(node <<NODE
const env = {
  NODE_ENV: 'staging',
  PORT: '10000',
  LIVE_SIDECAR_PORT: '10000',
  LIVE_SIDECAR_BIND: '0.0.0.0',
  LIVE_BROADCAST_SIDECAR: 'on',
  LIVE_GRID_ENCODER: process.env.LIVE_GRID_ENCODER || 'libx264',
  LIVE_GRID_RELAY_TRANSCODE: 'off',
  LIVE_GRID_UDP_RELAY: 'on',
  LIVE_GRID_TWITCH_QUALITY: process.env.LIVE_GRID_TWITCH_QUALITY || '720p60,720p,best',
  LIVE_GRID_OUTPUT_MIDDLEWARE: 'off',
  LIVE_GRID_STAGED_SWAP: 'off',
  LIVE_GRID_LOCAL_HLS: 'off',
  LIVE_GRID_FPS: process.env.LIVE_GRID_FPS || '30',
  LIVE_GRID_OUTPUT_W: process.env.LIVE_GRID_OUTPUT_W || '1920',
  LIVE_GRID_OUTPUT_H: process.env.LIVE_GRID_OUTPUT_H || '1080',
  LIVE_GRID_BITRATE_K: process.env.LIVE_GRID_BITRATE_K || '4500',
  LIVE_GRID_RELAY_SCALE_W: process.env.LIVE_GRID_RELAY_SCALE_W || '960',
  LIVE_GRID_RELAY_SCALE_H: process.env.LIVE_GRID_RELAY_SCALE_H || '540',
  LIVE_GRID_RELAY_BITRATE_K: process.env.LIVE_GRID_RELAY_BITRATE_K || '2200',
  LIVE_GRID_AUDIO_DIRECT: process.env.LIVE_GRID_AUDIO_DIRECT || 'on',
  LIVE_GRID_ENFORCE_LANDSCAPE: 'on',
  LIVE_GRID_YOUTUBE_SQUARE_PAD: 'off',
  LIVE_GRID_TRUST_ENV_BROADCAST: process.env.LIVE_GRID_TRUST_ENV_BROADCAST || 'on',
  LIVE_GRID_PROTECT_YT_RTMP: 'on',
  TWITCH_CLIENT_ID: process.env.TWITCH_CLIENT_ID || '',
  TWITCH_TOKEN: process.env.TWITCH_TOKEN || '',
  YOUTUBE_CLIENT_ID: process.env.YOUTUBE_CLIENT_ID || '',
  YOUTUBE_CLIENT_SECRET: process.env.YOUTUBE_CLIENT_SECRET || '',
  YOUTUBE_REFRESH_TOKEN: process.argv[1],
  LIVE_GRID_RTMP_URL: process.env.LIVE_GRID_RTMP_URL || '',
  LIVE_GRID_STREAM_ID: process.env.LIVE_GRID_STREAM_ID || '',
  LIVE_GRID_BROADCAST_ID: process.env.LIVE_GRID_BROADCAST_ID || '',
  LIVE_GRID_WATCH_URL: process.env.LIVE_GRID_WATCH_URL || '',
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  RENDER: 'true',
};
const vars = Object.entries(env).filter(([, v]) => v !== '').map(([key, value]) => ({ key, value }));
console.log(JSON.stringify(vars));
NODE
"$YT_REFRESH")"

curl -sS -X PUT "https://api.render.com/v1/services/${SERVICE_ID}/env-vars" \
  -H "Authorization: Bearer ${RENDER_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "$(node -e "const v=JSON.parse(process.argv[1]); console.log(JSON.stringify(v.map(x=>({envVarKey:x.key,value:x.value}))))" "$payload")" \
  | python3 -m json.tool | head -20

echo "[sync] env vars pushed to ${SERVICE_ID}"
