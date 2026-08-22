# Marketing Site — Deployment Architecture & Pipeline

**Live URL:** https://auraflux.co  
**Platform:** Cloudflare Pages (Worker mode)  
**Project:** `auraflux-marketing` (Account: `df04bc264530390035c77664f1b403d9`)  
**Last updated:** 2026-08-22

---

## Cloudflare Pro zone (`auraflux.co`)

Marketing Pages is one piece of the **Pro zone**. The $25/mo plan applies to the whole domain (WAF, SSL, proxy), not Pages hosting alone.

| Host | Origin | Proxied |
|------|--------|---------|
| `auraflux.co`, `www` | Cloudflare Pages worker | Yes |
| `app.auraflux.co` | Vercel | Yes |
| `api.auraflux.co` | Render (`auraflux-api`) | Yes |
| `assets.auraflux.co` | R2 | Yes |

**Ops script:** `node scripts/ops/cloudflare_pro_optimize.mjs` (audit) · `--apply` for HSTS/HTTP/3/WAF rulesets. Requires `CF_API_TOKEN` with Zone Settings + Firewall Edit in Doppler.

**Token:** Rotate `CF_API_TOKEN` in Doppler if verify returns 401 — must include Firewall Services Edit to manage WAF/Page Rules via API.

**Keep Pro for:** managed WAF blocks (~400+ scan attempts/week at edge). **Review billing:** disable **Argo Smart Routing** ($5/mo) and **Cache Reserve** if subscribed without clear benefit.

---

## Architecture overview

`auraflux.co` is served by a **Cloudflare Pages Worker** (`_worker.js`), not a
static site. Every visitor request runs the Worker which returns the correct HTML
page directly from memory (no filesystem reads, no origin fetches for most pages).

```
Browser → Cloudflare Edge → _worker.js (Pages Worker)
                                  │
                         ┌────────┴───────────────────────────┐
                         │ Routes                              │
                         │  /            → home.html (embedded)│
                         │  /pricing     → pricing.html        │
                         │  /about       → about.html          │
                         │  /system      → system.html         │
                         │  /contact     → contact-content.html│
                         │  /roadmap     → roadmap-content.html│
                         │  /privacy,    → legal pages         │
                         │  /terms, etc                        │
                         │  /blog        → 301 → /             │
                         │  /sign-in     → 302 → app.auraflux  │
                         │  /sign-up     → 302 → app.auraflux  │
                         └─────────────────────────────────────┘
```

The Worker is a single JS file that embeds all page HTML as template literals.
It has no external dependencies and cold-starts in < 1ms.

---

## Repository layout

```
cloudflare/marketing/
├── _worker.js              ← Worker source template (not deployed directly)
├── deploy.sh               ← Build + deploy script (see below)
├── framer-shell/           ← Shared design components
│   ├── nav.html            ← Top navigation (injected into all pages)
│   ├── footer.html         ← Footer
│   ├── fonts.html          ← <link> tags for fonts
│   └── styles.css          ← Site-wide CSS overrides
├── pages/                  ← Per-page HTML content
│   ├── home.html           ← Homepage (full HTML snapshot)
│   ├── pricing.html
│   ├── about.html
│   ├── system.html
│   ├── contact-content.html
│   └── roadmap-content.html
└── snapshots/              ← Reference snapshots (source for home.html)
    └── homepage.html
```

**Design principle:** All content lives in the repo. Editing a file in `pages/`
or `framer-shell/` and pushing to `main` is the only action needed — CI handles
the rest.

---

## Deployment pipeline

### Automatic (preferred)

Every push to `main` that touches anything in `cloudflare/marketing/**` triggers
the GitHub Actions workflow `.github/workflows/marketing-deploy.yml`, which:

1. Checks out the repo
2. Installs `wrangler` globally (`npm install -g wrangler`)
3. Runs `bash cloudflare/marketing/deploy.sh`
4. Posts a summary with the live URL and commit SHA

**Propagation time:** Changes are live within ~60 seconds of the workflow completing.

### Manual (when needed)

```bash
# From repo root — requires CF_API_TOKEN in .env or shell environment
bash cloudflare/marketing/deploy.sh
```

### Force redeploy (no code change)

Use the GitHub Actions UI: **Actions → Deploy Marketing Site → Run workflow**.
Enter an optional reason; the workflow runs deploy.sh against the current `main`.

---

## What `deploy.sh` does (step by step)

1. **Detects Framer snapshot** — queries the CF Pages deployments API to find
   the latest deployment that served a ≥100KB homepage (the design snapshot).
   Stamps its URL into `FRAMER_ORIGIN` inside the worker so stylesheet paths
   resolve correctly.

2. **Injects shared components** — reads `framer-shell/nav.html`, `footer.html`,
   `fonts.html`, `styles.css` and substitutes them into the worker template where
   `${FRAMER_NAV || FALLBACK_NAV}`, `${FRAMER_FOOTER || FALLBACK_FOOTER}` etc.
   appear. This means every page (pricing, about, etc.) automatically inherits
   nav/footer changes without touching each page file.

3. **Embeds page HTML** — reads each file in `pages/` and JS-escapes it (escaping
   backticks and `${` so the strings are valid JS template literals).

4. **Deploys via wrangler** — copies the built `_worker_build.js` to a temp
   directory as `_worker.js` and runs `npx wrangler pages deploy --branch main`.
   Wrangler promotes the deployment to production (canonical), making it live on
   `auraflux.co` immediately.

---

## Required secrets

| Secret | Where | Value source |
|---|---|---|
| `CF_API_TOKEN` | GitHub Actions → Settings → Secrets | `.env` `CF_API_TOKEN` |

`CF_ACCOUNT_ID` and `CF_PAGES_PROJECT` are hardcoded in `deploy.sh` as defaults
and do not need to be secrets.

---

## Why visitors see stale content (and how to fix it)

### Root cause: missing CI → deploy link

Before 2026-05-30, there was no automatic deployment. Pushing code changes to
`main` updated the repo but **did not redeploy the Worker**. Visitors continued
to see the old worker until someone manually ran `deploy.sh`.

### Fix applied (2026-05-30)

Added `.github/workflows/marketing-deploy.yml`. Now any push to `main` touching
`cloudflare/marketing/**` auto-deploys within ~2 minutes.

### Other caching layers

| Layer | Behaviour | Notes |
|---|---|---|
| Cloudflare edge | `cf-cache-status: DYNAMIC` — not cached | Worker responses bypass CF cache |
| Browser cache | `cache-control: no-cache, no-store` | Browsers must revalidate every load |
| Static assets on `assets.auraflux.co` | Cached (CDN) | Images/fonts — expected, intentional |

**There is no CDN cache to purge** when the worker is updated. Once wrangler
promotes the new deployment, the next request to any URL gets the new worker.

---

## Adding a new page

1. Create `cloudflare/marketing/pages/<slug>.html` with the page body content
   (inside `<div class="page-content">` or full `<body>` — the worker wraps it
   in the shell template with nav and footer injected automatically).

2. Add a route in `cloudflare/marketing/_worker.js`:
   ```js
   case '/my-new-page':
     return html(MY_NEW_PAGE, req);
   ```

3. Add the page variable in `_worker.js` (or let `deploy.sh` inject it from
   `pages/my-new-page.html`).

4. Push to `main` → CI deploys automatically.

---

## Modifying navigation or footer

Edit `cloudflare/marketing/framer-shell/nav.html` (or `footer.html`). Push to
`main`. All pages automatically inherit the change on the next deploy.

---

## Rollback

To rollback to a previous worker version, go to:
**Cloudflare Dashboard → Pages → auraflux-marketing → Deployments** and click
**Rollback** on the deployment you want to restore.

Or re-run the workflow against an older commit using `git push --force-with-lease`
to a deploy branch (do not force-push `main`).
