# C0 Repository Policy — localhost vs production

**Epic:** [CPD-1021](https://aurafluxco.atlassian.net/browse/CPD-1021) — C0 separation + publish regression  
**Worker memory:** `STATUS.md` (top) · `.cursor/rules/c0-render-separation.mdc` · Serena `c0-render-separation`

**Purpose:** Keep Rob's C0 localhost tool (`cwn-c0`, pm2, `cwn_production.html`) separate from C1+ production (`main` on Render) without merge conflicts.

## Two release lines — split complete (2026-06-14)

| Line | Branch | Folder | GitHub | Deploys to |
|------|--------|--------|--------|------------|
| **C0 localhost** | `c0/main` | `/Users/robertgregory/cwn-c0` | [auraflux-co/auraflux-c0](https://github.com/auraflux-co/auraflux-c0) | pm2 `auraflux` @ localhost:3000 |
| **C1+ product** | `main` | `/Users/robertgregory/cwn-production` | [auraflux-co/auraflux-api](https://github.com/auraflux-co/auraflux-api) | Render `auraflux-api` + Vercel app |

**Never merge C0 → `main`.** Cherry-pick shared `lib/` fixes only when intentional.

## Remote setup (already applied on Rob's Mac)

```bash
cd ~/cwn-c0
git remote rename origin production   # auraflux-api
git remote add origin https://github.com/auraflux-co/auraflux-c0.git
git push -u origin c0/main
```

## Historical note

Before 2026-06-14 both lines pushed to `auraflux-co/auraflux-api`. PR #637 merged C0 into `main` by mistake — do not repeat.

## Day-to-day rules (agents + Rob)

- **C0 work:** branch from `c0/main`, commit, push to `auraflux-c0`. No PR to production.
- **C1+ work:** branch from `main` in `cwn-production`, PR → merge → Render deploy.
- **Portable fixes** (storage, publish, feature_gate): commit on C0, cherry-pick hash onto `main` with a CPD ticket.
- **Reviews:** `aider_session_review_local.sh` (C0) vs `aider_session_review.sh` (production).
- **Dashboard URL:** http://localhost:3000/ (Node serves HTML). Port 8765 static server is optional legacy.

## What stays C0-only

- `cwn_production.html`, `assets/broadcast_dashboard.js`
- Live Grid / ClipzWorld TV / Broadcast Control Center
- `lib/gates/*`, manual segment workflow, HeyGen-first pipeline
- SQLite job store under `data/cwn.db`

## What may port to C1+ later

Extract by ticket, not wholesale merge:

- `lib/live_grid/*` APIs (if product needs multiview)
- Broadcast ops patterns → future Next.js ops UI
- Shared adapters already in `lib/` with C0 route gating (`lib/routes/c0_*.js`)

## Confluence

Single HOW page under AuraFlux / Engineering: **C0 vs C1+ branch policy** — link this file and the two repo URLs once split.
