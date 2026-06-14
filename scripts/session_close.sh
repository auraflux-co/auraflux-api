#!/usr/bin/env bash
# Jira/Confluence creds from Doppler (auraflux/prd) — not local .env.
exec "$(dirname "$0")/doppler_run.sh" python3 "$(dirname "$0")/session_close.py" "$@"
