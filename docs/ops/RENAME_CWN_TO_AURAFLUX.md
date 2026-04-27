# CWN → AuraFlux rename audit (checklist)

**Goal:** Systematic rename without breaking imports, `package.json`, dashboard URLs, and customer-facing strings in one blind replace.

**Last updated:** 2026-04-21

**Rule:** Do this as a **dedicated** branch + commit series; not mixed with feature work.

---

## Tiers (suggested order)

1. **User-facing copy**  
   - `cwn_production.html`, `README.md`, dashboard strings, `package.json` `description` if needed.

2. **New Relic / env**  
   - `newrelic.js` `app_name` (already `AuraFlux` in some trees — verify).  
   - Render/Vercel display names.

3. **Code identifiers (risky)**  
   - Internal route paths containing `cwn` (breaking if external bookmarks exist).  
   - Prefer new routes **alongside** old for one release, then deprecate.

4. **Data / files**  
   - `cwn.db`, `cwn_*.html` file names: migrate in a **maintenance window**; symlink or copy if needed.

5. **GitHub / package**  
   - Repo rename: update `repository.url` in `package.json`, local remotes, CI.  
   - `npm` package name `cwn-production` — changing breaks installs; only if publishing.

---

## Search commands (local)

```bash
rg -n "CWN|cwn-production|ClipzWorld" --glob '!node_modules' --glob '!data/*.db'
```

## Done when

- [ ] Grep for legacy brand in **customer-visible** surfaces is either updated or explicitly “legacy alias”.  
- [ ] Agents update `STATUS.md` / `cursor.md` references in same PR series.

---

## Audit results — 2026-04-27

### Already using AuraFlux (no action needed)

- `render.yaml` — service name `auraflux-api`
- `newrelic.js` — `app_name: AuraFlux`
- `lib/gates/gate1.js`, `gate3a.js`, `gate4.js` — already branded
- `lib/db.js`, `lib/queue.js`, `lib/monitoring.js`, `bin/heygen-poller.js` — already branded

### Tier 1 — Internal identifiers (safe to rename, Aider batch)

| File | What to change | Risk |
|------|---------------|------|
| `ecosystem.config.js` | App name `cwn-server` → `auraflux` | Low — PM2 process name only |
| `server.js` | Console log `"CWN Production Server running on..."` → `"AuraFlux API running on..."` | Low |
| `lib/config.js` | Internal log labels `CWN` → `AuraFlux` | Low |
| `lib/logger.js` | Log prefix `[CWN-ERROR]` → `[AURAFLUX-ERROR]` | Low |
| `lib/error_logger.js` | Log prefix `[CWN-ERROR]` → `[AURAFLUX-ERROR]` | Low |
| `lib/metrics.js`, `lib/pipeline_events.js` | Internal string labels | Low |

### Tier 2 — New Relic / env (verify only)

- `newrelic.js` — already `app_name: ['AuraFlux']`. Confirm, no change.
- Render environment panel — confirm service shows `auraflux-api` after deploy.

### Tier 3 — KEEP as ClipzWorld/CWN (show brand — do not rename)

These reference the actual show "ClipzWorld News" and must stay:
- `config/customers/c0.json` — `chromeSkin: "cwn"`, show branding
- `lib/assembly.js` — chrome strings with show name
- `tools/clipzworld_newscast.html` — IS the chrome template
- `tools/cwn_combined_ticker.html`, `cwn_twitch_ticker.html`, `cwn_sports_ticker.html`
- Script voiceovers / pinned comment URLs referencing `@clipzworldnews`

### Tier 4 — File renames (maintenance window, separate PR with symlinks)

- `data/cwn.db` → `data/auraflux.db` + update path in `lib/db.js`
- `cwn_production.html` → `auraflux_dashboard.html` + update static server path

### Tier 5 — GitHub / package (when publishing)

- `package.json` `name: "cwn-production"` → `"auraflux-api"` — only if publishing to npm
- GitHub repo rename — update `repository.url`, remotes, CI/CD

---

## Rob approves before execution

Proposed Aider batch (Tier 1 only — no external breakage, no file renames):
1. `ecosystem.config.js` — app name
2. `server.js` — console.log brand string
3. `lib/config.js`, `lib/logger.js`, `lib/metrics.js`, `lib/pipeline_events.js`, `lib/error_logger.js` — log prefixes

Tier 4 (file renames): separate PR, maintenance window, after Render is stable.

**To approve:** Reply "Tier 1 approved" and Cursor will run the Aider batch rename.

