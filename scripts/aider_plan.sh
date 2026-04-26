#!/bin/bash
# CWN Aider Full Planning Session
# Run this ONCE to have Aider audit the entire codebase and write its complete
# multi-week task plan into OVERNIGHT_TASKS.md
#
# Usage: bash scripts/aider_plan.sh
# This is NOT the nightly runner — it's a one-time planning session.

set -e

REPO_DIR="/Users/robertgregory/cwn-production"
AIDER="/opt/homebrew/bin/aider"
LOG_FILE="$REPO_DIR/logs/planning_session_$(date +%Y-%m-%d_%H%M).log"

# Load env vars from .env
if [ -f "$REPO_DIR/.env" ]; then
  export $(grep -v '^#' "$REPO_DIR/.env" | grep -v '^$' | xargs)
fi

mkdir -p "$REPO_DIR/logs"

echo "Starting Aider planning session — $(date)" | tee "$LOG_FILE"
echo "Output will also be logged to: $LOG_FILE"
echo ""

cd "$REPO_DIR"

PLAN_PROMPT="You are the Aider agent for CWN Production. Your job right now is NOT to write code — it is to do a thorough audit of the entire codebase and produce a complete multi-week task plan.

Read these files carefully:
- cursor.md (architecture, rules, all gotchas)
- STATUS.md (current state, what's working, what's pending)
- OVERNIGHT_TASKS.md (existing task queue)
- SERVER_SPLIT_PLAN.md (module split plan — Phase 1 done, items 4-15 remain)
- QA_GATES.md (quality gates)
- server.js (the main file — scan for TODOs, duplicate routes, tech debt, missing features)
- package.json (check for unused or missing dependencies)

After reading everything, produce a COMPLETE prioritized task list covering ALL work needed over the next several weeks. Include:
1. Remaining server.js module split (items 4-15 from SERVER_SPLIT_PLAN.md)
2. Security improvements (input validation, rate limiting)
3. Bug fixes (duplicate routes, stub routes, etc.)
4. Feature completions (phonetic injection, structured logging, etc.)
5. Any other issues you find in the codebase

For EACH task include:
- Clear title
- Which file(s) to edit
- What specifically needs to change
- Risk level (Low/Medium/High)
- Estimated time
- Any blockers or dependencies

Write the complete plan into OVERNIGHT_TASKS.md — replace the existing QUEUED section with your full plan, organized by priority. Keep the existing [~] module split task and [x] completed tasks. Add all new tasks you identify.

After writing the plan, commit it with message: 'docs: Aider full environment audit — complete multi-week task plan added to OVERNIGHT_TASKS.md'
Then run: git push origin main

This is a planning-only session. Do NOT make any code changes."

"$AIDER" \
  --message "$PLAN_PROMPT" \
  --yes-always \
  OVERNIGHT_TASKS.md \
  server.js \
  2>&1 | tee -a "$LOG_FILE"

echo ""
echo "Planning session complete — $(date)" | tee -a "$LOG_FILE"
echo "Check OVERNIGHT_TASKS.md for the full plan."
