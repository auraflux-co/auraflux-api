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
