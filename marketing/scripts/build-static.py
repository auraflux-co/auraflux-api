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
        "/plans": "pricing.html",
        "/our-story": "about.html",
        "/our-system": "system.html",
        "/developer-api": "developer-api.html",
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
        "/pricing": "/plans",
        "/about": "/our-story",
        "/system": "/our-system",
        "/contact-us": "/contact",
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
