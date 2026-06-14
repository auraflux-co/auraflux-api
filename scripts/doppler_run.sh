#!/usr/bin/env bash
# Run a command with Doppler auraflux/prd secrets — same source as Render production.
#
# Local .env holds localhost-only config + DOPPLER_TOKEN (bootstrap). Shared secrets
# (Atlassian, Stripe, etc.) are NOT duplicated in .env — use this wrapper.
#
# Usage:
#   bash scripts/doppler_run.sh python3 scripts/session_close.py
#   bash scripts/doppler_run.sh node scripts/pipeline_parity_review.js
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${REPO_ROOT}/.env"

if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC2046
  export $(grep '^DOPPLER_TOKEN=' "$ENV_FILE" | xargs) 2>/dev/null || true
fi

if [[ -z "${DOPPLER_TOKEN:-}" ]]; then
  echo "doppler_run.sh: DOPPLER_TOKEN missing — add to ${ENV_FILE} (bootstrap only)" >&2
  exit 1
fi

if [[ $# -lt 1 ]]; then
  echo "Usage: bash scripts/doppler_run.sh <command> [args...]" >&2
  exit 1
fi

exec doppler run --project auraflux --config prd -- "$@"
