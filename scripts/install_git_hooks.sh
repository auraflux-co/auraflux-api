#!/bin/bash
# Install worktree-aware pre-commit dispatcher + C0 scope hook script.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Shared git dir (worktrees use commondir hooks)
GIT_COMMON="$(git rev-parse --git-common-dir)"
HOOK="$GIT_COMMON/hooks/pre-commit"

mkdir -p "$(dirname "$HOOK")"
cp "$ROOT/scripts/pre-commit-dispatcher.sh" "$HOOK"
chmod +x "$HOOK"

echo "✅ Installed worktree pre-commit dispatcher → $HOOK"
echo "   On branch c0/*  → C0 scope guard (blocks app/, lib/portals/, …)"
echo "   On branch main  → production pre-commit (from ~/cwn-production)"
echo "   Portable lib:   C0_PORTABLE=1 git commit …"
