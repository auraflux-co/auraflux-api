#!/bin/bash
# CWN Claude Code Consultation — peer-agent handoff from Cline
#
# Spawns a fresh Claude Code session (separate context from Cline's backend)
# to get a second opinion, review a plan, or debug a stuck task.
#
# Usage:
#   bash scripts/claude_consult.sh "your question with context"
#   bash scripts/claude_consult.sh "$(cat some_file.md)"
#
# This is a peer-agent call — Claude runs non-interactively (-p flag),
# reads CLAUDE.md + STATUS.md automatically, and returns one response.

set -e

REPO_DIR="/Users/robertgregory/cwn-production"
CLAUDE="/Users/robertgregory/.local/bin/claude"
LOG_DIR="$REPO_DIR/logs"
LOG_FILE="$LOG_DIR/claude_consult_$(date +%Y-%m-%d_%H%M%S).log"

mkdir -p "$LOG_DIR"

if [ -z "$1" ]; then
  echo "Usage: $0 \"your question\"" >&2
  exit 1
fi

QUESTION="$1"

cd "$REPO_DIR"

PROMPT="You are being consulted as a PEER AGENT by Cline, which is working on a task in the CWN Production repo. You have a fresh context window and a different perspective.

Before answering, read these files:
- CLAUDE.md (architecture, rules, gotchas)
- STATUS.md (current state)

Then respond to this question from Cline:

---
$QUESTION
---

Rules:
- Be concise. Cline will paste your full response into its context.
- Do NOT make file edits. This is advisory only.
- If you spot a bug or risk Cline missed, call it out explicitly.
- If Cline's approach looks correct, say so plainly."

echo "=== Claude Code consultation — $(date) ===" | tee "$LOG_FILE"
echo "Question: $QUESTION" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

"$CLAUDE" -p "$PROMPT" 2>&1 | tee -a "$LOG_FILE"
