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

    # Only match content up to 2000 chars to avoid greedy cross-element matches
    return re.sub(
        r'data-editable="([^"]+)"([^>]*>)([^<]{0,2000})(</[a-z0-9]+>)',
        replacer,
        html
    )


STYLE_CLASSES = {
    'primary':   ('btn-primary',   'cta-primary'),
    'secondary': ('btn-secondary', 'cta-secondary'),
    'ghost':     ('btn-ghost',     'btn-ghost'),
}

def patch_ctas(html, data, cta_map):
    """
    Patch CTA buttons using data-cta attributes.
    cta_map: dict of { 'data_cta_value': ('label_key', 'url_key', 'style_key') }
    style_key is optional — if provided, swaps the btn-* class.
    """
    for cta_id, keys in cta_map.items():
        label_key = keys[0]
        url_key   = keys[1]
        style_key = keys[2] if len(keys) > 2 else None

        label = data.get(label_key)
        url   = data.get(url_key)
        style = data.get(style_key) if style_key else None

        # Swap button style class
        if style and style in STYLE_CLASSES:
            new_btn, new_cta = STYLE_CLASSES[style]
            # Replace btn-primary/btn-secondary/btn-ghost on the data-cta element
            html = re.sub(
                rf'(<a\b[^>]*data-cta="{re.escape(cta_id)}"[^>]*class=")([^"]*?)(")',
                lambda m: m.group(1) + re.sub(
                    r'\b(btn-primary|btn-secondary|btn-ghost|cta-primary|cta-secondary)\b',
                    lambda c: new_btn if 'btn-' in c.group(0) else new_cta,
                    m.group(2)
                ) + m.group(3),
                html
            )
            html = re.sub(
                rf'(<a\b[^>]*class=")([^"]*?)("[^>]*data-cta="{re.escape(cta_id)}")',
                lambda m: m.group(1) + re.sub(
                    r'\b(btn-primary|btn-secondary|btn-ghost|cta-primary|cta-secondary)\b',
                    lambda c: new_btn if 'btn-' in c.group(0) else new_cta,
                    m.group(2)
                ) + m.group(3),
                html
            )

        # Patch label
        if label:
            html = re.sub(
                rf'(data-cta="{re.escape(cta_id)}"[^>]*>)[^<]*(</a>)',
                rf'\g<1>{label}\g<2>',
                html
            )

        # Patch URL
        if url:
            html = re.sub(
                rf'(<a\b[^>]*\bhref=")[^"]*("[^>]*data-cta="{re.escape(cta_id)}")',
                rf'\g<1>{url}\g<2>',
                html
            )
            html = re.sub(
                rf'(<a\b[^>]*data-cta="{re.escape(cta_id)}"[^>]*\bhref=")[^"]*(")',
                rf'\g<1>{url}\g<2>',
                html
            )
    return html


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
    def cards(items, progress=False):
        out = []
        for item in items:
            tag = item.get('tag', '')
            cls = ('rdm-tag-publish' if 'publish' in tag.lower()
                   else 'rdm-tag-prod' if any(x in tag.lower() for x in ['prod', 'ai'])
                   else 'rdm-tag-mono')
            prog = ('\n        <div class="rdm-progress"><div class="rdm-progress-fill"></div></div>'
                    '\n        <div class="rdm-progress-label">ENGINE STAGE: PROCESSING</div>'
                    if progress else '')
            out.append(
                f'      <div class="rdm-card">\n'
                f'        <span class="rdm-tag {cls}">{tag}</span>\n'
                f'        <h3>{item["headline"]}</h3>{prog}\n'
                f'        <p>{item["description"]}</p>\n'
                f'      </div>'
            )
        return '\n'.join(out)

    for col, key, prog in [
        ('NOW',    'now',    True),
        ('NEXT',   'next',   False),
        ('FUTURE', 'future', False),
    ]:
        items = data.get(key, [])
        if not items:
            continue
        # Find the column's rdm-cards div and replace its contents
        pattern = rf'(<!-- {col} -->[\s\S]*?<div class="rdm-cards">)([\s\S]*?)(</div>\s*\n\s*</div>)'
        replacement = lambda m, c=cards(items, prog): m.group(1) + '\n' + c + '\n    ' + m.group(3)
        html = re.sub(pattern, replacement, html)

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


# ── Page → content mapping ────────────────────────────────────────────────────
# NOTE: home.html has no data-editable markers — skip it to avoid regex corruption
PAGES = {
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

    # 3. CTA patches — tuples are (label_key, url_key, style_key)
    cta_maps = {
        'our-story': {
            'hero_cta':             ('hero_cta_label',   'hero_cta_url',    'hero_cta_style'),
            'bottom_cta_secondary': ('cta_btn_label',    'cta_btn_url',     'cta_btn_style'),
        },
        'our-system': {
            'hero_cta':   ('hero_cta_label',   'hero_cta_url',    'hero_cta_style'),
            'bottom_cta': ('bottom_cta_label', 'bottom_cta_url',  'bottom_cta_style'),
        },
        'plans': {
            'operate_cta': ('operate.cta_label', 'operate.cta_url', 'operate.cta_style'),
            'guided_cta':  ('guided.cta_label',  'guided.cta_url',  'guided.cta_style'),
            'managed_cta': ('managed.cta_label', 'managed.cta_url', 'managed.cta_style'),
        },
    }
    if content_key in cta_maps:
        # Flatten nested keys for plans (operate.cta_label → data['operate']['cta_label'])
        flat_data = {}
        for k, v in data.items():
            if isinstance(v, dict):
                for sk, sv in v.items():
                    flat_data[f'{k}.{sk}'] = sv
            else:
                flat_data[k] = v
        html = patch_ctas(html, flat_data, cta_maps[content_key])

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

# ── Nav injection ─────────────────────────────────────────────────────────────
nav_data = load('nav')
if nav_data:
    nav_path = os.path.join(os.path.dirname(pages_dir), 'framer-shell', 'nav.html')
    if os.path.isfile(nav_path):
        nav_html = open(nav_path, encoding='utf-8').read()

        # Patch CTA button
        cta_label = nav_data.get('cta_label')
        cta_url   = nav_data.get('cta_url')
        if cta_label:
            nav_html = re.sub(r'(<a id="af-nav-cta"[^>]*>)[^<]*(</a>)',
                              rf'\g<1>{cta_label}\g<2>', nav_html)
        if cta_url:
            nav_html = re.sub(r'(<a id="af-nav-cta" href=")[^"]*(")',
                              rf'\g<1>{cta_url}\g<2>', nav_html)

        # Rebuild nav links
        links = nav_data.get('links', [])
        if links:
            links_html = '\n'.join(
                f'      <a href="{lnk["url"]}">{lnk["label"]}</a>' for lnk in links
            )
            nav_html = re.sub(
                r'(<div id="af-nav-links">)([\s\S]*?)(</div>)',
                lambda m: m.group(1) + '\n' + links_html + '\n    ' + m.group(3),
                nav_html, count=1
            )

        open(nav_path, 'w', encoding='utf-8').write(nav_html)
        print('  ✓ nav.html updated from nav.json')

# ── Footer injection ──────────────────────────────────────────────────────────
footer_data = load('footer')
if footer_data:
    footer_path = os.path.join(os.path.dirname(pages_dir), 'framer-shell', 'footer.html')
    if os.path.isfile(footer_path):
        footer_html = open(footer_path, encoding='utf-8').read()

        # Tagline
        tagline = footer_data.get('tagline')
        if tagline:
            footer_html = re.sub(
                r'(<p id="af-footer-tagline">)[^<]*(</p>)',
                rf'\g<1>{tagline}\g<2>', footer_html
            )

        # Copyright
        copyright = footer_data.get('copyright')
        if copyright:
            footer_html = re.sub(
                r'(<p id="af-footer-copy">)[^<]*(</p>)',
                rf'\g<1>{copyright}\g<2>', footer_html
            )

        # Platform + resource links (two-column nav)
        platform = footer_data.get('platform_links', [])
        resources = footer_data.get('resource_links', [])
        if platform or resources:
            platform_html = '\n'.join(
                f'          <a href="{l["url"]}">{l["label"]}</a>' for l in platform
            )
            resource_html = '\n'.join(
                f'          <a href="{l["url"]}">{l["label"]}</a>' for l in resources
            )
            col_html = (
                f'        <div class="af-footer-col">\n'
                f'          <span class="af-footer-col-label">Platform</span>\n'
                f'{platform_html}\n        </div>\n'
                f'        <div class="af-footer-col">\n'
                f'          <span class="af-footer-col-label">Resources</span>\n'
                f'{resource_html}\n        </div>'
            )
            footer_html = re.sub(
                r'(<nav id="af-footer-links"[^>]*>)([\s\S]*?)(</nav>)',
                lambda m: m.group(1) + '\n' + col_html + '\n      ' + m.group(3),
                footer_html, count=1
            )

        open(footer_path, 'w', encoding='utf-8').write(footer_html)
        print('  ✓ footer.html updated from footer.json')

# ── Blog posts injection ──────────────────────────────────────────────────────
import glob
blog_posts_dir = os.path.join(os.path.dirname(pages_dir), 'content', 'blog-posts')
if os.path.isdir(blog_posts_dir):
    posts = []
    for fpath in sorted(glob.glob(os.path.join(blog_posts_dir, '*.json'))):
        try:
            p = json.loads(open(fpath).read())
            if p.get('published'):
                posts.append(p)
        except Exception:
            pass

    if posts:
        blog_path = os.path.join(pages_dir, 'blog.html')
        if os.path.isfile(blog_path):
            blog_html = open(blog_path, encoding='utf-8').read()

            # Build card HTML for each published post
            def post_card(p):
                url = p.get('slug', '#')
                if not url.startswith('/'):
                    url = '/blog/' + url
                return (
                    f'    <div class="post-card">\n'
                    f'      <span class="post-tag">{p.get("tag","")}</span>\n'
                    f'      <h2><a href="{url}" style="color:#fff;text-decoration:none;">{p["title"]}</a></h2>\n'
                    f'      <p>{p.get("description","")}</p>\n'
                    f'      <div class="post-meta">{p.get("date","")[:10] if p.get("date") else ""}</div>\n'
                    f'    </div>'
                )

            cards = '\n'.join(post_card(p) for p in posts)
            blog_html = re.sub(
                r'(<div class="posts">)([\s\S]*?)(</div>\s*\n\s*\$\{FRAMER_FOOTER|\n\$\{FRAMER_FOOTER)',
                lambda m: m.group(1) + '\n' + cards + '\n  </div>\n\n${FRAMER_FOOTER',
                blog_html
            )
            open(blog_path, 'w', encoding='utf-8').write(blog_html)
            print(f'  ✓ blog.html updated with {len(posts)} published post(s)')
