#!/bin/bash
# scripts/roo_watcher.sh — Watches for roo_trigger.json and fires Roo via VS Code CLI
#
# Run via PM2: add to ecosystem.config.js as a second app entry, or run manually:
#   bash scripts/roo_watcher.sh &
#
# What it does:
#   1. Polls logs/roo_trigger.json every 10 seconds
#   2. When handled=false, sends roo-cline.newTask via VS Code CLI
#   3. Marks the trigger as handled so it doesn't re-fire

TRIGGER_FILE="$(dirname "$0")/../logs/roo_trigger.json"
LOG_FILE="$(dirname "$0")/../logs/roo_watcher.log"

log() {
  echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $1" | tee -a "$LOG_FILE"
}

# On Render, RENDER env var is set automatically — Cursor/Roo don't exist there
if [ -n "$RENDER" ]; then
  log "roo_watcher disabled on Render (no Cursor/Roo in cloud) — exiting"
  exit 0
fi

log "roo_watcher started — polling $TRIGGER_FILE every 10s"

while true; do
  if [ -f "$TRIGGER_FILE" ]; then
    HANDLED=$(python3 -c "import json,sys; d=json.load(open('$TRIGGER_FILE')); print(str(d.get('handled','false')).lower())" 2>/dev/null)

    if [ "$HANDLED" = "false" ]; then
      JOB_ID=$(python3 -c "import json; d=json.load(open('$TRIGGER_FILE')); print(d.get('jobId','unknown'))" 2>/dev/null)
      CONTENT_TYPE=$(python3 -c "import json; d=json.load(open('$TRIGGER_FILE')); print(d.get('contentType','unknown'))" 2>/dev/null)

      log "New job detected: $JOB_ID ($CONTENT_TYPE) — notifying Roo"

      # Mark handled immediately so we don't re-fire on next poll
      python3 -c "
import json
with open('$TRIGGER_FILE') as f: d = json.load(f)
d['handled'] = True
d['handledAt'] = '$(date -u +%Y-%m-%dT%H:%M:%SZ)'
with open('$TRIGGER_FILE', 'w') as f: json.dump(d, f, indent=2)
" 2>>"$LOG_FILE"

      # Write a notification file Roo reads on its next message cycle
      NOTIFICATION_FILE="$(dirname "$0")/../logs/roo_notification.md"
      cat > "$NOTIFICATION_FILE" << NOTIFICATION
# Roo — New Job Alert
**Job confirmed at $(date -u '+%Y-%m-%dT%H:%M:%SZ')**

- Job ID: $JOB_ID
- Content type: $CONTENT_TYPE
- Status: gate0, running

**Action required:** Run your standing task from .roo/rules/pipeline-orchestrator.md now.
Read logs/roo_status.json and logs/pipeline_events.jsonl for live state.
NOTIFICATION

      log "Notification written to logs/roo_notification.md for job $JOB_ID"
      log "Roo will pick this up on its next message cycle (open Cursor → Roo → send any message)"
    fi
  fi

  sleep 10
done
