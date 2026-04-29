#!/usr/bin/env bash
# scripts/jira_poller.sh
#
# Mac-side Jira queue poller. Runs every 5 minutes via launchd.
# Checks https://api.auraflux.co/api/jira-queue for unprocessed tasks,
# writes them into OVERNIGHT_TASKS.md, then fires Aider to execute them
# immediately — no need to wait until 1 AM.
#
# Install launchd job:
#   cp scripts/com.cwn.jira-poller.plist ~/Library/LaunchAgents/
#   launchctl load ~/Library/LaunchAgents/com.cwn.jira-poller.plist
#
# Manual test:
#   bash scripts/jira_poller.sh

set -euo pipefail

REPO_DIR="/Users/robertgregory/cwn-production"
LOG_FILE="$REPO_DIR/logs/jira_poller_$(date +%Y-%m-%d).log"
AIDER="/opt/homebrew/bin/aider"
API_BASE="https://api.auraflux.co"

mkdir -p "$REPO_DIR/logs"

echo "========================================" >> "$LOG_FILE"
echo "Jira Poller — $(date)" >> "$LOG_FILE"
echo "========================================" >> "$LOG_FILE"

# Load env vars
if [ -f "$REPO_DIR/.env" ]; then
  set -a
  # Only export simple KEY=VALUE lines, skip lines with spaces (e.g. Chrome path)
  while IFS='=' read -r key val; do
    [[ "$key" =~ ^[A-Z_][A-Z0-9_]*$ ]] && export "$key=$val"
  done < <(grep -E '^[A-Z_][A-Z0-9_]*=' "$REPO_DIR/.env")
  set +a
fi

SECRET="${JIRA_WEBHOOK_SECRET:-}"
if [ -z "$SECRET" ]; then
  echo "⚠️  JIRA_WEBHOOK_SECRET not set — skipping." >> "$LOG_FILE"
  exit 0
fi

# Skip if a production job is in progress (recent MP4 output)
RECENT_MP4=$(find "$REPO_DIR/output" -name "*.mp4" -newer "$REPO_DIR/output" -mmin -30 2>/dev/null | head -1)
if [ -n "$RECENT_MP4" ]; then
  echo "⚠️  Production job in progress — skipping poller run." >> "$LOG_FILE"
  exit 0
fi

# Check queue
QUEUE=$(curl -sf "${API_BASE}/api/jira-queue?secret=${SECRET}" 2>/dev/null || echo "[]")
PENDING=$(echo "$QUEUE" | python3 -c "
import sys, json
items = json.load(sys.stdin)
pending = [i for i in items if not i.get('processed')]
print(len(pending))
" 2>/dev/null || echo "0")

if [ "$PENDING" -eq 0 ]; then
  echo "✅ Queue empty — nothing to do." >> "$LOG_FILE"
  exit 0
fi

echo "📋 $PENDING pending task(s) found." >> "$LOG_FILE"

cd "$REPO_DIR"

# ── Aider tasks ─────────────────────────────────────────────────────────────
AIDER_KEYS=$(echo "$QUEUE" | python3 -c "
import sys, json
items = json.load(sys.stdin)
keys = [i['key'] for i in items if not i.get('processed') and i.get('agent') == 'aider']
print(' '.join(keys))
" 2>/dev/null || echo "")

if [ -z "$AIDER_KEYS" ]; then
  echo "No Aider tasks — done." >> "$LOG_FILE"
  exit 0
fi

echo "✏️  Aider tasks: $AIDER_KEYS — triggering Aider..." >> "$LOG_FILE"

# Write pending tasks into OVERNIGHT_TASKS.md via jira_sync.js
node "$REPO_DIR/scripts/jira_sync.js" >> "$LOG_FILE" 2>&1 || \
  echo "⚠️  jira_sync.js failed — continuing" >> "$LOG_FILE"

TASK_PROMPT="Work through ALL pending tasks in docs/ops/OVERNIGHT_TASKS.md (any section marked '🟡' or 'PENDING'). Work IN ORDER, commit each before starting the next. Create a feature branch. After ALL tasks: update STATUS.md, prepend summary to MORNING_BRIEFING.md, mark tasks [x], run git push origin HEAD. For each Jira-sourced task (CPD- key), run: node scripts/jira_complete.js <KEY>. Follow docs/ops/COMMIT_CHECKLIST.md."

"$AIDER" \
  --model gemini/gemini-2.5-pro \
  --yes-always \
  --message "$TASK_PROMPT" \
  docs/ops/OVERNIGHT_TASKS.md \
  lib/ai/runpod.js \
  package.json \
  STATUS.md \
  MORNING_BRIEFING.md \
  >> "$LOG_FILE" 2>&1

EXIT_CODE=$?
echo "Aider exited: $EXIT_CODE" >> "$LOG_FILE"

for KEY in $AIDER_KEYS; do
  curl -sf -X POST "${API_BASE}/api/jira-queue/${KEY}/done?secret=${SECRET}" \
    -H "Content-Type: application/json" >> "$LOG_FILE" 2>&1 || true
  echo "Marked $KEY done in queue" >> "$LOG_FILE"
done

echo "Poller run complete — $(date)" >> "$LOG_FILE"
