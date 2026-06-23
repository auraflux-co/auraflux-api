# C0 Repository Policy — localhost vs production

**Purpose:** Keep Rob's C0 localhost tool (`cwn-c0`, pm2, `cwn_production.html`) separate from C1+ production (`main` on Render) without merge conflicts.

## Two release lines, one GitHub org (interim)

| Line | Branch | Folder | Deploys to |
|------|--------|--------|------------|
| **C0 localhost** | `c0/main` (rename from `feat/cpd-1017-program-director`) | `/Users/robertgregory/cwn-c0` | pm2 `auraflux` @ localhost:3000 |
| **C1+ product** | `main` | `/Users/robertgregory/cwn-production` | Render `auraflux-api` + Vercel app |

Both currently push to `auraflux-co/auraflux-api`. **Never merge C0 → `main`.** Cherry-pick shared `lib/` fixes only when intentional.

**Status (2026-06-21, CPD-1024):** `~/cwn-c0` is on branch `c0/main` but `origin` still points at `auraflux-api`. Creating `auraflux-co/auraflux-c0` and repointing the remote is the remaining infra step (requires GitHub admin).

## Long-term: dedicated repo (recommended)

1. Create private GitHub repo **`auraflux-c0`** (or `clipzworld-c0`).
2. Push current C0 line:
   ```bash
   cd ~/cwn-c0
   git branch -m feat/cpd-1017-program-director c0/main   # if not done
   git remote rename origin production
   git remote add origin git@github.com:auraflux-co/auraflux-c0.git
   git push -u origin c0/main
   ```
3. Point `~/cwn-c0` only at `auraflux-c0`. Keep `~/cwn-production` on `auraflux-api` / `main`.
4. Close PRs targeting `main` from C0 branches (e.g. #637) — label **won't merge, C0 line**.
5. Add branch protection on `auraflux-api` `main`; no requirement on `auraflux-c0`.

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
