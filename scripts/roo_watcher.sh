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

log "roo_watcher started — polling $TRIGGER_FILE every 10s"

while true; do
  if [ -f "$TRIGGER_FILE" ]; then
    HANDLED=$(python3 -c "import json,sys; d=json.load(open('$TRIGGER_FILE')); print(str(d.get('handled','false')).lower())" 2>/dev/null)

    if [ "$HANDLED" = "false" ]; then
      JOB_ID=$(python3 -c "import json; d=json.load(open('$TRIGGER_FILE')); print(d.get('jobId','unknown'))" 2>/dev/null)
      CONTENT_TYPE=$(python3 -c "import json; d=json.load(open('$TRIGGER_FILE')); print(d.get('contentType','unknown'))" 2>/dev/null)

      log "New job detected: $JOB_ID ($CONTENT_TYPE) — firing Roo"

      # Fire Roo via Cursor CLI with the pipeline orchestrator task
      CURSOR_BIN="/Applications/Cursor.app/Contents/Resources/app/bin/cursor"
      "$CURSOR_BIN" --command "roo-cline.newTask" \
        --args "{\"mode\":\"pipeline-orchestrator\",\"message\":\"Job confirmed: $JOB_ID ($CONTENT_TYPE). Begin active gate watch. Read logs/roo_trigger.json, logs/roo_status.json, and logs/pipeline_events.jsonl. Run your standing task from .roo/rules/pipeline-orchestrator.md.\"}" \
        2>>"$LOG_FILE" &

      CURSOR_EXIT=$?
      if [ $CURSOR_EXIT -eq 0 ]; then
        log "Roo task fired successfully for $JOB_ID"
      else
        log "WARNING: cursor CLI returned exit $CURSOR_EXIT — Roo may need manual start"
        log "Manual trigger: open Cursor → Roo panel → send: 'Job running: $JOB_ID'"
      fi
    fi
  fi

  sleep 10
done
