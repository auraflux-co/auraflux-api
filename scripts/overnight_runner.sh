#!/bin/bash
# CWN Overnight Aider Runner
# Runs the next task from OVERNIGHT_TASKS.md non-interactively
# Scheduled via launchd: ~/Library/LaunchAgents/com.cwn.overnight.plist
#
# INSTALL:
#   cp scripts/com.cwn.overnight.plist ~/Library/LaunchAgents/
#   launchctl load ~/Library/LaunchAgents/com.cwn.overnight.plist
#
# UNINSTALL:
#   launchctl unload ~/Library/LaunchAgents/com.cwn.overnight.plist
#
# MANUAL TEST RUN:
#   bash scripts/overnight_runner.sh

set -e

REPO_DIR="/Users/robertgregory/cwn-production"
LOG_FILE="$REPO_DIR/logs/overnight_$(date +%Y-%m-%d).log"
AIDER="/opt/homebrew/bin/aider"

# Load env vars from .env
if [ -f "$REPO_DIR/.env" ]; then
  export $(grep -v '^#' "$REPO_DIR/.env" | grep -v '^$' | xargs)
fi

# Ensure log directory exists
mkdir -p "$REPO_DIR/logs"

echo "========================================" >> "$LOG_FILE"
echo "CWN Overnight Run — $(date)" >> "$LOG_FILE"
echo "========================================" >> "$LOG_FILE"

# Check if a production job is in progress (recent MP4 in output/)
RECENT_MP4=$(find "$REPO_DIR/output" -name "*.mp4" -newer "$REPO_DIR/output" -mmin -60 2>/dev/null | head -1)
if [ -n "$RECENT_MP4" ]; then
  echo "⚠️  Production job in progress (recent MP4 found). Skipping overnight run." >> "$LOG_FILE"
  exit 0
fi

# Check current time — only run between 1am and 7am ET
HOUR=$(date +%H)
if [ "$HOUR" -lt 1 ] || [ "$HOUR" -ge 7 ]; then
  echo "⚠️  Outside overnight window (1am-7am). Current hour: $HOUR. Skipping." >> "$LOG_FILE"
  exit 0
fi

echo "✅ Starting Aider overnight task..." >> "$LOG_FILE"

cd "$REPO_DIR"

# The task prompt — tells Aider exactly what to do in one non-interactive pass
TASK_PROMPT="Read OVERNIGHT_TASKS.md carefully. Find the FIRST task marked [ ] (not [x] or [~]) in the APPROVED section. Work on that ONE task only. Follow all rules in cursor.md and COMMIT_CHECKLIST.md. After completing: run 'node --check server.js' if you touched server.js, update STATUS.md Last Agent Action table, update MORNING_BRIEFING.md with what you did, mark the task [x] in OVERNIGHT_TASKS.md, commit all changed files with a clear message, then run 'git push origin main'. Do not start a second task. If you cannot complete the task safely, write the error to MORNING_BRIEFING.md and exit without committing."

# Run Aider non-interactively with --message flag
# --yes-always: auto-confirm file edits (no interactive prompts)
# All files Aider may need to edit are listed here so it never has to ask interactively.
# STATUS.md, OVERNIGHT_TASKS.md, MORNING_BRIEFING.md are always needed for the commit workflow.
# server.js is included for tasks that touch it; Aider will ignore it if not needed.
"$AIDER" \
  --message "$TASK_PROMPT" \
  --yes-always \
  server.js \
  STATUS.md \
  OVERNIGHT_TASKS.md \
  MORNING_BRIEFING.md \
  >> "$LOG_FILE" 2>&1

EXIT_CODE=$?

echo "" >> "$LOG_FILE"
echo "Aider exited with code: $EXIT_CODE" >> "$LOG_FILE"
echo "Run completed: $(date)" >> "$LOG_FILE"

exit $EXIT_CODE
