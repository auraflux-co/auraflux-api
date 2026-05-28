#!/usr/bin/env bash
# deploy.sh — Build + deploy _worker.js to Cloudflare Pages (auraflux-marketing)
#
# What it does:
#   1. Detects the latest Framer-content deployment (≥100KB homepage)
#   2. Stamps that hash URL into FRAMER_ORIGIN in the worker before uploading
#   3. Injects Framer design components (fonts, CSS, nav, footer) from
#      cloudflare/marketing/framer-shell/ into the worker build so that
#      worker-owned pages (pricing, contact, roadmap, legal) match the Framer design
#   4. Uploads the built _worker.js via CF Direct Upload API
#
# Usage:
#   CF_API_TOKEN=<token> bash cloudflare/marketing/deploy.sh
#   OR: set CF_API_TOKEN in repo .env
#
# To refresh Framer snapshots first:
#   bash cloudflare/marketing/scripts/snapshot.sh && bash cloudflare/marketing/deploy.sh

set -euo pipefail

ACCOUNT_ID="${CF_ACCOUNT_ID:-df04bc264530390035c77664f1b403d9}"
PROJECT_NAME="${CF_PAGES_PROJECT:-auraflux-marketing}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKER_SRC="$SCRIPT_DIR/_worker.js"
WORKER_BUILD="/tmp/_worker_build.js"
SHELL_DIR="$SCRIPT_DIR/framer-shell"
PAGES_DIR="$SCRIPT_DIR/pages"

# ── Load CF_API_TOKEN from .env if not set ────────────────────────────────────
if [[ -z "${CF_API_TOKEN:-}" ]]; then
  REPO_ENV="$(dirname "$0")/../../.env"
  if [[ -f "$REPO_ENV" ]]; then
    CF_API_TOKEN="$(grep -E '^CF_API_TOKEN=' "$REPO_ENV" | cut -d= -f2- | tr -d "\"'" | head -1 || true)"
  fi
fi

if [[ -z "${CF_API_TOKEN:-}" ]]; then
  echo "ERROR: CF_API_TOKEN not set."
  echo "  export CF_API_TOKEN=<cloudflare-pages-edit-token>"
  exit 1
fi

# ── Step 1: Detect latest Framer content snapshot ────────────────────────────
echo "🔍  Finding latest Framer content snapshot..."

FRAMER_HASH=""
DEPLOYMENTS=$(python3 -c "
import urllib.request, json, sys
req = urllib.request.Request(
    'https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/pages/projects/$PROJECT_NAME/deployments?per_page=20',
    headers={'Authorization': 'Bearer $CF_API_TOKEN'}
)
with urllib.request.urlopen(req, timeout=10) as r:
    d = json.loads(r.read())
for dep in d.get('result', []):
    print(dep.get('url',''))
")

while IFS= read -r DEPLOY_URL; do
  if [[ -z "$DEPLOY_URL" ]]; then continue; fi
  SIZE=$(python3 -c "
import urllib.request
try:
    req = urllib.request.Request('$DEPLOY_URL/', headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=8) as r:
        print(len(r.read()))
except:
    print(0)
" 2>/dev/null || echo 0)
  if [[ "$SIZE" -gt 100000 ]]; then
    FRAMER_HASH="$DEPLOY_URL"
    echo "    ✓ Found: $DEPLOY_URL (${SIZE}B)"
    break
  fi
  echo "    skip: $DEPLOY_URL (${SIZE}B — worker-only)"
done <<< "$DEPLOYMENTS"

if [[ -z "$FRAMER_HASH" ]]; then
  echo "⚠️   No Framer snapshot found — using existing FRAMER_ORIGIN in worker"
  cp "$WORKER_SRC" "$WORKER_BUILD"
else
  # Stamp the detected hash into the worker
  python3 -c "
import re
with open('$WORKER_SRC') as f:
    content = f.read()
# Replace the FRAMER_ORIGIN constant
content = re.sub(
    r\"const FRAMER_ORIGIN = '[^']*';\",
    \"const FRAMER_ORIGIN = '$FRAMER_HASH';\",
    content
)
with open('$WORKER_BUILD', 'w') as f:
    f.write(content)
print('  Stamped FRAMER_ORIGIN = $FRAMER_HASH')
"
fi

# ── Step 2: Inject Framer shell components ───────────────────────────────────
# Read extracted Framer design files and embed them into the worker build.
# Placeholders in _worker.js:
#   __FRAMER_FONTS__    → framer-shell/fonts.html  (font <link> tags)
#   __FRAMER_CSS__      → framer-shell/styles.css  (Framer global CSS)
#   __FRAMER_NAV__      → framer-shell/nav.html    (navigation HTML)
#   __FRAMER_FOOTER__   → framer-shell/footer.html (footer HTML)

python3 - <<PYEOF
import os, re

build   = open("$WORKER_BUILD", encoding='utf-8').read()
shell   = "$SHELL_DIR"

def read(name, default=''):
    p = os.path.join(shell, name)
    if os.path.isfile(p):
        val = open(p, encoding='utf-8', errors='replace').read().strip()
        if val:
            print(f"  ✓ Injected {name} ({len(val):,} chars)")
            return val
    print(f"  – {name} not found — using worker default")
    return default

fonts  = read('fonts.html')
css    = read('styles.css')
nav    = read('nav.html')
footer = read('footer.html')

# Escape for JS string replacement (backticks in CSS/HTML need escaping)
def js_escape(s):
    return s.replace('\\\\', '\\\\\\\\').replace('\`', '\\\`').replace('\${', '\\\${')

replacements = {
    '__FRAMER_FONTS__':  js_escape(fonts),
    '__FRAMER_CSS__':    js_escape(css),
    '__FRAMER_NAV__':    js_escape(nav),
    '__FRAMER_FOOTER__': js_escape(footer),
}

for placeholder, value in replacements.items():
    if placeholder in build:
        build = build.replace(placeholder, value)

with open("$WORKER_BUILD", 'w', encoding='utf-8') as f:
    f.write(build)
PYEOF

# ── Step 2b: Inject page HTML files ──────────────────────────────────────────
# cloudflare/marketing/pages/*.html → worker placeholders:
#   __PAGE_PRICING__          → pages/pricing.html          (full page)
#   __PAGE_CONTACT_CONTENT__  → pages/contact-content.html  (LEGAL_SHELL inner body)
#   __PAGE_ROADMAP_CONTENT__  → pages/roadmap-content.html  (LEGAL_SHELL inner body)

python3 - <<PYEOF
import os, re

build    = open("$WORKER_BUILD", encoding='utf-8').read()
pages    = "$PAGES_DIR"

def read_page(name, default=''):
    p = os.path.join(pages, name)
    if os.path.isfile(p):
        val = open(p, encoding='utf-8', errors='replace').read().strip()
        if val:
            print(f"  ✓ Injected pages/{name} ({len(val):,} chars)")
            return val
    print(f"  – pages/{name} not found — placeholder left as-is")
    return default

# Escape for embedding inside a JS template literal
def js_escape(s):
    return s.replace('\\\\', '\\\\\\\\').replace('\`', '\\\`')
    # Note: \${...} expressions in page files are INTENTIONAL (e.g. \${FRAMER_FONTS || ''})
    # and must NOT be escaped so JS evaluates them at runtime

pricing          = js_escape(read_page('pricing.html'))
contact_content  = js_escape(read_page('contact-content.html'))
roadmap_content  = js_escape(read_page('roadmap-content.html'))

build = build.replace('__PAGE_PRICING__',         pricing)
build = build.replace('__PAGE_CONTACT_CONTENT__',  contact_content)
build = build.replace('__PAGE_ROADMAP_CONTENT__',  roadmap_content)

with open("$WORKER_BUILD", 'w', encoding='utf-8') as f:
    f.write(build)
PYEOF

echo ""
# ── Step 3: Deploy via Python urllib (curl not available in all environments) ──
echo ""
echo "🚀  Deploying to Cloudflare Pages [$PROJECT_NAME]..."

RESPONSE=$(python3 - <<PYEOF
import urllib.request, os, json

account_id   = "$ACCOUNT_ID"
project_name = "$PROJECT_NAME"
token        = "$CF_API_TOKEN"
worker_file  = "$WORKER_BUILD"

with open(worker_file, 'rb') as f:
    worker_data = f.read()

boundary = b'----FormBoundary' + os.urandom(8).hex().encode()

def part_field(name, value):
    return (
        b'--' + boundary + b'\r\n'
        b'Content-Disposition: form-data; name="' + name.encode() + b'"\r\n\r\n'
        + value.encode() + b'\r\n'
    )

def part_file(name, filename, content_type, data):
    return (
        b'--' + boundary + b'\r\n'
        b'Content-Disposition: form-data; name="' + name.encode() + b'"; filename="' + filename.encode() + b'"\r\n'
        b'Content-Type: ' + content_type.encode() + b'\r\n\r\n'
        + data + b'\r\n'
    )

body = (
    part_field('manifest', '{}')
    + part_file('_worker.js', '_worker.js', 'application/javascript', worker_data)
    + b'--' + boundary + b'--\r\n'
)

url = f'https://api.cloudflare.com/client/v4/accounts/{account_id}/pages/projects/{project_name}/deployments'
req = urllib.request.Request(
    url,
    data=body,
    headers={
        'Authorization': f'Bearer {token}',
        'Content-Type': f'multipart/form-data; boundary={boundary.decode()}',
    },
    method='POST'
)

try:
    with urllib.request.urlopen(req, timeout=60) as r:
        print(r.read().decode())
except urllib.error.HTTPError as e:
    print(e.read().decode())
PYEOF
)

SUCCESS=$(echo "$RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('success','false'))" 2>/dev/null)
PREVIEW_URL=$(echo "$RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('result',{}).get('url',''))" 2>/dev/null)

if [[ "$SUCCESS" == "True" || "$SUCCESS" == "true" ]]; then
  echo "✅  Deployed!"
  echo "    Preview: $PREVIEW_URL"
  echo "    Live:    https://auraflux.co  (propagates in ~60s)"
else
  echo "❌  Deploy failed:"
  echo "$RESPONSE" | python3 -m json.tool
  exit 1
fi

# Update FRAMER_ORIGIN in source file to match what was deployed
if [[ -n "$FRAMER_HASH" ]]; then
  python3 -c "
import re
with open('$WORKER_SRC') as f:
    content = f.read()
content = re.sub(
    r\"const FRAMER_ORIGIN = '[^']*';\",
    \"const FRAMER_ORIGIN = '$FRAMER_HASH';\",
    content
)
with open('$WORKER_SRC', 'w') as f:
    f.write(content)
"
  echo "    FRAMER_ORIGIN updated in _worker.js source"
fi
