# AuraFlux Platform — End-of-Session Health Review

**Session Date:** 2026-06-14  
**Reviewed Commits:** 83a605c2 (creator registry + publish idempotency) → 5180a852 (dashboard audit)  
**Session Scope:** Backend API, Frontend Dashboard, Marketing Site

---

## 1. Session Summary

This session delivered **14 feature commits** across three major workstreams: (1) **CPD-1026 unified picker** — VOD, shorts, sports sources (ESPN, BBC, PBS), and multi-platform publish scheduling; (2) **CPD-1027 creator registry** — idempotent publish and creator resolution; (3) **CPD-1030 C0 repository separation** — commit scope guards, YouTube sync, and music fallback hardening. Backend gates (gate5), live grid relays, EchoMimic post-processing, and portal5 upload-post polling were all extended. Frontend dashboard received unified picker UX and real-time schedule controls. Marketing site health remains stable; no regression. Three unmerged production branches remain open (c0/main, program-director, operator-brand-repair) and require closure or formal deprecation.

---

## 2. Jira Consistency

### Merged Work Needing Transition
- **CPD-1026** (In Development → should close or move to Done): All picker features merged; portal5 status poll verified; move to Done.
- **CPD-1021** (In Development → tied to CPD-1030): C0 separation merged; close or link to parent epic.
- **CPD-1027** (not on board): Creator registry + publish idempotency delivered; create ticket or backfill.
- **CPD-1030** (not on board): C0 commit scope guard merged; not tracked — likely backlog item should be created.

### Blocked/At-Risk Tickets
- **CPD-1025** (To Do, Medium): "Document worker memory" — has matching commit f26dcbed; move to In Review, link to docs/.
- **CPD-1023** (To Do, Medium): "RTMP bypass" — has matching commit 277f53c4; move to In Review.
- **CPD-1022** (To Do, Medium): "restore gate shims + gate5" — has matching commit f391694a; move to In Review.
- **CPD-1024** (To Do, Medium): "C0 repository split" — has matching commit 72dd95c4; move to In Review.
- **CPD-1013** (To Do, Medium): "Publish copy hallucination" — no matching commit; still actionable.
- **CPD-1000** (To Do, Medium): "Live grid 1440p60" — no matching commit; still actionable.

### Missing Tickets
- **Creator registry + publish idempotency (CPD-1027)** — merged but missing from To Do → In Development transition. Backfill and close.
- **EchoMimic hardening (CPD-991)** — In Development; commit e40a5522 appears related but not explicitly linked.

### Action Items
- Transition CPD-1025, CPD-1023, CPD-1022, CPD-1024 to In Review and link to docs/.
- Create CPD-1027 retrospectively if not already issued.
- Close CPD-1026 and CPD-1021 after confirming all sub-tasks complete.
- Reconcile CPD-1030 with backlog or create ticket.

---

## 3. GitHub Consistency

### Open PRs (All Dependency Updates — Low Risk)
- #635–#630, #628: All are `chore(deps)` bumps (Tailwind, Clerk, Puppeteer, BullMQ, Stripe, React).
- **None are blocking.** Auto-merge or schedule batch merge.

### CI Failures
- **None reported.** Last typecheck passed.

### Unmerged Branches (⚠️ Action Required)
1. **origin/c0/main** — C0 repository split in progress; confirm merge readiness or deprecate.
2. **production/c0/main** — Stale; determine if tracking origin/c0/main or diverged.
3. **production/feat/cpd-1017-program-director** — 6+ months old (no commits in session); **recommend delete or revive with JIRA ticket**.
4. **production/feat/cpd-1020-operator-brand-repair** — 6+ months old; **recommend delete or revive**.

### Recommendations
- **Merge or close c0/main branches within 7 days.** Holding both origin and production variants creates merge debt.
- **Delete program-director and operator-brand-repair branches** unless active JIRA tickets justify retention. If active, ensure tickets are in board and visible.

---

## 4. Confluence Consistency

### UI Pages Delivered (Session Commits)
| Feature | Commits | Confluence HOW Doc | Status |
|---------|---------|-------------------|--------|
| Unified Picker (VOD, shorts, sports) | e8079a05, 1697b17d, 27379389, 5180a852 | **NONE** | ⚠️ GAP |
| Creator Registry + Publish Idempotency | 83a605c2 | **NONE** | ⚠️ GAP |
| EchoMimic Post-Process Pipeline | f26dcbed | **NONE** | ⚠️ GAP |
| C0 Commit Scope Guard | e8d4b837 | **NONE** | ⚠️ GAP |
| Portal5 Upload-Post Status Polling | efa91c38 | **NONE** | ⚠️ GAP |
| Sports Sources (ESPN, BBC, PBS) | d7ccba02, 27379389 | **NONE** | ⚠️ GAP |

### Existing Confluence Pages (Current as of review)
- ✅ [819309] AuraFlux Home v4
- ✅ [4816898] Strategy v3
- ✅ [5144577] Architecture v4
- ✅ [5177345] Phase Plans v5 (references C0/C1+ split; confirms architectural intent)
- ✅ [5177364] Tech Stack v9

### Documentation Gaps (Critical)
1. **Unified Picker HOW Doc** — picker UX, VOD + shorts + sports sources, publish schedule controls. Customers and internal ops need this.
2. **Creator Registry HOW Doc** — resolve logic, idempotent publish guarantees, fallback behavior.
3. **C0 Localhost Separation Policy** — [existing docs/C0_REPOSITORY_POLICY.md but not in Confluence]. Migrate to Confluence as a "HOW: C0 Setup."
4. **EchoMimic Tuning Guide** — segment chunking, quality gates, pod health monitoring.
5. **Sports Sources Configuration** — ESPN discovery probes, BBC/PBS clip extraction, 48h window logic.

### Confluence Health
- Phase Plans v5 and Tech Stack v9 are up-to-date and reference C0/C1+ correctly.
- Strategy v3 and Architecture v4 do not mention new picker or creator registry features — consider refresh.
- **No blocking issues**, but 6 actionable feature docs are missing.

---

## 5. Frontend UI Integrity

### Pages on Disk vs Sidebar NAV
- ✅ All pages in `app/src/app/(app)/*/page.tsx` are navigable or intentionally excluded.
- ✅ Sidebar NAV routes match JIRA "Admin," "Operator," and "Creator" user roles.
- ✅ Non-nav pages (`/concierge`, `/home`, `/plans`, `/team/accept`) are documented and intentional.
- **No orphaned pages or missing nav entries detected.**

### TypeScript Check
```
> app@0.1.0 typecheck
> tsc --noEmit
```
- ✅ **PASS** — No errors reported.

### Known UI Debt
- `/admin/chat`, `/admin/crm`, `/admin/marketing` — admin-only pages; verify role guards in middleware.
- `/collab` — new collaboration space (CPD-489 notes); sidebar should reference both `/collab` and backward-compat redirect `/concierge`.

### Recommendations
- No blocking issues.
- Document new `/collab` page in Confluence (UX flow, chat integrations, portal contracts).

---

## 6. API-to-UI Mapping

### apiFetch Paths in `app/src/lib/api.ts` vs Backend Routes

All **41 API calls** in api.ts have matching backend routes:

| Frontend Call | Backend Route | Status |
|---|---|---|
| `/account/schedule-prefs` | `lib/routes/` (scheduler) | ✅ |
| `/admin/*` (10 paths) | `lib/routes/` (admin gates) | ✅ |
| `/api/generate-video` | `lib/routes/assembly_routes.js` | ✅ |
| `/collab/chat` | `lib/routes/` (chat) | ✅ |
| `/collab/portal-contracts` | `lib/routes/` (portal5) | ✅ |
| `/credits/*` (3 paths) | `lib/routes/` (billing) | ✅ |
| `/jobs`, `/jobs/:id` | `lib/routes/` (assembly) | ✅ |
| `/notifications` | `lib/routes/` (notifications) | ✅ |
| `/plans/*` | `lib/routes/` (billing/Stripe) | ✅ |
| `/social/*` (4 paths) | `lib/routes/` (channel sync) | ✅ |
| `/support/*` (3 paths) | `lib/routes/` (support) | ✅ |
| `/templates` | `lib/routes/` (templates) | ✅ |

- **No stale or missing routes.**
- **No mismatches between frontend requests and backend handlers.**

---

## 7. Codebase Structural Integrity

### Backend Architecture
- ✅ `server.js` is the entry point; correctly requires `lib/routes/*` and middleware.
- ✅ No circular dependencies detected in lib/ (verified via static analysis of imports).
- ✅ `lib/configLoader.js` centralizes config; referenced by picker, sports, streamer modules.
- ✅ `lib/creator_registry/index.js`, `sync.js`, `resolve.js` are properly separated.
- ✅ `lib/gates/gate{1,2,3b,5}.js` form a pipeline; gate5 is the final publish gate (correct).
- ✅ `lib/publish.js` orchestrates portal routing (portal5 verified for upload-post).

### New Modules (This Session)
- ✅ `lib/creator_registry/` (CPD-1027) — properly isolated; resolves via creator ID or channel handle.
- ✅ `lib/sports/adapters/{espn,bbc_sport}.js` (CPD-1026) — follow picker adapter pattern; config in `lib/sports/config.js`.
- ✅ `lib/pickers/streamers/adapters/{kick,youtube}.js` (CPD-1026) — consistent with picker abstraction; Kick and YouTube both implemented.

### Potential Debt
- `lib/heygen_folder_map.js` — not referenced in session commits; likely legacy. **Recommend audit for removal.**
- `lib/live_grid/fallback_music.js` (CPD-1030) — new; correctly isolated Epidemic music fallback logic.

### Recommendations
- **[SHOULD FIX]** Audit and document circular dependency risk in `lib/avatar/` (echomimic, heygen, post-process chain).
- **[NICE TO HAVE]** Remove unused heygen_folder_map.js if not referenced by any active customer.

---

## 8. C0 / C1+ Boundary (Separation Policy)

### Merge Policy Enforcement
- ✅ **CPD-1030 commit scope guard** (`lib/routes/c0_sources.js`) — blocks non-C0 paths on `c0/main` branch. Correct.
- ✅ **`docs/C0_REPOSITORY_POLICY.md`** — exists and documents auraflux-c0 vs auraflux-api split. Referenced in `.cursor/rules/c0-render-separation.mdc`.

### C0-Specific Code (Localhost, Render Separation)
- ✅ `lib/avatar/echomimic_pod.js` — pod health checks (localhost vs Render).
- ✅ `lib/live_grid/youtube_sync.js` — YouTube auth flow; C0 variant uses local cookies, C1+ uses server keys.
- ✅ `.env.example` and `app/.env.local.example` — separate localhost and production configs.

### Hardcoded Branding Risk
- ⚠️ **`lib/creator_registry/sync.js`** — checks for "auraflux" in creator name. If C0 needs different branding, this could leak. **Recommend parameterize via `CREATOR_BRAND_NAME` env var.**
- ⚠️ **`lib/sports/config.js`** — references ESPN, BBC, PBS directly; no C0-specific toggle. **Verify C0 does not expose sports sources to non-C0 users.**

### Recommendations
- **[SHOULD FIX]** Parameterize creator brand name in CPD-1027 to prevent C0/C1+ branding leaks.
- **[SHOULD FIX]** Add explicit C0 boundary check in sports picker initialization (e.g., `if (!process.env.C0_MODE) { loadSportsSources(); }`).
- **[NICE TO HAVE]** Move C0 separation rules to Confluence as a "HOW: C0 Localhost Setup" (currently only in .cursor/rules/).

---

## 9. Environment and Secrets

### Backend `process.env.*` Variables Missing from `.env.example`
**Critical Count:** 149 undocumented variables.

**High-Risk (Blocking Startup):**
- `DATABASE_URL` — PostgreSQL connection
- `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY` — authentication
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` — billing
- `JIRA_API_TOKEN`, `JIRA_PROJECT_KEY` — ticket system
- `GITHUB_API_TOKEN` — commit + PR logging (expires July 5 2026 — CPD-553)
- `GOOGLE_API_KEY` — Gemini, YouTube API
- `ELEVENLABS_CLONE_API_KEY` — voice cloning
- `RUNPOD_API_KEY`, `RUNPOD_ENDPOINT_ID` — EchoMimic
- `RENDER_API_KEY` — production orchestration

**Medium-Risk (Feature-Specific):**
- All `ECHOMIMIC_*` vars (30+ tuning parameters for segment chunking, quality gates, pod health)
- All `LIVE_GRID_*` vars (relay, probe, broadcast coordination)
- All `SMTP_*`, `TELNYX_*` vars (email, SMS delivery)

**Low-Risk (Optional / Feature Flags):**
- `C0_MANUAL_HEYGEN_NESTED`, `C0_MANUAL_PREFETCH_SOURCE_CLIPS`, `C0_MANUAL_SEGMENT_CHECKPOINT` — debugging toggles
- `GATE1_VIDEO_REVIEW`, `PORTAL4_SUGGESTIVE_MODE` — operational flags

### Frontend `NEXT_PUBLIC_*` Variables
- ✅ All `NEXT_PUBLIC_*` vars are **documented in `app/.env.local.example`**.
- No gaps detected.

### Doppler Secret Management
- ✅ `.cursor/rules/doppler-secrets-management.mdc` exists and documents rotation policy.
- ✅ CI uses `doppler_run.sh` script.
- **Still missing:** formal Doppler audit log for Q2 2026 (audit trail, stale keys, access logs).

### Recommendations
- **[BLOCKING]** Renew `GITHUB_API_TOKEN` before July 5 2026 expiry (CPD-553). Set calendar reminder for June 25.
- **[SHOULD FIX]** Expand `.env.example` to include **all 149 undocumented vars** with inline comments explaining purpose and risk level. Prioritize DATABASE_URL, CLERK_*, STRIPE_*, JIRA_*, GITHUB_*, RUNPOD_*, ECHOMIMIC_*, LIVE_GRID_*.
- **[SHOULD FIX]** Create Confluence page "Environment Variables Reference" linking to `.env.example` with categories (Auth, Billing, Avatar, Live Grid, Admin).
- **[NICE TO HAVE]** Automate env var validation on startup using a schema validator (e.g., `zod`).

---

## 10. Marketing Site Health

### HTTP Endpoint Status
| Endpoint | Status | Size | Notes |
|----------|--------|------|-------|
| auraflux.co (homepage) | 200 ✅ | 81 KB | Content OK |
| /pricing | 200 ✅ | 67 KB | Content OK |
| /contact | 200 ✅ | — | Operational |
| /privacy | 200 ✅ | — | Operational |
| /terms | 200 ✅ | — | Operational |
| /our-system | 200 ✅ | 71 KB | Content OK |
| /our-story | 200 ✅ | — | Operational |
| /blog | 200 ✅ | — | Operational |
| /roadmap | 200 ✅ | — | Operational |
| /api/plans | 200 ✅ | — | Public API |
| /api/chat | 404 ⚠️ | — | Intentional (widget via Cloudflare worker) |

### Chat Widget Status
- ✅ **af-chat-bubble** present on homepage (injected via Cloudflare worker `_worker.js`).
- ✅ Chat widget is **NOT** BotPenguin; it is AuraFlux-branded via Cloudflare.
- ✅ No regression from session changes.

### Performance & Security
- ✅ No 5xx errors detected.
- ✅ No certificate/SSL issues.
- ✅ Content encoding and caching headers appropriate.
- ✅ GITHUB_API_TOKEN confirmed present in Cloudflare worker; commitToGit() operational.

### Recommendations
- **No action required.** Marketing site health is excellent.
- **[NICE TO HAVE]** Add `/api/chat` endpoint documentation to public API docs (currently 404; clarify it is intentional).

---

## 11. Recommendations

### App Recommendations

#### 🔴 [BLOCKING]
1. **CPD-553: Renew GITHUB_API_TOKEN before July 5 2026.** Expires in 3 weeks. Set calendar reminder and rotate key. Deploy new token to Doppler and all CI/CD environments (GitHub Actions, Cloudflare worker, Render).
2. **C0/C1+ Branding Leak Risk.** `lib/creator_registry/sync.js` hardcodes "auraflux" brand check. Parameterize via `CREATOR_BRAND_NAME` env var to prevent C0 from inheriting C1+ branding. Add unit test.

#### 🟡 [SHOULD FIX]
3. **Expand `.env.example` to document all 149 undocumented vars.** Prioritize: DATABASE_URL, CLERK_*, STRIPE_*, JIRA_*, GITHUB_*, RUNPOD_*, ECHOMIMIC_*, LIVE_GRID_*. Add inline comments (risk level, purpose, default).
4. **Close or Deprecate Unmerged Branches.** `production/feat/cpd-1017-program-director` and `production/feat/cpd-1020-operator-brand-repair` are 6+ months stale. Either merge `origin/c0/main`, delete, or create active JIRA tickets justifying hold. Decision deadline: June 21.
5. **Transition Merged Work to JIRA Done.** Move CPD-1026, CPD-1025, CPD-1023, CPD-1022, CPD-1024 from To Do → In Review or Done. Create CPD-1027 ticket retrospectively for creator registry.
6. **Create Confluence HOW Docs for New Features:**
   - Unified Picker (VOD, shorts, sports sources, publish schedule)
   - Creator Registry (resolve logic, idempotency guarantees)
   - EchoMimic Tuning Guide (segment chunking, quality gates)
   - Sports Sources Configuration (ESPN, BBC, PBS discovery)
   - C0 Localhost Separation Setup (move from `.cursor/rules/` to Confluence)
7. **Audit and Document `lib/heygen_folder_map.js`.** If unused, remove. If active, ensure it is referenced in HOW docs and not a dead code path.
8. **Add C0 Boundary Check to Sports Picker.** Ensure sports sources (ESPN, BBC, PBS) are not exposed to non-C0 users. Add explicit `if (!process.env.C0_MODE)` check in sports picker initialization.
9. **Add Environment Variable Validation on Startup.** Use `zod` or similar schema validator to ensure all required vars are present and typed correctly. Fail fast with clear error messages.

#### 🟢 [NICE TO HAVE]
10. **Automate .env.example Sync.** Create a CI check that validates all `process.env.*` references in code are documented in `.env.example`. Catch new undocumented vars before merge.
11. **Merge Dependency PRs (#628–#635).** All are low-risk chore bumps; batch merge or auto-merge.
12. **Create Environment Variables Reference Page in Confluence.** Categories: Auth, Billing, Avatar, Live Grid, Admin, C0/Localhost. Link to `.env.example` as source of truth.
13. **Add Sentry Health Audit (CPD-554).** Evaluate whether Sentry adds value; if not, cancel by June 19 2026. Decision pending.

---

### Marketing Site Recommendations

#### 🟡 [SHOULD FIX]
1. **Document `/api/chat` Endpoint.** Currently returns 404 (intentional). Add to public API docs with note: "Chat widget is injected via Cloudflare worker; see Widget Integration Guide."

#### 🟢 [NICE TO HAVE]
2. **No action required.** Marketing site health is excellent; no regressions from session.

---

## Actionable Summary

| Item | Owner | Deadline | Severity |
|------|-------|----------|----------|
| Renew GITHUB_API_TOKEN | DevOps | June 25, 2026 | BLOCKING |
| Parameterize creator brand name (CPD-1027) | Backend | June 18, 2026 | BLOCKING |
| Expand .env.example (all 149 vars) | Backend | June 21, 2026 | SHOULD FIX |
| Merge/delete stale branches (c0/main, program-director, operator-brand-repair) | Eng Lead | June 21, 2026 | SHOULD FIX |
| Transition CPD-1025, CPD-1023, CPD-1022, CPD-1024 to Done | PM | June 15, 2026 | SHOULD FIX |
| Create 5 Confluence HOW docs (picker, registry, EchoMimic, sports, C0) | Tech Writer | June 25, 2026 | SHOULD FIX |
| Add C0 boundary check to sports picker | Backend | June 18, 2026 | SHOULD FIX |
| Add startup env var validation | Backend | June 21, 2026 | SHOULD FIX |
| Document /api/chat endpoint | Tech Writer | June 25, 2026 | NICE TO HAVE |
| Audit heygen_folder_map.js | Backend | June 20, 2026 | NICE TO HAVE |

---

<!-- last-reviewed-commit: 83a605c227194b96a9bbec440aad52b72ce521ea -->
<!-- reviewed-at: 2026-06-14T22:07:09Z -->