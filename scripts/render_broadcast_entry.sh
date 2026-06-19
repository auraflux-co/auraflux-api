#!/usr/bin/env bash
# Start MediaMTX then the broadcast sidecar (Render auraflux-broadcast worker).
set -euo pipefail

MTX_CONFIG="${MEDIAMTX_CONFIG:-/app/docker/mediamtx.yml}"
MTX_BIN="${MEDIAMTX_BIN:-/usr/local/bin/mediamtx}"

echo "[broadcast-entry] starting MediaMTX (${MTX_CONFIG})"
"${MTX_BIN}" "${MTX_CONFIG}" &
MTX_PID=$!

cleanup() {
  echo "[broadcast-entry] shutdown — stopping MediaMTX (pid ${MTX_PID})"
  kill "${MTX_PID}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

for i in $(seq 1 40); do
  if ! kill -0 "${MTX_PID}" 2>/dev/null; then
    echo "[broadcast-entry] MediaMTX exited early"
    exit 1
  fi
  if (echo >/dev/tcp/127.0.0.1/8554) 2>/dev/null; then
    break
  fi
  sleep 0.25
done

echo "[broadcast-entry] MediaMTX listening — sidecar on ${LIVE_SIDECAR_BIND:-0.0.0.0}:${PORT:-10000}"
exec node scripts/live_broadcast_sidecar.js
