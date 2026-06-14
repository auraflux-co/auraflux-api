#!/usr/bin/env bash
# Cursor MCP → mcp-atlassian via Doppler (auraflux/prd). See scripts/doppler_run.sh.
# mcp-atlassian expects --jira-url / --jira-token CLI flags (not env-only launch).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

exec "$SCRIPT_DIR/doppler_run.sh" bash -c '
  domain="${ATLASSIAN_DOMAIN#https://}"
  domain="${domain#http://}"
  domain="${domain%/}"

  exec uvx mcp-atlassian \
    --confluence-url "https://${domain}/wiki" \
    --confluence-username "${ATLASSIAN_EMAIL}" \
    --confluence-token "${ATLASSIAN_API_TOKEN}" \
    --confluence-spaces-filter "${CONFLUENCE_SPACE_KEY:-CP}" \
    --jira-url "https://${domain}" \
    --jira-username "${ATLASSIAN_EMAIL}" \
    --jira-token "${ATLASSIAN_API_TOKEN}" \
    --jira-projects-filter "${JIRA_PROJECT_KEY:-CPD}"
'
