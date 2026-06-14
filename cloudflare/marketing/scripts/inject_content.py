#!/usr/bin/env python3
"""
inject_content.py — reads content/*.json and patches the corresponding page HTML files.
Called by deploy.sh after pages are built but before the worker is assembled.

Usage: python3 scripts/inject_content.py <pages_dir> <content_dir>
"""

import json, re, os, sys

pages_dir   = sys.argv[1] if len(sys.argv) > 1 else 'pages'
content_dir = sys.argv[2] if len(sys.argv) > 2 else 'content'


def load(name):
    p = os.path.join(content_dir, name + '.json')
    return json.loads(open(p, encoding='utf-8').read()) if os.path.isfile(p) else {}


def patch_editables(html, data):
    """Replace text inside elements with data-editable="key" attributes."""
    if not data:
        return html

    def replacer(m):
        key    = m.group(1)
        before = m.group(2)   # opening tag up to and including >
        after  = m.group(4)   # closing tag
        val    = data.get(key)
        if val is None:
            return m.group(0)
        return before + str(val) + after

    return re.sub(
        r'data-editable="([^"]+)"([^>]*>)([\s\S]*?)(</[a-z0-9]+>)',
        replacer,
        html
    )


def patch_blog(html, data):
    posts = data.get('posts', [])
    if not posts:
        return html
    cards = '\n'.join(f'''    <div class="post-card">
      <span class="post-tag">{p["tag"]}</span>
      <h2>{p["title"]}</h2>
      <p>{p["description"]}</p>
      <div class="post-meta">{p.get("status", "Coming soon")}</div>
    </div>''' for p in posts)
    return re.sub(
        r'(<div class="posts">)([\s\S]*?)(</div>\s*\n\s*\$\{FRAMER_FOOTER|\n\$\{FRAMER_FOOTER)',
        lambda m: m.group(1) + '\n' + cards + '\n  </div>\n\n${FRAMER_FOOTER',
        html
    )


def patch_roadmap(html, data):
    """Populate kanban column sentinels with cards from JSON data.

    roadmap-content.html contains three sentinels:
      <!-- RDM_NOW -->    inside the IN DEVELOPMENT column
      <!-- RDM_NEXT -->   inside the PLANNED PIPELINE column
      <!-- RDM_FUTURE --> inside the FUTURE HORIZONS column

    Simple string replacement — no regex, no accumulation risk.
    """
    def build_cards(items, progress=False):
        out = []
        for item in items:
            tag = item.get('tag', '')
            cls = ('rdm-tag-publish' if 'publish' in tag.lower()
                   else 'rdm-tag-prod' if any(x in tag.lower() for x in ['prod'])
                   else 'rdm-tag-mono')
            prog = (
                '\n        <div class="rdm-progress"><div class="rdm-progress-fill"></div></div>'
                '\n        <div class="rdm-progress-label">ENGINE STAGE: PROCESSING</div>'
                if progress else ''
            )
            headline = item['headline'].replace('&', '&amp;')
            out.append(
                f'      <div class="rdm-card">\n'
                f'        <span class="rdm-tag {cls}">{tag}</span>\n'
                f'        <h3>{headline}</h3>{prog}\n'
                f'        <p>{item["description"]}</p>\n'
                f'      </div>'
            )
        return '\n'.join(out)

    for sentinel, key, with_progress in [
        ('<!-- RDM_NOW -->',    'now',    True),
        ('<!-- RDM_NEXT -->',   'next',   False),
        ('<!-- RDM_FUTURE -->', 'future', False),
    ]:
        items = data.get(key, [])
        if items:
            html = html.replace(sentinel, '\n' + build_cards(items, with_progress) + '\n    ', 1)

    return html


def patch_ctas(html, data, cta_map):
    """Update <a data-cta="key"> elements with label, url, and optional style from data."""
    for cta_name, (label_key, url_key, style_key) in cta_map.items():
        label = data.get(label_key)
        url   = data.get(url_key)
        style = data.get(style_key)

        def replacer(m, label=label, url=url, style=style):
            tag_open = m.group(1)   # everything from < up to >
            text     = m.group(2)   # inner text
            tag_close = m.group(3)  # </a>
            if url:
                tag_open = re.sub(r'href="[^"]*"', f'href="{url}"', tag_open)
            if style:
                # Replace class attribute, or add one
                if re.search(r'class="[^"]*"', tag_open):
                    tag_open = re.sub(r'class="[^"]*"', f'class="{style}"', tag_open)
                else:
                    tag_open = tag_open.rstrip('>') + f' class="{style}">'
            return tag_open + (str(label) if label else text) + tag_close

        html = re.sub(
            rf'(<a\b[^>]*\bdata-cta="{re.escape(cta_name)}"[^>]*>)([\s\S]*?)(</a>)',
            replacer,
            html
        )
    return html


def patch_seo(html, meta):
    if meta.get('title'):
        html = re.sub(r'<title>[^<]*</title>', f'<title>{meta["title"]}</title>', html)
    if meta.get('description'):
        html = re.sub(
            r'(<meta name="description" content=")[^"]*(")',
            rf'\g<1>{meta["description"]}\g<2>',
            html
        )
    if meta.get('og_image'):
        html = re.sub(
            r'(<meta property="og:image" content=")[^"]*(")',
            rf'\g<1>{meta["og_image"]}\g<2>',
            html
        )
    return html


def patch_footer(html, data):
    """Patch framer-shell/footer.html from content/footer.json."""
    tagline = data.get('tagline')
    if tagline:
        html = re.sub(
            r'(<p id="af-footer-tagline">)[^<]*(</p>)',
            rf'\g<1>{tagline}\g<2>', html)

    copyright_text = data.get('copyright')
    if copyright_text:
        html = re.sub(
            r'(<p id="af-footer-copy">)[^<]*(</p>)',
            rf'\g<1>{copyright_text}\g<2>', html)

    platform_links = data.get('platform_links', [])
    if platform_links:
        links_html = '\n'.join(
            f'          <a href="{lk["url"]}">{lk["label"]}</a>' for lk in platform_links)
        html = re.sub(
            r'(<div class="af-footer-col">\s*<span class="af-footer-col-label">Platform</span>)'
            r'([\s\S]*?)(</div>)',
            lambda m: m.group(1) + '\n' + links_html + '\n        ' + m.group(3),
            html, count=1)

    resource_links = data.get('resource_links', [])
    if resource_links:
        links_html = '\n'.join(
            f'          <a href="{lk["url"]}">{lk["label"]}</a>' for lk in resource_links)
        html = re.sub(
            r'(<div class="af-footer-col">\s*<span class="af-footer-col-label">Resources</span>)'
            r'([\s\S]*?)(</div>)',
            lambda m: m.group(1) + '\n' + links_html + '\n        ' + m.group(3),
            html, count=1)

    cls_map = {
        'LinkedIn': 'af-social-li', 'Instagram': 'af-social-ig',
        'TikTok': 'af-social-tt',   'YouTube': 'af-social-yt',
    }
    for social in data.get('social_links', []):
        css_class = cls_map.get(social.get('platform', ''))
        url = social.get('url', '')
        if css_class and url:
            html = re.sub(
                rf'(<a class="af-social {re.escape(css_class)}" href=")[^"]*(")',
                rf'\g<1>{url}\g<2>', html)

    return html


def patch_nav(html, data):
    """Patch framer-shell/nav.html from content/nav.json."""
    links = data.get('links', [])
    if links:
        links_html = '\n'.join(
            f'      <a href="{lk["url"]}">{lk["label"]}</a>' for lk in links)
        html = re.sub(
            r'(<div id="af-nav-links">)([\s\S]*?)(</div>)',
            lambda m: m.group(1) + '\n' + links_html + '\n    ' + m.group(3),
            html, count=1)

    cta_url   = data.get('cta_url')
    cta_label = data.get('cta_label')
    if cta_url:
        html = re.sub(
            r'(<a id="af-nav-cta" href=")[^"]*(")',
            rf'\g<1>{cta_url}\g<2>', html)
    if cta_label:
        html = re.sub(
            r'(<a id="af-nav-cta"[^>]*>)[^<]*(</a>)',
            rf'\g<1>{cta_label}\g<2>', html)

    return html


# ── Page → content mapping ────────────────────────────────────────────────────
PAGES = {
    'home.html':              ('home',       None),
    'about.html':             ('our-story',  None),
    'system.html':            ('our-system', None),
    'pricing.html':           ('plans',      None),
    'blog.html':              ('blog',       patch_blog),
    'contact-content.html':   ('contact',    None),
    'roadmap-content.html':   ('roadmap',    patch_roadmap),
}

seo_data  = load('seo')
seo_pages = {p['page']: p for p in seo_data.get('pages', [])}

changed = 0
for filename, (content_key, extra_patch) in PAGES.items():
    path = os.path.join(pages_dir, filename)
    if not os.path.isfile(path):
        continue

    data = load(content_key)
    html = open(path, encoding='utf-8').read()

    # 1. Patch data-editable fields
    html = patch_editables(html, data)

    # 2. Image URL patches
    if content_key == 'plans' and data:
        for plan, img_id in [('operate', 'plan-operate'), ('guided', 'plan-guided'), ('managed', 'plan-managed')]:
            p = data.get(plan, {})
            img_url = p.get('image_url', '')
            if img_url:
                # Normalize CMS-uploaded paths (relative /assets/ → /cf-assets/marketing/images/)
                if img_url.startswith('/assets/'):
                    img_url = '/cf-assets/marketing/images/' + img_url.split('/')[-1]
                html = re.sub(
                    rf'(<img class="plan-img" src=")[^"]*(" alt="{plan.capitalize()} plan")',
                    rf'\g<1>{img_url}\g<2>',
                    html
                )

    if content_key == 'our-story' and data:
        photo = data.get('founder_photo', '')
        if photo:
            if photo.startswith('/assets/'):
                photo = '/cf-assets/marketing/images/' + photo.split('/')[-1]
            html = re.sub(
                r'(<img src=")[^"]*(" alt="Rob Gregory"[^>]*id="founder-photo")',
                rf'\g<1>{photo}\g<2>',
                html
            )
        # Update founder name, role, bio if provided
        for field, selector in [
            ('founder_name', 'team-name'),
            ('founder_role', 'team-role'),
            ('founder_bio',  'team-bio'),
        ]:
            val = data.get(field)
            if val:
                html = re.sub(
                    rf'(<div class="{selector}">)[^<]*(</div>)',
                    rf'\g<1>{val}\g<2>',
                    html
                )

    # 3. CTA patches
    if content_key == 'our-story':
        html = patch_ctas(html, data, {
            'hero_cta':             ('hero_cta_label',           'hero_cta_url',           'hero_cta_style'),
            'hero_cta_secondary':   ('hero_cta_secondary_label', 'hero_cta_secondary_url', 'hero_cta_secondary_style'),
            'bottom_cta':           ('bottom_cta_label',         'bottom_cta_url',         'bottom_cta_style'),
            'bottom_cta_secondary': ('bottom_cta_secondary_label','bottom_cta_secondary_url','bottom_cta_secondary_style'),
        })
    if content_key in ('our-system', 'plans', 'home'):
        flat = {}
        for k, v in data.items():
            if isinstance(v, dict):
                for sk, sv in v.items():
                    flat[f'{k}.{sk}'] = sv
            else:
                flat[k] = v
        if content_key == 'our-system':
            html = patch_ctas(html, flat, {
                'hero_cta':   ('hero_cta_label',   'hero_cta_url',   'hero_cta_style'),
                'bottom_cta': ('bottom_cta_label', 'bottom_cta_url', 'bottom_cta_style'),
            })
        if content_key == 'plans':
            html = patch_ctas(html, flat, {
                'operate_cta': ('operate.cta_label', 'operate.cta_url', 'operate.cta_style'),
                'guided_cta':  ('guided.cta_label',  'guided.cta_url',  'guided.cta_style'),
                'managed_cta': ('managed.cta_label', 'managed.cta_url', 'managed.cta_style'),
            })
        if content_key == 'home':
            html = patch_ctas(html, data, {
                'hero_cta':   ('cta_primary_label', 'cta_primary_url', 'cta_primary_style'),
                'final_cta':  ('final_cta_label',   'final_cta_url',   'final_cta_style'),
            })

    # 4. Page-specific structural patches
    if extra_patch:
        html = extra_patch(html, data)

    # 3. SEO meta
    seo_key = content_key.replace('our-', '').replace('-content', '')
    # map content key to seo page key
    seo_map = {
        'home': 'home', 'our-story': 'our-story', 'our-system': 'our-system',
        'plans': 'plans', 'blog': 'blog', 'contact': 'contact', 'roadmap': 'roadmap',
    }
    seo_key_mapped = seo_map.get(content_key)
    if seo_key_mapped and seo_key_mapped in seo_pages:
        html = patch_seo(html, seo_pages[seo_key_mapped])

    open(path, 'w', encoding='utf-8').write(html)
    print(f'  ✓ content injected → {filename}')
    changed += 1

print(f'  → {changed} pages updated from content JSON')

# ── Framer-shell patches (footer.json + nav.json) ─────────────────────────────
SHELL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'framer-shell')
for shell_file, content_key, patch_fn in [
    ('footer.html', 'footer', patch_footer),
    ('nav.html',    'nav',    patch_nav),
]:
    path = os.path.join(SHELL_DIR, shell_file)
    if not os.path.isfile(path):
        print(f'  – framer-shell/{shell_file} not found — skipping')
        continue
    data = load(content_key)
    if not data:
        print(f'  – {content_key}.json empty — skipping {shell_file}')
        continue
    html = open(path, encoding='utf-8').read()
    html = patch_fn(html, data)
    open(path, 'w', encoding='utf-8').write(html)
    print(f'  ✓ framer-shell/{shell_file} patched from {content_key}.json')
    changed += 1

print(f'  → {changed} total files updated (pages + shell)')
