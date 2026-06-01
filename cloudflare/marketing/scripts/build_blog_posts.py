#!/usr/bin/env python3
"""
build_blog_posts.py — compiles published blog posts from content/blog-posts/*.json
into worker-ready JS constant entries.

Usage: python3 scripts/build_blog_posts.py <worker_build_path> <pages_dir> <content_dir>
Outputs: modifies the worker build in place, replacing BLOG_POSTS constant.
"""

import sys, os, re, json, glob

worker_path  = sys.argv[1] if len(sys.argv) > 1 else '/tmp/_worker_build.js'
pages_dir    = sys.argv[2] if len(sys.argv) > 2 else 'pages'
content_dir  = sys.argv[3] if len(sys.argv) > 3 else 'content'

blog_posts_dir = os.path.join(content_dir, 'blog-posts')
template_path  = os.path.join(pages_dir, 'blog-post-template.html')

if not os.path.isfile(template_path):
    print('  – blog-post-template.html not found — skipping')
    sys.exit(0)

if not os.path.isdir(blog_posts_dir):
    print('  – content/blog-posts/ not found — skipping')
    sys.exit(0)

template = open(template_path, encoding='utf-8').read()
worker   = open(worker_path,  encoding='utf-8').read()


def md_to_html(md):
    """Minimal markdown → HTML converter."""
    lines = md.split('\n')
    out, in_list = [], False
    for line in lines:
        s = line.rstrip()
        if s.startswith('### '):
            if in_list: out.append('</ul>'); in_list = False
            out.append(f'<h3>{s[4:]}</h3>')
        elif s.startswith('## '):
            if in_list: out.append('</ul>'); in_list = False
            out.append(f'<h2>{s[3:]}</h2>')
        elif s.startswith('# '):
            if in_list: out.append('</ul>'); in_list = False
            out.append(f'<h2>{s[2:]}</h2>')
        elif s.startswith('> '):
            out.append(f'<blockquote>{s[2:]}</blockquote>')
        elif s.startswith('- ') or s.startswith('* '):
            if not in_list: out.append('<ul>'); in_list = True
            out.append(f'<li>{s[2:]}</li>')
        elif s.strip() == '':
            if in_list: out.append('</ul>'); in_list = False
            out.append('')
        else:
            if in_list: out.append('</ul>'); in_list = False
            s = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', s)
            s = re.sub(r'\*(.+?)\*',     r'<em>\1</em>',         s)
            s = re.sub(r'`([^`]+)`',     r'<code>\1</code>',      s)
            s = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', r'<a href="\2">\1</a>', s)
            out.append(f'<p>{s}</p>')
    if in_list: out.append('</ul>')
    return '\n'.join(out)


def js_escape(s):
    BS, BT, DOPEN = chr(92), chr(96), chr(36) + chr(123)
    s = s.replace(BS, BS + BS)
    s = s.replace(BT, BS + BT)
    s = s.replace(DOPEN, BS + DOPEN)
    return s


# Read framer-shell components for injection
shell_dir = os.path.join(os.path.dirname(pages_dir), 'framer-shell')

def read_shell(name):
    p = os.path.join(shell_dir, name)
    return open(p, encoding='utf-8').read().strip() if os.path.isfile(p) else ''

framer_fonts  = read_shell('fonts.html')
framer_nav    = read_shell('nav.html')
framer_footer = read_shell('footer.html')
framer_css    = read_shell('styles.css')
page_base_css = read_shell('page-base.css')

ASSETS_ORIGIN = 'https://assets.auraflux.co'
ASSETS_PROXY  = '/cf-assets'
if ASSETS_ORIGIN in framer_css:
    framer_css = framer_css.replace(ASSETS_ORIGIN, ASSETS_PROXY)

css_block = f'<style>{framer_css}</style>' if framer_css else ''

FALLBACK_NAV    = '<nav style="padding:20px;border-bottom:1px solid rgba(255,255,255,.08)"><a href="/" style="color:#f5c542;font-weight:700">AuraFlux</a></nav>'
FALLBACK_FOOTER = '<footer style="text-align:center;padding:40px;color:#555580;font-size:.8rem"><a href="https://auraflux.co" style="color:#f5c542">AuraFlux</a></footer>'

D = chr(36)

def inject_framer(html):
    html = html.replace(D + "{FRAMER_FONTS || ''}",          framer_fonts)
    html = html.replace(D + '{FRAMER_NAV || FALLBACK_NAV}',  framer_nav or FALLBACK_NAV)
    html = html.replace(D + '{FRAMER_FOOTER || FALLBACK_FOOTER}', framer_footer or FALLBACK_FOOTER)
    css_block_local = f'<style>{framer_css}</style>' if framer_css else ''
    html = html.replace(D + "{FRAMER_CSS || ''}",            css_block_local)
    if page_base_css and '</head>' in html:
        html = html.replace('</head>', f'<style>{page_base_css}</style>\n</head>', 1)
    return html


built = {}
count = 0

for fpath in sorted(glob.glob(os.path.join(blog_posts_dir, '*.json'))):
    try:
        p = json.loads(open(fpath).read())
        if not p.get('published'):
            continue
        slug    = p.get('slug', os.path.basename(fpath).replace('.json', ''))
        title   = p.get('title', 'Untitled')
        desc    = p.get('description', '')
        tag     = p.get('tag', '')
        author  = p.get('author', 'AuraFlux')
        date    = (p.get('date', '') or '')[:10]
        body_md = p.get('body', '')
        og_img  = p.get('cover_image', 'https://auraflux.co/favicon.png')
        cover   = f'<img class="post-cover" src="{og_img}" alt="{title}">' if p.get('cover_image') else ''
        body_html = md_to_html(body_md) if body_md else '<p>Coming soon.</p>'

        post_html = template
        post_html = post_html.replace('__POST_TITLE__',     title)
        post_html = post_html.replace('__POST_DESC__',      desc)
        post_html = post_html.replace('__POST_SLUG__',      slug)
        post_html = post_html.replace('__POST_TAG__',       tag)
        post_html = post_html.replace('__POST_AUTHOR__',    author)
        post_html = post_html.replace('__POST_DATE__',      date)
        post_html = post_html.replace('__POST_COVER__',     cover)
        post_html = post_html.replace('__POST_BODY__',      body_html)
        post_html = post_html.replace('__POST_OG_IMAGE__',  og_img)

        built[slug] = js_escape(inject_framer(post_html))
        count += 1
    except Exception as e:
        print(f'  ⚠  blog post error {fpath}: {e}')

if built:
    posts_entries = ',\n'.join(f'  "{k}":`{v}`' for k, v in built.items())
    posts_js = f'const BLOG_POSTS = {{\n{posts_entries}\n}};'
    worker = worker.replace('const BLOG_POSTS = {}; // populated by deploy.sh', posts_js)
    open(worker_path, 'w', encoding='utf-8').write(worker)
    print(f'  ✓ {count} blog post(s) compiled into worker')
else:
    print(f'  – no published blog posts found')
