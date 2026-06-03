#!/usr/bin/env bash
# verify_deploy.sh — post-deploy content QA for the marketing site
# Run after deploy.sh completes. Checks live pages for key strings.
# Exit 0 = all checks passed. Exit 1 = failures found.

set -euo pipefail
BASE="https://auraflux.co"
PASS=0
FAIL=0
FAILURES=()

_fetch() {
  # Saves response to a temp file and echoes the path.
  # Using a temp file avoids echo-pipe truncation issues with large HTML responses.
  local url="$1"
  local tmp
  tmp=$(mktemp)
  curl -s --max-time 15 --compressed "$url" > "$tmp"
  echo "$tmp"
}

check() {
  local label="$1"
  local url="$2"
  local expected="$3"
  local tmp
  tmp=$(_fetch "$url")
  if grep -qF "$expected" "$tmp"; then
    echo "  ✅ $label"
    PASS=$((PASS+1))
    rm -f "$tmp"
  else
    # One retry after 20s — Cloudflare propagation can be uneven across PoPs
    sleep 20
    tmp=$(_fetch "$url")
    if grep -qF "$expected" "$tmp"; then
      echo "  ✅ $label (on retry)"
      PASS=$((PASS+1))
    else
      echo "  ❌ $label"
      echo "     Expected: $expected"
      echo "     URL: $url"
      FAIL=$((FAIL+1))
      FAILURES+=("$label ($url)")
    fi
    rm -f "$tmp"
  fi
}

absent() {
  local label="$1"
  local url="$2"
  local forbidden="$3"
  local tmp
  tmp=$(_fetch "$url")
  # Strip CSS/JS block comments so comment text doesn't false-positive
  local stripped
  stripped=$(sed 's|/\*[^*]*\*\+\([^/*][^*]*\*\+\)*/||g' "$tmp")
  rm -f "$tmp"
  if grep -qF "$forbidden" <<< "$stripped"; then
    echo "  ❌ $label — found forbidden string: $forbidden"
    FAIL=$((FAIL+1))
    FAILURES+=("$label ($url)")
  else
    echo "  ✅ $label (absent)"
    PASS=$((PASS+1))
  fi
}

echo ""
echo "=== Marketing Site Deploy Verification ==="
echo "    $(date)"
echo ""

echo "[ / — Homepage ]"
check  "favicon link"          "$BASE/"      'href="/favicon.png"'
check  "nav Blog link"         "$BASE/"      'href="/blog"'
check  "nav Get Started → /plans" "$BASE/"  'href="/plans"'
absent "nav Get Started → sign-up" "$BASE/" 'href="https://app.auraflux.co/sign-up"'
absent "AI mention"            "$BASE/"      ' AI '
absent "Gemini mention"        "$BASE/"      'Gemini'
absent "em-dash"               "$BASE/"      '—'

echo ""
echo "[ /plans — Plans page ]"
check  "Operate Stripe CTA"    "$BASE/plans"  'checkout?plan=operate'
check  "Guided Stripe CTA"     "$BASE/plans"  'checkout?plan=guided'
check  "Managed chat onclick"  "$BASE/plans"  'af-chat-panel'
absent "Managed /contact-us CTA (data-cta)" "$BASE/plans" 'data-cta="managed_cta"'
absent "AI mention"            "$BASE/plans"  ' AI '
absent "Gemini mention"        "$BASE/plans"  'Gemini'
check  "favicon link"          "$BASE/plans"  'href="/favicon.png"'

echo ""
echo "[ /about — Our Story ]"
check  "Hero CTA = How It Works"   "$BASE/about"  'How It Works'
check  "Bottom CTA = View Plans"   "$BASE/about"  'View Plans'
absent "AI mention"                "$BASE/about"  ' AI '
absent "Gemini mention"            "$BASE/about"  'Gemini'
absent "em-dash"                   "$BASE/about"  '—'
check  "favicon link"              "$BASE/about"  'href="/favicon.png"'

echo ""
echo "[ /our-system — System ]"
absent "AI mention"            "$BASE/our-system"  ' AI '
absent "Gemini mention"        "$BASE/our-system"  'Gemini'
absent "em-dash"               "$BASE/our-system"  '—'
check  "favicon link"          "$BASE/our-system"  'href="/favicon.png"'

echo ""
echo "[ /blog — Blog ]"
absent "AI tag"                "$BASE/blog"  '>AI<'
absent "AI video"              "$BASE/blog"  'AI video'
absent "em-dash"               "$BASE/blog"  '—'

echo ""
echo "[ /roadmap — Roadmap ]"
absent "AI Avatar"             "$BASE/roadmap"  'AI Avatar'
absent "AI tag"                "$BASE/roadmap"  '>AI<'
absent "em-dash"               "$BASE/roadmap"  '—'

echo ""
echo "================================================"
echo "  PASSED: $PASS   FAILED: $FAIL"
if [ ${#FAILURES[@]} -gt 0 ]; then
  echo ""
  echo "  FAILURES:"
  for f in "${FAILURES[@]}"; do
    echo "    - $f"
  done
  echo ""
  exit 1
else
  echo "  All checks passed."
  echo ""
fi
