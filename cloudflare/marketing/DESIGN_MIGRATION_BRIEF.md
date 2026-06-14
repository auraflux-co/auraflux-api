# Marketing Site Design Migration Brief
**Last updated:** 2026-05-28  
**For:** Design session with Arely / Rob — combining Framer design with worker-owned pages

---

## What This Doc Is

Context for any AI session helping reconcile the Framer-designed marketing site (`auraflux.co`) with the worker-owned pages built during the May 28 engineering session. The goal is for Arely (or Rob) to work directly from the superadmin marketing editor — no more Framer publishes needed.

---

## Current State of Every Page on auraflux.co

| Page | Who owns it now | Design source | Notes |
|---|---|---|---|
| `/` (homepage) | **Framer** | Framer publish | Still proxied — needs migration |
| `/pricing` | **Worker** | Built from scratch today | Has brand colors, plan cards, Stripe live prices — MISSING Framer nav/footer until next deploy |
| `/contact` | **Worker** | Built from scratch today | Two-column layout: form + FAQ. FAQ editable via marketing editor |
| `/roadmap` | **Worker** | Built from scratch today | Lists 6 upcoming features — all editable via marketing editor |
| `/privacy` | **Worker** | Built from scratch today | Legal copy — full text |
| `/terms` | **Worker** | Built from scratch today | Legal copy — full text |
| `/aup` | **Worker** | Built from scratch today | Legal copy |
| `/cookies` | **Worker** | Built from scratch today | Legal copy |
| `/refunds` | **Worker** | Built from scratch today | Legal copy |
| `/about` | **Framer** | Framer publish | 404s on Framer — does not exist yet |
| `/features` | **Framer** | Framer publish | 404s on Framer — does not exist yet |
| `/blog` | **Framer** | Framer publish | 503 on Framer — not set up |

---

## What Was Done Today (Engineering)

- `/pricing`, `/contact`, `/roadmap` — fully built as worker-owned pages
- Framer nav + footer extracted from homepage snapshot → injected into all worker pages via `deploy.sh`
- Marketing editor at `app.auraflux.co/admin/marketing` — natural language chat box + form editor for all worker-owned pages
- HeyGen removed from all customer-facing surfaces (roadmap only, not offered at launch)
- `/roadmap` restored from 302 redirect to a real page

---

## The Design Reconciliation Problem

The worker-owned pages (pricing, contact, roadmap) were built with:
- AuraFlux brand colors (`#f5c542` gold, `#0b1220` dark navy)
- Custom minimal CSS for each page
- Framer nav + footer **injected from snapshot** (so they look like Framer pages on deploy)

The Framer site (proxied for homepage and other pages) was designed by Arely with:
- Full Framer component library
- The official brand kit fonts and tokens
- Hero sections, animations, image assets

**The gap:** Worker-owned page layouts were built functionally but not to Arely's visual spec. They need to be compared against the Framer site and brought into alignment on:
- Typography (font family, sizing, weight)
- Spacing and layout rhythm
- Hero section treatment per page
- Use of the 4 AuraFlux brand icons (HeroMonogram, EngineHexagon, SparkAnvil, FlowNetwork)

---

## What Arely / Rob Need to Do in the Design Session

1. **Review each worker-owned page** at `auraflux.co/pricing`, `/contact`, `/roadmap`
2. **Compare against Framer homepage** for design language consistency
3. **Decide on the homepage** — does it stay in Framer or get migrated to worker-owned? If migrated, Arely should provide the final HTML/CSS from Framer export or design in the marketing editor
4. **Brand icons** — Arely to decide where the 4 AuraFlux icons (`HeroMonogram`, `EngineHexagon`, `SparkAnvil`, `FlowNetwork`) appear. SVG source in `app/src/components/icons/brand-icons.tsx`
5. **Plan images** — the 3 images in `app/public/brand/plans/` (operate.png, guided.png, managed.png) have wrong dimensions. Pull from Stripe product catalog or replace with vector icons
6. **Copy review** — pricing page copy, contact page FAQ copy, roadmap item descriptions all editable from the marketing editor chat box

---

## How to Edit Worker-Owned Pages (No Code)

**Option 1 — Natural language (fastest):**  
Go to `app.auraflux.co/admin/marketing` → type instruction in the chat box → Preview → Apply.  
Example: *"update the pricing hero headline to 'Ship content that converts'"*

**Option 2 — Form editor:**  
Same page, scroll past the chat box → pick a tab (Pricing / Homepage / Contact / Roadmap) → edit fields → Save.

**Option 3 — Design changes (layout, CSS, structure):**  
Edit `cloudflare/marketing/_worker.js` directly (or ask the AI agent), then run:
```bash
bash cloudflare/marketing/deploy.sh
```

---

## How to Add a Whole New Page

1. Add the HTML to the `PAGES` object in `_worker.js`
2. Add the path to `WORKER_OWNED_PATHS` in `_worker.js`
3. Add the page + sections to `PAGE_SCHEMA` in both:
   - `lib/routes/marketing.js` (backend — drives Gemini interpret)
   - `app/src/app/(app)/admin/marketing/page.tsx` (frontend — drives form editor)
4. Run `bash cloudflare/marketing/deploy.sh`

---

## Framer Snapshot (Design Preservation)

The full Framer homepage HTML is stored in:
- `cloudflare/marketing/snapshots/homepage.html` — full 390KB page HTML
- `cloudflare/marketing/framer-shell/nav.html` — extracted Framer nav (5KB)
- `cloudflare/marketing/framer-shell/footer.html` — extracted Framer footer (11KB)
- `cloudflare/marketing/framer-shell/styles.css` — all Framer CSS (195KB)
- `cloudflare/marketing/framer-shell/tokens.css` — CSS custom property tokens

To refresh snapshots after a Framer publish:
```bash
bash cloudflare/marketing/scripts/snapshot.sh
bash cloudflare/marketing/deploy.sh
```

Once all pages are migrated off Framer, snapshot.sh is no longer needed.

---

## Key File Locations

| What | Where |
|---|---|
| Worker (all page HTML) | `cloudflare/marketing/_worker.js` |
| Deploy script | `cloudflare/marketing/deploy.sh` |
| Snapshot script | `cloudflare/marketing/scripts/snapshot.sh` |
| Framer design archive | `cloudflare/marketing/framer-shell/` |
| Marketing editor backend | `lib/routes/marketing.js` |
| Marketing editor frontend | `app/src/app/(app)/admin/marketing/page.tsx` |
| Brand icons (SVG) | `app/src/components/icons/brand-icons.tsx` |
| Plan images (needs fix) | `app/public/brand/plans/` |
