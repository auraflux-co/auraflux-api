#!/bin/bash
# C0 commit scope guard — warn/block commits that belong on ~/cwn-production (C1+/Render).
# Called from scripts/pre-commit.sh; run standalone: bash scripts/c0_commit_scope_check.sh
#
# Bypass intentional shared lib ports:  C0_PORTABLE=1 git commit ...
# Emergency skip all hooks:             git commit --no-verify

set -euo pipefail

STAGED="${1:-$(git diff --cached --name-only 2>/dev/null || true)}"
if [ -z "$STAGED" ]; then
  exit 0
fi

# Docs-only / policy / session logs — never scope-check
is_scope_exempt() {
  local f="$1"
  [[ "$f" == STATUS.md ]] && return 0
  [[ "$f" == package.json ]] && return 0
  [[ "$f" == package-lock.json ]] && return 0
  [[ "$f" =~ ^docs/C0_ ]] && return 0
  [[ "$f" =~ ^\.cursor/rules/c0- ]] && return 0
  [[ "$f" =~ ^logs/ ]] && return 0
  [[ "$f" =~ ^\.env\.example$ ]] && return 0
  [[ "$f" =~ ^assets/audio/README\.md$ ]] && return 0
  return 1
}

# Hard block — these paths are Render / C1+ product; use ~/cwn-production
is_production_only() {
  local f="$1"
  [[ "$f" =~ ^app/ ]] && return 0
  [[ "$f" == render.yaml ]] && return 0
  [[ "$f" == Dockerfile ]] && return 0
  [[ "$f" =~ ^lib/portals/ ]] && return 0
  [[ "$f" =~ ^lib/db/postgres ]] && return 0
  [[ "$f" =~ ^migrations/ ]] && return 0
  [[ "$f" =~ ^lib/routes/developer_api ]] && return 0
  [[ "$f" =~ ^lib/routes/concierge ]] && return 0
  [[ "$f" =~ ^lib/routes/billing ]] && return 0
  [[ "$f" =~ ^lib/routes/stripe ]] && return 0
  [[ "$f" =~ ^\.github/workflows/.*(vercel|render|e2e) ]] && return 0
  return 1
}

# C0-native paths — at least one should appear when committing product code here
is_c0_signal() {
  local f="$1"
  [[ "$f" == cwn_production.html ]] && return 0
  [[ "$f" =~ ^lib/live_grid/ ]] && return 0
  [[ "$f" =~ ^lib/broadcast/ ]] && return 0
  [[ "$f" =~ ^lib/gates/ ]] && return 0
  [[ "$f" =~ ^lib/routes/c0_ ]] && return 0
  [[ "$f" =~ ^assets/broadcast ]] && return 0
  [[ "$f" =~ ^assets/audio/ ]] && return 0
  [[ "$f" =~ ^config/live_grid ]] && return 0
  [[ "$f" =~ ^scripts/live_broadcast ]] && return 0
  [[ "$f" =~ ^scripts/safe_restart ]] && return 0
  [[ "$f" =~ ^scripts/aider_session_review_local ]] && return 0
  [[ "$f" =~ ^scripts/pre-commit-c0 ]] && return 0
  [[ "$f" =~ ^scripts/c0_commit_scope ]] && return 0
  [[ "$f" =~ ^scripts/install_git_hooks ]] && return 0
  [[ "$f" =~ ^scripts/pre-commit-dispatcher ]] && return 0
  [[ "$f" =~ ^test/live_grid ]] && return 0
  [[ "$f" =~ ^test/fallback_music ]] && return 0
  [[ "$f" =~ ^test/youtube_sync ]] && return 0
  [[ "$f" =~ ^test/.*gate ]] && return 0
  [[ "$f" =~ ^docs/C0_ ]] && return 0
  [[ "$f" =~ ^\.cursor/rules/c0- ]] && return 0
  return 1
}

is_code_file() {
  local f="$1"
  [[ "$f" =~ \.(js|html|py|json|sh|mdc|tsx|ts|jsx|css)$ ]] || return 1
  is_scope_exempt "$f" && return 1
  return 0
}

PROD_HITS=""
CODE_COUNT=0
C0_HITS=0
CHECKED=""

while IFS= read -r f; do
  [ -z "$f" ] && continue
  is_code_file "$f" || continue
  CODE_COUNT=$((CODE_COUNT + 1))
  CHECKED="${CHECKED}${f}\n"
  if is_production_only "$f"; then
    PROD_HITS="${PROD_HITS}  • ${f}\n"
  fi
  if is_c0_signal "$f"; then
    C0_HITS=$((C0_HITS + 1))
  fi
done <<< "$STAGED"

[ "$CODE_COUNT" -eq 0 ] && exit 0

if [ -n "$PROD_HITS" ] && [ "${C0_PORTABLE:-0}" != "1" ]; then
  echo ""
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║  ⛔  C0 COMMIT BLOCKED — production-only paths staged        ║"
  echo "╠══════════════════════════════════════════════════════════════╣"
  echo "║  ~/cwn-c0 → auraflux-c0 (localhost pm2 only)               ║"
  echo "║  ~/cwn-production → auraflux-api (Render + Next.js app)      ║"
  echo "║                                                              ║"
  echo "║  Move this work to cwn-production/main, not c0/main.         ║"
  echo "║                                                              ║"
  printf "%b" "$PROD_HITS"
  echo "║                                                              ║"
  echo "║  Intentional shared lib port to cherry-pick later:           ║"
  echo "║    C0_PORTABLE=1 git commit -m 'fix(cpd-XXX): ...'           ║"
  echo "║  Emergency: git commit --no-verify (document why)            ║"
  echo "╚══════════════════════════════════════════════════════════════╝"
  echo ""
  exit 1
fi

if [ "$C0_HITS" -eq 0 ] && [ "${C0_PORTABLE:-0}" != "1" ]; then
  echo ""
  echo "┌──────────────────────────────────────────────────────────────┐"
  echo "│  ⚠️   C0 SCOPE REMINDER — no C0-native files in this commit   │"
  echo "├──────────────────────────────────────────────────────────────┤"
  echo "│  Staged code looks like shared/C1+ work (server.js, lib/*,   │"
  echo "│  worker/*, etc.) with no live-grid / gates / dashboard hit.  │"
  echo "│                                                              │"
  echo "│  • C0-only feature → include cwn_production.html,            │"
  echo "│    lib/live_grid/*, lib/gates/*, lib/broadcast/*             │"
  echo "│  • Render / Next.js / portals → use ~/cwn-production         │"
  echo "│  • Shared lib fix for both → C0_PORTABLE=1 + cherry-pick     │"
  echo "│    the hash onto auraflux-api main with a CPD ticket           │"
  echo "│                                                              │"
  echo "│  Continuing in 8 seconds… (Ctrl+C to cancel)                 │"
  echo "└──────────────────────────────────────────────────────────────┘"
  echo ""
  sleep 8
fi

exit 0
