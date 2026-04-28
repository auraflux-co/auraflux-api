#!/usr/bin/env bash
# rovo_start.sh — managed by launchd (com.cwn.rovo-dev)
# Starts acli rovodev serve then configures it with the repo path,
# Jira project, and site URL so it can write code and create PRs.

set -euo pipefail

ROVO_PORT=10101
SITE_URL="https://robertsworkspace-18914505.atlassian.net"
CLOUD_ID="ea8459c4-1608-4cb7-a40c-e0fd9af73932"
REPO_PATH="/Users/robertgregory/cwn-production"
ROVO_URL="http://localhost:${ROVO_PORT}"
LOG_FILE="$HOME/Library/Logs/rovo-dev.log"

echo "[$(date)] Starting acli rovodev serve on port $ROVO_PORT" >> "$LOG_FILE"

# Start serve in the background
/opt/homebrew/bin/acli rovodev serve "$ROVO_PORT" \
  --non-interactive \
  --disable-session-token \
  --site-url "$SITE_URL" \
  --cloud-id "$CLOUD_ID" &

SERVE_PID=$!

# Wait for server to be healthy (up to 30s)
for i in $(seq 1 30); do
  sleep 1
  if curl -sf "${ROVO_URL}/healthcheck" > /dev/null 2>&1; then
    echo "[$(date)] Server healthy after ${i}s" >> "$LOG_FILE"
    break
  fi
done

# Configure repo path, site URL, and Jira project via API
curl -sf -X PUT "${ROVO_URL}/v3/allowed-external-paths" \
  -H "Content-Type: application/json" \
  -d "{\"paths\": [\"${REPO_PATH}\"]}" >> "$LOG_FILE" 2>&1 || true

curl -sf -X POST "${ROVO_URL}/v3/set-site-url" \
  -H "Content-Type: application/json" \
  -d "{\"site_url\": \"${SITE_URL}\"}" >> "$LOG_FILE" 2>&1 || true

curl -sf -X POST "${ROVO_URL}/v3/add-jira-project" \
  -H "Content-Type: application/json" \
  -d "{\"url\": \"${SITE_URL}/jira/software/projects/CPD/boards\", \"key\": \"CPD\"}" >> "$LOG_FILE" 2>&1 || true

echo "[$(date)] Rovo Dev configured and ready (PID $SERVE_PID)" >> "$LOG_FILE"

# Wait for the serve process to exit (keeps launchd happy)
wait "$SERVE_PID"
