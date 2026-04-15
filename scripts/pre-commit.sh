#!/bin/bash
# CWN Production — Pre-Commit Hook
# 1. BLOCKS commit if STATUS.md not updated when code files change (hard requirement)
# 2. WARNS about .md files that reference changed code but aren't staged (soft reminder)
# Bypass only with: git commit --no-verify (use sparingly, document why)
#
# INSTALL: cp scripts/pre-commit.sh .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit

# ── HARD BLOCK: agents must never commit directly to main ────────────────────
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" = "main" ]; then
  echo ""
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║       ⛔  CWN COMMIT BLOCKED — YOU ARE ON MAIN               ║"
  echo "╠══════════════════════════════════════════════════════════════╣"
  echo "║                                                              ║"
  echo "║  Agents must never commit directly to main.                 ║"
  echo "║  Every task has a feature branch — switch to it first.      ║"
  echo "║                                                              ║"
  echo "║  REQUIRED:                                                   ║"
  echo "║  1. Run: git branch --show-current                          ║"
  echo "║  2. If on main: git checkout <your-branch-name>             ║"
  echo "║  3. Your branch name is in BRANCH_NOTES.md                  ║"
  echo "║  4. Re-stage your files and commit there                     ║"
  echo "║                                                              ║"
  echo "║  Example: git checkout cline-a/heygen-templates             ║"
  echo "║                                                              ║"
  echo "║  Claude Code reviews + merges to main — agents do not.      ║"
  echo "║                                                              ║"
  echo "║  To bypass (Claude Code only): git commit --no-verify       ║"
  echo "╚══════════════════════════════════════════════════════════════╝"
  echo ""
  exit 1
fi

# Files that require a STATUS.md update when changed
CODE_PATTERN='\.(js|html|py|json|sh)$'

# Files that are exempt (data files, test fixtures, config examples, lock files)
EXEMPT_PATTERN='(data/|test/|\.example$|package-lock\.json|nodemon\.json|\.aider)'

# Check what's staged
STAGED_FILES=$(git diff --cached --name-only)

# Check if STATUS.md is staged
if echo "$STAGED_FILES" | grep -q "^STATUS\.md$"; then
  STATUS_STAGED=1
else
  STATUS_STAGED=0
fi

# Check if any code files (non-exempt) are staged
CODE_FILES=$(echo "$STAGED_FILES" | grep -E "$CODE_PATTERN" | grep -vE "$EXEMPT_PATTERN" || true)

if [ -n "$CODE_FILES" ]; then
  CODE_COUNT=1
else
  CODE_COUNT=0
fi

# ── HARD BLOCK: STATUS.md must be updated when code changes ──────────────────
if [ "$CODE_COUNT" -gt 0 ] && [ "$STATUS_STAGED" -eq 0 ]; then
  echo ""
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║       ⛔  CWN COMMIT BLOCKED — STATUS.md NOT UPDATED         ║"
  echo "╠══════════════════════════════════════════════════════════════╣"
  echo "║                                                              ║"
  echo "║  You changed code files but did not update STATUS.md.       ║"
  echo "║                                                              ║"
  echo "║  REQUIRED before committing:                                 ║"
  echo "║  1. Open STATUS.md                                           ║"
  echo "║  2. Update the '🤖 Last Agent Action' section                ║"
  echo "║  3. Update Phase Progress table if a phase completed         ║"
  echo "║  4. git add STATUS.md                                        ║"
  echo "║                                                              ║"
  echo "║  Code files staged without STATUS.md update:                ║"
  while IFS= read -r f; do
    if [ -n "$f" ]; then
      printf "║    • %-56s║\n" "$f"
    fi
  done <<< "$CODE_FILES"
  echo "║                                                              ║"
  echo "║  To bypass (use sparingly): git commit --no-verify          ║"
  echo "║  Document WHY you bypassed in your commit message.          ║"
  echo "║                                                              ║"
  echo "╚══════════════════════════════════════════════════════════════╝"
  echo ""
  exit 1
fi

# ── SOFT WARN: Check for .md files that reference changed code but aren't staged ──
if [ "$CODE_COUNT" -gt 0 ]; then
  STALE_DOCS=""

  # For each staged code file, search all .md files for references to it
  while IFS= read -r code_file; do
    if [ -z "$code_file" ]; then continue; fi

    # Get just the basename for matching (e.g. "server.js" from "lib/server.js")
    base_name=$(basename "$code_file")
    # Also use the short path without leading ./
    short_path=$(echo "$code_file" | sed 's|^\./||')

    # Find .md files that mention this file but are NOT already staged
    while IFS= read -r md_file; do
      if [ -z "$md_file" ]; then continue; fi
      # Strip leading ./
      md_clean=$(echo "$md_file" | sed 's|^\./||')
      # Skip if already staged
      if echo "$STAGED_FILES" | grep -qF "$md_clean"; then continue; fi
      # Check if this .md references the changed file
      if grep -qE "(${base_name}|${short_path})" "$md_file" 2>/dev/null; then
        STALE_DOCS="${STALE_DOCS}  • ${md_clean}  (references ${base_name})\n"
      fi
    done < <(find . -maxdepth 2 -name "*.md" -not -path "./.git/*" 2>/dev/null)

  done <<< "$CODE_FILES"

  # Remove duplicates and print warning if any found
  if [ -n "$STALE_DOCS" ]; then
    UNIQUE_DOCS=$(echo -e "$STALE_DOCS" | sort -u | grep -v '^$')
    echo ""
    echo "┌──────────────────────────────────────────────────────────────┐"
    echo "│  📋  CWN DOC CHECK — These .md files may need updating       │"
    echo "├──────────────────────────────────────────────────────────────┤"
    echo "│                                                              │"
    echo "│  The following docs reference files you just changed.       │"
    echo "│  Review each — update if the work is listed there.          │"
    echo "│                                                              │"
    echo "$UNIQUE_DOCS"
    echo ""
    echo "│  If docs are already up to date, this is just a reminder.   │"
    echo "│  Commit will continue in 5 seconds...  (Ctrl+C to cancel)   │"
    echo "│                                                              │"
    echo "└──────────────────────────────────────────────────────────────┘"
    echo ""
    sleep 5
  fi
fi

exit 0
