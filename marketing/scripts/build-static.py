#!/usr/bin/env python3
"""Build static marketing site for Vercel from cloudflare/marketing sources."""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]  # marketing/
REPO = ROOT.parent
SRC = ROOT  # vendored under marketing/ for Vercel upload
PAGES = SRC / "pages"
SHELL = SRC / "framer-shell"
CONTENT = SRC / "content"
PUBLIC = SRC / "public"
LEGAL = ROOT / "legal"
DIST = ROOT / "dist"

FALLBACK_NAV = (
    '<nav style="padding:20px 40px;border-bottom:1px solid rgba(228,228,231,.9)">'
    '<a href="/" style="color:#0b1220;font-weight:700">AuraFlux</a></nav>'
)
FALLBACK_FOOTER = (
    '<footer style="text-align:center;padding:40px;color:#64748b;font-size:.8rem">'
    '<a href="https://auraflux.co" style="color:#0b1220">AuraFlux</a></footer>'
)


def read(path: Path, default: str = "") -> str:
    if path.is_file():
        return path.read_text(encoding="utf-8", errors="replace")
    return default


def inject_shell(html: str, fonts: str, nav: str, footer: str, css: str, base: str) -> str:
    html = html.replace("${FRAMER_FONTS || ''}", fonts)
    html = html.replace("${FRAMER_NAV || FALLBACK_NAV}", nav or FALLBACK_NAV)
    html = html.replace("${FRAMER_FOOTER || FALLBACK_FOOTER}", footer or FALLBACK_FOOTER)
    css_block = f"<style>{css}</style>" if css else ""
    html = html.replace("${FRAMER_CSS || ''}", css_block)
    # LEGAL_SHELL leftover ternary from worker extract
    html = re.sub(
        r"\$\{FRAMER_CSS \? `[^`]*` : ''\}",
        css_block,
        html,
    )
    if base and "</head>" in html:
        html = html.replace("</head>", f"<style>{base}</style>\n</head>", 1)
    return html


def write_route(route: str, html: str) -> None:
    """Write HTML to dist path. route '/' -> index.html; '/plans' -> plans/index.html."""
    route = route.rstrip("/") or ""
    if route == "":
        out = DIST / "index.html"
    else:
        out = DIST / route.lstrip("/") / "index.html"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html, encoding="utf-8")
    print(f"  ✓ {route or '/'} → {out.relative_to(DIST)}")


def md_to_html(md: str) -> str:
    """Minimal markdown → HTML for blog_posts body field."""
    lines = md.split("\n")
    out: list[str] = []
    in_list = False
    for line in lines:
        s = line.rstrip()
        if s.startswith("### "):
            if in_list:
                out.append("</ul>")
                in_list = False
            out.append(f"<h3>{s[4:]}</h3>")
        elif s.startswith("## "):
            if in_list:
                out.append("</ul>")
                in_list = False
            out.append(f"<h2>{s[3:]}</h2>")
        elif s.startswith("# "):
            if in_list:
                out.append("</ul>")
                in_list = False
            out.append(f"<h2>{s[2:]}</h2>")
        elif s.startswith("- ") or s.startswith("* "):
            if not in_list:
                out.append("<ul>")
                in_list = True
            out.append(f"<li>{s[2:]}</li>")
        elif s.strip() == "":
            if in_list:
                out.append("</ul>")
                in_list = False
        else:
            if in_list:
                out.append("</ul>")
                in_list = False
            s = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)
            s = re.sub(r"\*(.+?)\*", r"<em>\1</em>", s)
            s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
            s = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2">\1</a>', s)
            out.append(f"<p>{s}</p>")
    if in_list:
        out.append("</ul>")
    return "\n".join(out)


def compile_blog_posts(fonts: str, nav: str, footer: str, css: str, base: str) -> int:
    """Fill blog-post-template.html from content/blog-posts/*.json → /blog/<slug>/."""
    import json

    template_path = PAGES / "blog-post-template.html"
    posts_dir = CONTENT / "blog-posts"
    if not template_path.is_file() or not posts_dir.is_dir():
        print("  – skip blog CMS posts (template or blog-posts/ missing)")
        return 0

    template = read(template_path)
    count = 0
    for fpath in sorted(posts_dir.glob("*.json")):
        try:
            post = json.loads(fpath.read_text(encoding="utf-8"))
        except Exception as exc:
            print(f"  ✗ blog post JSON {fpath.name}: {exc}")
            continue
        if not post.get("published"):
            continue
        slug = post.get("slug") or fpath.stem
        title = post.get("title") or "Untitled"
        desc = post.get("description") or ""
        tag = post.get("tag") or ""
        author = post.get("author") or "AuraFlux"
        date = post.get("date") or ""
        og_img = post.get("cover_image") or "https://auraflux.co/favicon.png"
        cover = (
            f'<img class="post-cover" src="{og_img}" alt="{title}">'
            if post.get("cover_image")
            else ""
        )
        body = post.get("body_html") or ""
        if not body and post.get("body"):
            body = md_to_html(post["body"])
        if not body:
            body = "<p>Coming soon.</p>"

        html = template
        for key, val in {
            "__POST_TITLE__": title,
            "__POST_DESC__": desc,
            "__POST_SLUG__": slug,
            "__POST_TAG__": tag,
            "__POST_AUTHOR__": author,
            "__POST_DATE__": date,
            "__POST_COVER__": cover,
            "__POST_BODY__": body,
            "__POST_OG_IMAGE__": og_img,
        }.items():
            html = html.replace(key, str(val))

        write_route(f"/blog/{slug}", inject_shell(html, fonts, nav, footer, css, base))
        count += 1
    if count:
        print(f"  ✓ {count} blog post(s) from content/blog-posts/")
    return count


def main() -> int:
    if not PAGES.is_dir():
        print(f"ERROR: missing source pages at {PAGES}", file=sys.stderr)
        return 1

    # CMS inject into source pages
    inject = ROOT / "scripts" / "inject_content.py"
    if inject.is_file() and CONTENT.is_dir():
        print("📝  Injecting CMS content…")
        subprocess.check_call([sys.executable, str(inject), str(PAGES), str(CONTENT)])
    else:
        print("  – skip CMS inject")

    fonts = read(SHELL / "fonts.html")
    nav = read(SHELL / "nav.html")
    footer = read(SHELL / "footer.html")
    css = read(SHELL / "styles.css")
    base = read(SHELL / "page-base.css")
    css = css.replace("https://assets.auraflux.co", "/cf-assets")

    if DIST.exists():
        shutil.rmtree(DIST)
    DIST.mkdir(parents=True)

    print("🏗  Building static pages…")

    # Primary page map: url path → source html file
    page_map = {
        "/": "home.html",
        "/blog": "blog.html",
        "/pricing": "pricing.html",
        "/our-story": "about.html",
        "/features": "system.html",
        "/developer-api": "developer-api.html",
        "/work": "work.html",
        "/how-it-works": "how-it-works.html",
        "/thanks": "thanks.html",
    }

    for route, fname in page_map.items():
        raw = read(PAGES / fname)
        if not raw:
            print(f"  ✗ missing {fname}")
            continue
        if route == "/":
            raw = re.sub(
                r'<link rel="canonical" href="https://[a-z0-9]+\.auraflux-marketing\.pages\.dev[^"]*"',
                '<link rel="canonical" href="https://auraflux.co/"',
                raw,
            )
        html = inject_shell(raw, fonts, nav, footer, css, base)
        write_route(route, html)

    # Blog articles from shared template + content/blog-posts/*.json
    compile_blog_posts(fonts, nav, footer, css, base)

    # Legal + contact/roadmap shells
    contact_body = read(PAGES / "contact-content.html")
    roadmap_body = read(PAGES / "roadmap-content.html")
    for legal_file in sorted(LEGAL.glob("*.html")):
        slug = legal_file.stem
        raw = read(legal_file)
        raw = raw.replace("__PAGE_CONTACT_CONTENT__", contact_body)
        raw = raw.replace("__PAGE_ROADMAP_CONTENT__", roadmap_body)
        html = inject_shell(raw, fonts, nav, footer, css, base)
        write_route(f"/{slug}", html)

    # Aliases as duplicate static files (vercel redirects also cover these)
    aliases = {
        "/plans": "/pricing",
        "/about": "/our-story",
        "/system": "/features",
        "/our-system": "/features",
        "/contact-us": "/contact",
        "/process": "/how-it-works",
    }
    for alias, target in aliases.items():
        src = DIST / target.lstrip("/") / "index.html"
        if src.is_file():
            write_route(alias, src.read_text(encoding="utf-8"))

    # Public assets
    if PUBLIC.is_dir():
        for item in PUBLIC.iterdir():
            dest = DIST / item.name
            if item.is_dir():
                shutil.copytree(item, dest, dirs_exist_ok=True)
            else:
                shutil.copy2(item, dest)
        print("  ✓ copied public/")

    # Favicon fallback from repo if present
    for cand in [
        REPO / "app" / "public" / "favicon.png",
        SRC / "assets" / "favicon.png",
    ]:
        if cand.is_file():
            shutil.copy2(cand, DIST / "favicon.png")
            print(f"  ✓ favicon from {cand}")
            break

    # 404
    not_found = read(PAGES / "404.html")
    if not_found:
        (DIST / "404.html").write_text(
            inject_shell(not_found, fonts, nav, footer, css, base), encoding="utf-8"
        )
        print("  ✓ 404.html")

    print(f"✅  Build complete → {DIST}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
