#!/usr/bin/env bash
# snapshot.sh — Capture Framer-built pages as local HTML snapshots.
#
# Run this after any Framer publish to preserve the latest design.
# Snapshots are committed to git — the design is never lost.
#
# Usage:
#   bash cloudflare/marketing/scripts/snapshot.sh
#   bash cloudflare/marketing/scripts/snapshot.sh --origin https://abc123.auraflux-marketing.pages.dev
#
# After running, commit the snapshots:
#   git add cloudflare/marketing/snapshots/ cloudflare/marketing/framer-shell/
#   git commit -m "chore: refresh Framer snapshots"
#
# Then re-deploy so worker-owned pages get the latest nav/footer/CSS:
#   bash cloudflare/marketing/deploy.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MARKETING_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SNAPSHOTS_DIR="$MARKETING_DIR/snapshots"
SHELL_DIR="$MARKETING_DIR/framer-shell"

mkdir -p "$SNAPSHOTS_DIR" "$SHELL_DIR"

# ── Resolve Framer origin ─────────────────────────────────────────────────────
# Use --origin flag or read current FRAMER_ORIGIN from _worker.js

FRAMER_ORIGIN=""
for arg in "$@"; do
  case "$arg" in
    --origin=*) FRAMER_ORIGIN="${arg#*=}" ;;
    --origin)   shift; FRAMER_ORIGIN="$1" ;;
  esac
done

if [[ -z "$FRAMER_ORIGIN" ]]; then
  FRAMER_ORIGIN=$(python3 -c "
import re, sys
m = re.search(r\"const FRAMER_ORIGIN = '([^']+)'\", open('$MARKETING_DIR/_worker.js').read())
print(m.group(1) if m else '')
" 2>/dev/null || true)
fi

if [[ -z "$FRAMER_ORIGIN" ]]; then
  echo "❌  Could not determine FRAMER_ORIGIN."
  echo "    Run: bash cloudflare/marketing/deploy.sh first, or pass --origin=<url>"
  exit 1
fi

echo "📸  Snapshotting from: $FRAMER_ORIGIN"
echo ""

# ── Pages to snapshot ─────────────────────────────────────────────────────────
# FORMAT: "name:path" — add new Framer pages here as the site grows.
PAGES=(
  "homepage:/"
  "about:/about"
  "features:/features"
  "blog:/blog"
)

FETCHED=0
SKIPPED=0

for ENTRY in "${PAGES[@]}"; do
  NAME="${ENTRY%%:*}"
  PATH_SEGMENT="${ENTRY#*:}"
  URL="${FRAMER_ORIGIN}${PATH_SEGMENT}"
  OUT="$SNAPSHOTS_DIR/${NAME}.html"

  echo -n "  Fetching ${PATH_SEGMENT} … "

  HTTP_CODE=$(curl -sS -o "$OUT" -w "%{http_code}" \
    -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" \
    "$URL" 2>/dev/null || echo "000")

  SIZE=$(wc -c < "$OUT" 2>/dev/null || echo 0)

  if [[ "$HTTP_CODE" == "200" && "$SIZE" -gt 5000 ]]; then
    echo "✓  ${SIZE}B  →  snapshots/${NAME}.html"
    FETCHED=$((FETCHED + 1))
  else
    rm -f "$OUT"
    echo "skip  (HTTP $HTTP_CODE, ${SIZE}B — not a Framer page)"
    SKIPPED=$((SKIPPED + 1))
  fi
done

echo ""
echo "📦  Fetched: $FETCHED  |  Skipped: $SKIPPED"
echo ""

# ── Extract design components from homepage snapshot ─────────────────────────
HOMEPAGE_SNAP="$SNAPSHOTS_DIR/homepage.html"

if [[ ! -f "$HOMEPAGE_SNAP" ]]; then
  echo "⚠️   No homepage snapshot — skipping component extraction"
  echo "    (Check that $FRAMER_ORIGIN/ is accessible)"
  exit 0
fi

echo "🔧  Extracting design components from homepage snapshot…"

python3 - <<PYEOF
import re, os, sys

snap_dir   = "$SNAPSHOTS_DIR"
shell_dir  = "$SHELL_DIR"
homepage   = os.path.join(snap_dir, 'homepage.html')

with open(homepage, encoding='utf-8', errors='replace') as f:
    html = f.read()

# ── 1. Font & icon <link> tags from <head> ───────────────────────────────────
font_links = re.findall(
    r'<link[^>]+(?:fonts\.googleapis\.com|fonts\.gstatic\.com|preload|stylesheet)[^>]*>',
    html
)
with open(os.path.join(shell_dir, 'fonts.html'), 'w') as f:
    f.write('\n'.join(font_links))
print(f"  fonts.html       — {len(font_links)} link tags")

# ── 2. All <style> blocks from <head> (Framer CSS tokens + layout) ───────────
style_blocks = re.findall(r'<style[^>]*>(.*?)</style>', html, re.DOTALL)
# Keep only substantive blocks (>200 chars — skip empty/tiny ones)
style_blocks = [s.strip() for s in style_blocks if len(s.strip()) > 200]
with open(os.path.join(shell_dir, 'styles.css'), 'w') as f:
    f.write('\n\n'.join(style_blocks))
print(f"  styles.css       — {len(style_blocks)} style blocks, {sum(len(s) for s in style_blocks):,} chars")

# ── 3. Navigation HTML ───────────────────────────────────────────────────────
# Framer wraps nav in a <nav> or a header div. Try several patterns.
nav_html = ''
for pattern in [
    r'(<nav\b[^>]*>.*?</nav>)',
    r'(<header\b[^>]*>.*?</header>)',
    r'(<!-- nav -->.*?<!-- /nav -->)',
]:
    m = re.search(pattern, html, re.DOTALL | re.IGNORECASE)
    if m:
        nav_html = m.group(1)
        break

with open(os.path.join(shell_dir, 'nav.html'), 'w') as f:
    f.write(nav_html)
print(f"  nav.html         — {len(nav_html):,} chars {'(found)' if nav_html else '(not found — Framer may not use <nav>)'}")

# ── 4. Footer HTML ───────────────────────────────────────────────────────────
footer_html = ''
for pattern in [
    r'(<footer\b[^>]*>.*?</footer>)',
    r'(<!-- footer -->.*?<!-- /footer -->)',
]:
    m = re.search(pattern, html, re.DOTALL | re.IGNORECASE)
    if m:
        footer_html = m.group(1)
        break

with open(os.path.join(shell_dir, 'footer.html'), 'w') as f:
    f.write(footer_html)
print(f"  footer.html      — {len(footer_html):,} chars {'(found)' if footer_html else '(not found)'}")

# ── 5. CSS custom properties / design tokens ────────────────────────────────
# Extract :root { ... } block(s) — these carry brand color tokens
root_blocks = re.findall(r':root\s*\{[^}]+\}', '\n'.join(style_blocks), re.DOTALL)
with open(os.path.join(shell_dir, 'tokens.css'), 'w') as f:
    f.write('\n'.join(root_blocks))
print(f"  tokens.css       — {len(root_blocks)} :root block(s)")

# ── 6. Write snapshot manifest ───────────────────────────────────────────────
import json, datetime
manifest = {
    'snapshotted_at': datetime.datetime.utcnow().isoformat() + 'Z',
    'framer_origin': '$FRAMER_ORIGIN',
    'pages': {},
}
for fname in os.listdir(snap_dir):
    if fname.endswith('.html'):
        size = os.path.getsize(os.path.join(snap_dir, fname))
        manifest['pages'][fname.replace('.html', '')] = size
with open(os.path.join(shell_dir, 'manifest.json'), 'w') as f:
    json.dump(manifest, f, indent=2)
print(f"  manifest.json    — {len(manifest['pages'])} page(s) recorded")

print('')
print('✅  Components extracted to cloudflare/marketing/framer-shell/')
PYEOF

echo ""
echo "✅  Snapshot complete."
echo ""
echo "Next steps:"
echo "  1. Review cloudflare/marketing/framer-shell/ — check nav.html + footer.html were found"
echo "  2. Commit snapshots:  git add cloudflare/marketing/snapshots/ cloudflare/marketing/framer-shell/"
echo "  3. Re-deploy worker:  bash cloudflare/marketing/deploy.sh"
echo "     (deploy.sh will embed the Framer components into worker-owned pages)"
