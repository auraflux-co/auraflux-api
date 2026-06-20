#!/usr/bin/env bash
# CPD-1055 — keep c0 localhost proxy in sync with cwn-production (one file only).
# c0 hosts dashboard HTML; this file forwards /live-grid/* → Render sidecar.
set -euo pipefail
PROD="${1:-$HOME/cwn-production}"
C0="${2:-$HOME/cwn-c0}"
SRC="$PROD/lib/broadcast/sidecar_client.js"
DST="$C0/lib/broadcast/sidecar_client.js"
if [[ ! -f "$SRC" ]]; then echo "missing $SRC"; exit 1; fi
cp "$SRC" "$DST"
echo "[sync] copied sidecar_client.js → $DST"
echo "[sync] restart: cd $C0 && pm2 restart auraflux --update-env"
