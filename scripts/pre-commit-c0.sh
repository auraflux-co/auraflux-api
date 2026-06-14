#!/bin/bash
# C0 localhost — pre-commit (runs on c0/* branches via pre-commit-dispatcher.sh)
set -euo pipefail

BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
if [[ "$BRANCH" != c0/* ]]; then
  exit 0
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

bash "$ROOT/scripts/c0_commit_scope_check.sh" || exit 1

CODE_PATTERN='\.(js|html|py|json|sh|mdc|tsx|ts)$'
EXEMPT_PATTERN='(test/|\.example$|package-lock\.json|logs/)'

STAGED_FILES=$(git diff --cached --name-only)
STATUS_STAGED=0
echo "$STAGED_FILES" | grep -q "^STATUS\.md$" && STATUS_STAGED=1

CODE_FILES=$(echo "$STAGED_FILES" | grep -E "$CODE_PATTERN" | grep -vE "$EXEMPT_PATTERN" || true)
[ -n "$CODE_FILES" ] && CODE_COUNT=1 || CODE_COUNT=0

if [ "$CODE_COUNT" -gt 0 ] && [ "$STATUS_STAGED" -eq 0 ]; then
  echo ""
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║  ⛔  C0 COMMIT BLOCKED — STATUS.md not updated               ║"
  echo "╠══════════════════════════════════════════════════════════════╣"
  echo "║  Update STATUS.md (Worker Memory / Last Updated), then:      ║"
  echo "║    git add STATUS.md && git commit                           ║"
  echo "╚══════════════════════════════════════════════════════════════╝"
  echo ""
  exit 1
fi

if [ "$CODE_COUNT" -gt 0 ]; then
  STALE_DOCS=""
  while IFS= read -r code_file; do
    [ -z "$code_file" ] && continue
    base_name=$(basename "$code_file")
    short_path=$(echo "$code_file" | sed 's|^\./||')
    while IFS= read -r md_file; do
      [ -z "$md_file" ] && continue
      md_clean=$(echo "$md_file" | sed 's|^\./||')
      echo "$STAGED_FILES" | grep -qF "$md_clean" && continue
      grep -qE "(${base_name}|${short_path})" "$md_file" 2>/dev/null || continue
      STALE_DOCS="${STALE_DOCS}  • ${md_clean}  (references ${base_name})\n"
    done < <(find . -maxdepth 2 -name "*.md" -not -path "./.git/*" 2>/dev/null)
  done <<< "$CODE_FILES"

  if [ -n "$STALE_DOCS" ]; then
    UNIQUE_DOCS=$(echo -e "$STALE_DOCS" | sort -u | grep -v '^$')
    echo ""
    echo "┌──────────────────────────────────────────────────────────────┐"
    echo "│  📋  C0 DOC CHECK — review these references                  │"
    echo "└──────────────────────────────────────────────────────────────┘"
    echo "$UNIQUE_DOCS"
    echo "  Continuing in 5 seconds… (Ctrl+C to cancel)"
    sleep 5
  fi
fi

if command -v node &>/dev/null && [ -f "package.json" ]; then
  CURRENT_VERSION=$(node -p "require('./package.json').version" 2>/dev/null)
  if [ -n "$CURRENT_VERSION" ]; then
    NEW_VERSION=$(node -e "const v='$CURRENT_VERSION'.split('.');v[2]=parseInt(v[2])+1;console.log(v.join('.'))")
    node -e "const fs=require('fs');const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));pkg.version='$NEW_VERSION';fs.writeFileSync('package.json',JSON.stringify(pkg,null,2)+'\n')"
    git add package.json 2>/dev/null
    npm install --package-lock-only --silent 2>/dev/null && git add package-lock.json 2>/dev/null
    echo "  📦 Version bumped: $CURRENT_VERSION → $NEW_VERSION"
  fi
fi

exit 0
