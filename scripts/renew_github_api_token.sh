#!/usr/bin/env bash
# Renew GITHUB_API_TOKEN (CPD-553) — run after creating a new fine-grained PAT in GitHub UI.
# Usage: bash scripts/renew_github_api_token.sh <new-token>
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: bash scripts/renew_github_api_token.sh <new-github-fine-grained-pat>"
  echo ""
  echo "Create token at: https://github.com/settings/tokens?type=beta"
  echo "  Repository: auraflux-co/auraflux-api"
  echo "  Permissions: Contents read+write"
  echo ""
  echo "Then update:"
  echo "  1. Local .env GITHUB_API_TOKEN"
  echo "  2. Doppler prd config (doppler secrets set GITHUB_API_TOKEN=...)"
  echo "  3. Cloudflare worker env for marketing commitToGit()"
  exit 1
fi

NEW="$1"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Validate token works
export GH_TOKEN="$NEW"
if ! gh api user -q .login >/dev/null 2>&1; then
  echo "ERROR: Token rejected by GitHub API"
  exit 1
fi
LOGIN=$(gh api user -q .login)
echo "OK: token valid for GitHub user $LOGIN"

# Patch local .env if present
ENV="$ROOT/.env"
if [[ -f "$ENV" ]]; then
  if grep -q '^GITHUB_API_TOKEN=' "$ENV"; then
    sed -i '' "s|^GITHUB_API_TOKEN=.*|GITHUB_API_TOKEN=$NEW|" "$ENV"
  else
    echo "GITHUB_API_TOKEN=$NEW" >> "$ENV"
  fi
  echo "Updated $ENV"
fi

if command -v doppler >/dev/null 2>&1; then
  ENV_FILE="$ROOT/.env"
  if [[ -f "$ENV_FILE" ]] && [[ -z "${DOPPLER_TOKEN:-}" ]]; then
    # shellcheck disable=SC2046
    export $(grep '^DOPPLER_TOKEN=' "$ENV_FILE" | xargs) 2>/dev/null || true
  fi
  if [[ -n "${DOPPLER_TOKEN:-}" ]]; then
    doppler secrets set "GITHUB_API_TOKEN=$NEW" --project auraflux --config prd --silent \
      && echo "Updated Doppler prd GITHUB_API_TOKEN" \
      || echo "WARN: Doppler update failed — set manually"
  else
    echo "SKIP: DOPPLER_TOKEN not in shell — set GITHUB_API_TOKEN in Doppler prd manually"
  fi
else
  echo "SKIP: doppler CLI not installed"
fi

if [[ -f "$ROOT/scripts/doppler_sync_to_render.py" ]] && [[ -n "${DOPPLER_TOKEN:-}" ]]; then
  if python3 "$ROOT/scripts/doppler_sync_to_render.py" 2>&1; then
    echo "Render secret file synced — redeploy auraflux-api to pick up token"
  fi
fi

echo ""
echo "Done. Comment on CPD-553 and close when Cloudflare worker is updated."
