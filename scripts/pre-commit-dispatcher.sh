#!/bin/bash
# Git hook dispatcher — routes to the active worktree's pre-commit script
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
if [[ "$BRANCH" == c0/* ]] && [ -f "$ROOT/scripts/pre-commit-c0.sh" ]; then
  exec bash "$ROOT/scripts/pre-commit-c0.sh"
fi
if [ -f "$ROOT/scripts/pre-commit.sh" ]; then
  exec bash "$ROOT/scripts/pre-commit.sh"
fi
exit 0
