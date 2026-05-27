```md
# AuraFlux Session Review — 2026-05-27

## 1. Session Summary

Heavy billing and credits overhaul: implemented credit hard stops, threshold alerts, auto top-up, and Stripe quantity picker across both API (`lib/routes/billing.js`, `lib/routes/credits.js`, `lib/services/stripe_billing.js`) and UI (`billing/page.tsx`, `credits/page.tsx`). Added 5 legal pages as public Next.js routes with Clerk middleware bypass. Completed frontend audit batch fixing UI inconsistencies across 10 dashboard pages. Backend gained Kick OAuth 2.1 + PKCE for source channel auth.

## 2. Jira Consistency

**Status: UNKNOWN — Jira API returned HTTP 000 for all board queries.**

Cannot verify:
- Whether tickets CPD-355 through CPD-379 were transitioned to Done
- Whether any tickets remain stuck in "In Development" post-merge
- PR-to-ticket alignment

**Action required:** Manually verify Jira board state or fix API credentials.

## 3. GitHub Consistency

| Issue | Details |
|-------|---------|
| Open PR needing merge | #593 `chore(deps): Bump axios from 1.15.2 to 1.16.1` — dependabot, safe to merge |
| CI failures | 5 failing workflows on `main`, `feat/cpd-327-multi-brand`, `fix/plan-images-prod` |
| Stale branches | `feat/cpd-327-multi-brand` — blocked by CI; needs attention |

**CI failures on main are blocking production deploys.**

## 4. Confluence Consistency

**Status: UNKNOWN — Confluence API returned HTTP 000.**

Cannot verify HOW doc coverage. Based on commits, these features likely need docs:
- Auto top-up flow (CPD-367/368/369)
- Credit pack quantity picker
- Kick OAuth 2.1 source connection
- Legal pages structure/routing

## 5. Frontend UI Integrity

| Check | Result |
|-------|--------|
| Pages on disk | `app/src/app/dashboard/*/page.tsx` — **none found** |
| Sidebar nav routes | **none extracted** |
| TypeScript | ✅ No errors |

**Note:** Dashboard pages appear to live under `app/src/app/(app)/` not `app/src/app/dashboard/`. The extraction pattern may be misconfigured. Actual pages exist at:
- `/billing`, `/credits`, `/myjobs/new`, `/profile`, `/settings/channels`, `/support`, `/admin/crm`

No orphaned pages or missing nav entries detected from commit diff.

## 6. API-to-UI Mapping

**Frontend calls without backend routes:**

| apiFetch path | Backend route exists? |
|---------------|----------------------|
| `/billing/invoices` | ❌ MISSING |
| `/billing/payment-method` | ❌ MISSING |
| `/billing/setup-intent` | ❌ MISSING |

These calls exist in `app/src/lib/api.ts` but no corresponding handlers in `lib/routes/billing.js`.

**Risk:** Frontend will 404 or error when users access payment method management.

## 7. Codebase Structural Integrity

| Area | Status |
|------|--------|
| Backend routes registered in server.js | ✅ All route files imported |
| Circular dependencies | Not detected in this session |
| Migration files | `018_auto_topup.sql` added; verify it ran in staging/prod |
| New services | `lib/services/credits.js` expanded; `lib/services/billing_cron.js` updated |

## 8. C0 / C1+ Boundary

| Check | Finding |
|-------|---------|
| Hardcoded branding | `brand-switcher.tsx` touched — verify no AuraFlux-specific strings leak to white-label |
| Portal isolation | `lib/portals/portal0.js` modified — confirm portal context passed correctly |
| Logo on connect page | CPD-356 added AuraFlux logo; confirm this respects `portal.branding` |

**Potential leak:** Verify `/social/accounts` and channel connect pages use dynamic branding, not hardcoded assets.

## 9. Environment and Secrets

**Backend vars in code but missing from `.env.example`:**

| Variable | Status |
|----------|--------|
| `AURAFLUX_E` | ❌ Undocumented (partial name?) |
| `C` | ❌ Undocumented (partial extraction) |
| `E` | ❌ Undocumented |
| `GATE` | ❌ Undocumented |
| `GEMINI_GATE` | ❌ Undocumented |
| `PORTAL` | ❌ Undocumented |
| `R` | ❌ Undocumented |
| `YOUTUBE_COOKIES_BASE` | ❌ Undocumented |

**Frontend NEXT_PUBLIC_* vars:** ✅ None missing

**Note:** Extracted var names appear truncated. Re-run env scanner.

## 10. Recommendations

### [BLOCKING]

1. **Fix CI failures on `main`** — 3 workflows failing blocks prod deploys
2. **Add missing billing routes** — `/billing/invoices`, `/billing/payment-method`, `/billing/setup-intent` are called by frontend but don't exist
3. **Verify Jira API credentials** — HTTP 000 indicates connection/auth failure; tickets may be untransitioned

### [SHOULD FIX]

4. **Document missing env vars** — `YOUTUBE_COOKIES_BASE`, `GEMINI_GATE`, etc. need `.env.example` entries
5. **Merge dependabot PR #593** — axios security/patch update sitting idle
6. **Run migration 018** — Confirm `auto_topup` migration applied to staging and production
7. **Resolve `feat/cpd-327-multi-brand` CI** — Feature branch blocked; either fix or close

### [NICE TO HAVE]

8. **Add Confluence HOW docs** — Auto top-up, Kick OAuth, legal pages need operator docs
9. **Fix dashboard page extraction** — Update scanner to find `(app)/` route group pages
10. **Audit brand-switcher for white-label** — Ensure no hardcoded AuraFlux assets

---

<!-- last-reviewed-commit: e4a8db1d09382d033736df50020b4fc272f916c4 -->
<!-- reviewed-at: 2026-05-27T05:41:24Z -->
```