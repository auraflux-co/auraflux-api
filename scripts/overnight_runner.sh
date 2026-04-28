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

# ── Step 1: Sync Jira → OVERNIGHT_TASKS.md ───────────────────────────────────
# Pull CPD tickets labelled "aider" (status: To Do) into the task queue.
# Transitions each pulled ticket to "In Progress" so it's never double-queued.
echo "🔄 Running jira_sync.js..." >> "$LOG_FILE"
node "$REPO_DIR/scripts/jira_sync.js" >> "$LOG_FILE" 2>&1 || \
  echo "⚠️  jira_sync.js exited non-zero — continuing anyway" >> "$LOG_FILE"

# ── 2026-04-28 OVERNIGHT TASKS (legacy hardcoded section — kept for reference) ──
# Task 1: Write test/runpod.test.js — Jest unit tests for lib/ai/runpod.js
#   - Mock all HTTPS calls (no real network). Cover: pingPod, submitComfyWorkflow,
#     pollComfyResult, generateWanVideo (missing prompt throws, defaults applied,
#     submitComfyWorkflow called once). Run: npm test -- --testPathPattern=runpod
#   - Commit: "test(runpod): unit tests for generateWanVideo and ComfyUI helpers"
#
# Task 2: Write scripts/rotate_qa_failures.sh
#   - Keep 50 newest files per gate prefix in output/qa_failures/
#   - Compress the rest into output/qa_failures/archive_YYYY-MM-DD.tar.gz
#   - Delete .txt sources after successful archive. Delete .tar.gz older than 90 days.
#   - Idempotent. Run: bash scripts/rotate_qa_failures.sh (safe even if dir is empty)
#   - Commit: "chore(ops): rotate_qa_failures.sh — keep 50 newest per gate"
#
# Task 3: Write docs/ops/TOMORROW_PLAN_2026-04-28.md
#   - Full session plan for Rob's morning. Read docs/ops/OVERNIGHT_TASKS.md
#     section "Task 3" for the exact content to include.
#   - Commit: "docs(ops): tomorrow plan 2026-04-28"
#
# After ALL THREE tasks: update STATUS.md Last Agent Action table, update
# MORNING_BRIEFING.md summarising all 3, mark all 3 [x] in OVERNIGHT_TASKS.md,
# push: git push origin HEAD. If any task fails, note it in MORNING_BRIEFING.md
# and continue with the next task — do not abandon the whole run.
# ──────────────────────────────────────────────────────────────────────────────

TASK_PROMPT="Work through ALL pending tasks in docs/ops/OVERNIGHT_TASKS.md. Look for any section marked '🟡' or 'PENDING' — these are your tasks for tonight. They may come from a Jira sync (labelled with a CPD- ticket key) or be manually written tasks. Work through them IN ORDER. Commit each task separately before starting the next. Create a feature branch (do NOT commit to main). After ALL tasks: update STATUS.md Last Agent Action table, prepend a new dated section to MORNING_BRIEFING.md summarising what was done, mark all completed tasks [x] in OVERNIGHT_TASKS.md, then run git push origin HEAD. For each completed Jira-sourced task (has a CPD- key), run: node scripts/jira_complete.js <KEY> to mark it Done and post a comment. If a task fails, write the error to MORNING_BRIEFING.md and continue. Follow all rules in docs/ops/COMMIT_CHECKLIST.md."

# Run Aider non-interactively
# Files listed: only what Aider needs tonight — no server.js (not needed)
"$AIDER" \
  --message "$TASK_PROMPT" \
  --yes-always \
  docs/ops/OVERNIGHT_TASKS.md \
  lib/ai/runpod.js \
  lib/ai/wan_t2v_workflow.json \
  package.json \
  STATUS.md \
  MORNING_BRIEFING.md \
  >> "$LOG_FILE" 2>&1

EXIT_CODE=$?

echo "" >> "$LOG_FILE"
echo "Aider exited with code: $EXIT_CODE" >> "$LOG_FILE"
echo "Run completed: $(date)" >> "$LOG_FILE"

exit $EXIT_CODE
