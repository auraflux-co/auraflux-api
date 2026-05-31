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

# Escape for embedding inside a JS template literal (backtick string)
# Uses chr() to avoid bash heredoc interpreting backslash and dollar-brace sequences
def js_escape(s):
    BS, BT, DOPEN = chr(92), chr(96), chr(36)+chr(123)
    s = s.replace(BS, BS+BS)
    s = s.replace(BT, BS+BT)
    s = s.replace(DOPEN, BS+DOPEN)
    return s

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
#   __PAGE_HOME__             → pages/home.html              (full homepage)
#   __PAGE_BLOG__             → pages/blog.html              (full blog page)
#   __PAGE_PRICING__          → pages/pricing.html           (full page)
#   __PAGE_CONTACT_CONTENT__  → pages/contact-content.html   (LEGAL_SHELL inner body)
#   __PAGE_ROADMAP_CONTENT__  → pages/roadmap-content.html   (LEGAL_SHELL inner body)

python3 - <<PYEOF
import os, re

build    = open("$WORKER_BUILD", encoding='utf-8').read()
pages    = "$PAGES_DIR"
shell    = "$SHELL_DIR"

def read_page(name, default=''):
    p = os.path.join(pages, name)
    if os.path.isfile(p):
        val = open(p, encoding='utf-8', errors='replace').read().strip()
        if val:
            print(f"  ✓ Injected pages/{name} ({len(val):,} chars)")
            return val
    print(f"  – pages/{name} not found — placeholder left as-is")
    return default

def read_shell(name, default=''):
    p = os.path.join(shell, name)
    if os.path.isfile(p):
        val = open(p, encoding='utf-8', errors='replace').read().strip()
        if val:
            return val
    return default

# Escape for embedding inside a JS template literal (backtick string)
# Uses chr() to avoid bash heredoc interpreting backslash and dollar-brace sequences
def js_escape(s):
    BS, BT, DOPEN = chr(92), chr(96), chr(36)+chr(123)
    s = s.replace(BS, BS+BS)
    s = s.replace(BT, BS+BT)
    s = s.replace(DOPEN, BS+DOPEN)
    return s

# Load Framer shell components for page-level substitution
framer_fonts    = read_shell('fonts.html')
framer_nav      = read_shell('nav.html')
framer_footer   = read_shell('footer.html')
framer_css      = read_shell('styles.css')
page_base_css   = read_shell('page-base.css')

# Rewrite assets.auraflux.co → /cf-assets/ in the injected CSS so fonts are
# requested same-origin through the worker proxy, bypassing CORS restrictions.
ASSETS_ORIGIN = 'https://assets.auraflux.co'
ASSETS_PROXY  = '/cf-assets'
if ASSETS_ORIGIN in framer_css:
    framer_css = framer_css.replace(ASSETS_ORIGIN, ASSETS_PROXY)
    print(f"  ✓ Rewrote assets.auraflux.co → /cf-assets/ in styles.css ({framer_css.count(ASSETS_PROXY)} occurrences)")

FALLBACK_NAV = '<nav style="padding:20px 40px;border-bottom:1px solid rgba(255,255,255,.08)"><a href="/" style="color:#f5c542;font-weight:700">AuraFlux</a></nav>'
FALLBACK_FOOTER = '<footer style="text-align:center;padding:40px;color:#555580;font-size:.8rem"><a href="https://auraflux.co" style="color:#f5c542">AuraFlux</a></footer>'

def inject_framer(html):
    D = chr(36)
    html = html.replace(D + "{FRAMER_FONTS || ''}",         framer_fonts)
    html = html.replace(D + '{FRAMER_NAV || FALLBACK_NAV}', framer_nav or FALLBACK_NAV)
    html = html.replace(D + '{FRAMER_FOOTER || FALLBACK_FOOTER}', framer_footer or FALLBACK_FOOTER)
    # Wrap raw CSS in <style> tags — without this, the CSS text renders as
    # visible page content because browsers foster-parent raw head text to body.
    css_block = f'<style>{framer_css}</style>' if framer_css else ''
    html = html.replace(D + "{FRAMER_CSS || ''}",           css_block)
    # Inject shared base CSS (fonts, colours, nav seam fix) before </head>
    # Applied to all sub-pages without needing a placeholder in each file.
    if page_base_css and '</head>' in html:
        html = html.replace('</head>', f'<style>{page_base_css}</style>\n</head>', 1)
    return html

# ── home.html: patch Framer dev-domain artifacts before embedding ─────────────
home_raw = read_page('home.html')
# Fix canonical URL — Framer snapshot points to dev domain; patch to production
home_raw = re.sub(
    r'<link rel="canonical" href="https://[a-z0-9]+\.auraflux-marketing\.pages\.dev[^"]*"',
    '<link rel="canonical" href="https://auraflux.co/"',
    home_raw
)
# Fix og:url for the same reason
home_raw = re.sub(
    r'<meta property="og:url" content="https://[a-z0-9]+\.auraflux-marketing\.pages\.dev[^"]*"',
    '<meta property="og:url" content="https://auraflux.co/"',
    home_raw
)
# Fix page title — Framer template name leaks through if snapshot was taken before title was set
home_raw = re.sub(
    r'<title>[^<]*Equinox[^<]*</title>',
    '<title>AuraFlux — Automated Content Production</title>',
    home_raw
)
# Fix Framer generator meta — remove to avoid template fingerprinting
home_raw = re.sub(r'<meta name="generator" content="Framer[^"]*">', '', home_raw)
# Fix malformed meta tags — Framer snapshot produces ">>" closing brackets
home_raw = re.sub(r'>>(\s*\n)', r'>\1', home_raw)

# Inject service-worker unregistration script into <head>.
# Framer's SW caches .mjs modules from assets.auraflux.co. On repeat visits the
# stale SW serves cached modules while our page also loads them via /cf-assets/,
# causing two React instances that both call hydrateRoot → error #405.
# Unregistering immediately on page load clears the stale SW. The replacement
# /sw.js (served by _worker.js) then installs a no-op SW that doesn't interfere.
SW_UNREGISTER = (
    '<script>(function(){if("serviceWorker"in navigator){'
    'navigator.serviceWorker.getRegistrations()'
    '.then(function(r){r.forEach(function(sw){sw.unregister();});});}})();</script>'
)
if '</head>' in home_raw:
    home_raw = home_raw.replace('</head>', SW_UNREGISTER + '\n</head>', 1)
    print(f"  ✓ Injected SW unregistration script into home.html")

# Targeted URL rewrites for home.html — preserving React hydration.
#
# React's hydrateRoot compares the virtual DOM (from data-framer-hydrate-v2
# component data) against the real DOM. Only DOM elements rendered by the
# React component tree must stay identical to what component data says.
#
# Safe to rewrite (NOT in React VDOM):
#   <style> blocks — CSS @font-face, url() patterns
#   <script src="..."> — module loaders, never React-rendered
#   <link href="..."> — modulepreload/stylesheet hints, never React-rendered
#
# NEVER rewrite (IN React VDOM — would cause error #405):
#   <img src>, <img srcset> — React renders these from component data
#   data-framer-hydrate-v2 JSON — component data; React must match this exactly
#   <nav> replacement — React renders the nav from component data

def rewrite_style_block_urls(html, origin, proxy):
    """Rewrite origin URLs only inside <style>...</style> blocks."""
    out, pos = [], 0
    for m in re.finditer(r'<style(?:[^>]*)>(.*?)</style>', html, re.DOTALL):
        out.append(html[pos:m.start()])
        out.append(m.group(0).replace(origin, proxy))
        pos = m.end()
    out.append(html[pos:])
    return ''.join(out)

def rewrite_script_link_urls(html, origin, proxy):
    """Rewrite origin URLs only inside <script> and <link> tags (src/href attrs).
    These tags are never rendered by React so rewriting never causes hydration errors.
    Routes Framer module scripts and modulepreload hints through the CORS proxy."""
    out, pos = [], 0
    for m in re.finditer(r'<(script|link)\b([^>]*)>', html, re.DOTALL):
        out.append(html[pos:m.start()])
        out.append(f'<{m.group(1)}{m.group(2).replace(origin, proxy)}>')
        pos = m.end()
    out.append(html[pos:])
    return ''.join(out)

home_raw = rewrite_style_block_urls(home_raw, ASSETS_ORIGIN, ASSETS_PROXY)
home_raw = rewrite_script_link_urls(home_raw, ASSETS_ORIGIN, ASSETS_PROXY)
n_rewrites = home_raw.count(ASSETS_PROXY)
if n_rewrites:
    print(f"  ✓ Rewrote {n_rewrites} URLs via /cf-assets/ in home.html (<style>, <script>, <link> only)")

home             = js_escape(home_raw)

blog             = js_escape(inject_framer(read_page('blog.html')))
pricing          = js_escape(inject_framer(read_page('pricing.html')))
about            = js_escape(inject_framer(read_page('about.html')))
system           = js_escape(inject_framer(read_page('system.html')))
contact_content  = js_escape(read_page('contact-content.html'))
roadmap_content  = js_escape(read_page('roadmap-content.html'))

# Idempotency guards: only replace if the placeholder still exists in the build
if '__PAGE_HOME__' in build:
    build = build.replace('__PAGE_HOME__',            home)
if '__PAGE_BLOG__' in build:
    build = build.replace('__PAGE_BLOG__',            blog)
if '__PAGE_PRICING__' in build:
    build = build.replace('__PAGE_PRICING__',         pricing)
if '__PAGE_ABOUT__' in build:
    build = build.replace('__PAGE_ABOUT__',           about)
if '__PAGE_SYSTEM__' in build:
    build = build.replace('__PAGE_SYSTEM__',          system)
if '__PAGE_CONTACT_CONTENT__' in build:
    build = build.replace('__PAGE_CONTACT_CONTENT__', contact_content)
if '__PAGE_ROADMAP_CONTENT__' in build:
    build = build.replace('__PAGE_ROADMAP_CONTENT__', roadmap_content)

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
    + part_field('branch', 'main')
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
