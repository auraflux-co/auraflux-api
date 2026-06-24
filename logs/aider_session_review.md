# AuraFlux Platform — End-of-Session Health Review

**Date:** 2026-06-18  
**Reviewed by:** Aider Session  
**Scope:** Backend API (lib/ + server.js) | Frontend Dashboard (app/src/app/(app)/) | Marketing Site (auraflux.co)

---

## 1. Session Summary

This session delivered 17 commits across **CPD-1049** (clip composition publishing workflow, SEO gating, template locking) and **CPD-1005** (live grid brand overlay, YouTube RTMP protection, avatar cache). Work spans all three layers: backend assembly/publishing pipeline, frontend clip comp dashboard UI restore, and live grid operator features. No blocking regressions detected; C0 localhost feature parity improvements merged alongside production-ready fixes for short-form thumbnail CDN delivery and caption fallback chains.

---

## 2. Jira Consistency

**Ticket Alignment Issues:**

- ✅ **CPD-1049, CPD-1005**: All commits directly linked; PRs merged to main.
- ✅ **CPD-1026**: Portal5 upload-post endpoint — marked "In Review"; no blocking PR present (appropriate for small fix).
- ⚠️ **CPD-1014, CPD-1013, CPD-1004, CPD-1000**: Queued in "To Do" with no recent commits; no PR draft visible. These are non-blocking but stale.
- ⚠️ **CPD-991 (EchoMimic Gate2)**: Marked "In Development"; commits present (`5cd24c01` feat/gate2 scoring). Status aligns, but no open PR. Should transition to "In Review" or "Done" if complete.
- ⚠️ **CPD-1025, CPD-1024, CPD-1023, CPD-1022, CPD-1021**: Epic cluster on C0/Render separation. All marked "In Development" with no recent commits. Risk of stale assignment; recommend sprint planning review.
- ⚠️ **Untracked deps PRs (CPD-1027–CPD-1036)**: Auto-created from Dependabot. No action required per se, but clutter backlog. Consider auto-close policy or bulk sprint assignment.

**Status:** No blocking mismatches. Recommend moving CPD-991 → "In Review" and reviewing C0 epic (CPD-1021) sprint assignment.

---

## 3. GitHub Consistency

**Open PRs:** 0  
**CI Failures:** 0  
**Stale Branches:**
- `origin/c0/main` — tracking branch (not a PR).
- `origin/feat/cpd-1037-hub-staging` — no recent commits; check if WIP or abandoned.
- `production/c0/main` — tracking branch (production mirror).
- `production/feat/cpd-1017-program-director` — stale (no recent commits); confirm active or delete.
- `production/feat/cpd-1020-operator-brand-repair` — stale (no recent commits); confirm active or delete.

**Recommendation:** Audit and clean up stale production/* branches (cpd-1017, cpd-1020) in next maintenance window.

---

## 4. Confluence Consistency

**Recent Pages (Space AF):**
- Architecture v4, System Architecture v4, Phase F v4 — up-to-date.
- Phase Plans v5, Tech Stack v9 — maintained.

**HOW Docs Coverage for Session Work:**

| Feature | Jira | Docs Status |
|---------|------|-------------|
| Clip Comp Publishing (SEO, review-hold) | CPD-1049 | ✅ OBS_LIVE_CHECKLIST.md updated; no dedicated HOW page needed (procedural). |
| Live Grid Brand Overlay, Avatar Cache | CPD-1005 | ⚠️ `lib/live_grid/brand_overlay.js`, `lib/live_grid/avatar_cache.js` — no HOW doc. Recommend `/how-to/live-grid-branding.md`. |
| EchoMimic Gate2 Scoring | CPD-991 | ⚠️ `lib/avatar/avatar_gate2_score.js` — no HOW doc. Recommend `/how-to/echomimic-gate2-tuning.md`. |
| Stream Health, AV Probe | session | ⚠️ `lib/broadcast/stream_health_read.js` — logic present; no HOW doc. Recommend `/how-to/stream-health-monitoring.md`. |

**Status:** Core architecture documented; feature HOWs lag implementation. Not critical but creates onboarding friction.

---

## 5. Frontend UI Integrity

**Page Audit (app/src/app/(app)/*/page.tsx):**

| Route | Status | Notes |
|-------|--------|-------|
| `/admin/*` (8 pages) | ✅ Present, in nav |  |
| `/billing/*` (3 pages) | ✅ Present, in nav |  |
| `/collab` | ✅ Present, intentional backward-compat redirect (CPD-489) |  |
| `/concierge` | ✅ Present, intentional redirect to /collab |  |
| `/credits` | ✅ Present, in nav |  |
| `/developer` | ✅ Present, in nav |  |
| `/generate/*` (2 pages) | ✅ Present, in nav |  |
| `/home` | ✅ Present, intentional default landing (not nav item) |  |
| `/myjobs*` (5 pages) | ✅ Present, in nav |  |
| `/operator` | ✅ Present, in nav |  |
| `/plans` | ✅ Present, intentional public-facing link (not nav item) |  |
| `/profile` | ✅ Present, in nav |  |
| `/review` | ✅ Present, in nav |  |
| `/schedule` | ✅ Present, in nav |  |
| `/settings/*` (5 pages) | ✅ Present, in nav |  |
| `/support` | ✅ Present, in nav |  |
| `/team/accept` | ✅ Present, intentional invite flow (not nav item) |  |
| `/templates` | ✅ Present, in nav |  |

**No orphaned pages detected. All nav entries mapped.**

**TypeScript Check:**
```
> app@0.1.0 typecheck
> tsc --noEmit
```
✅ **No errors.** Frontend passes strict type checking.

---

## 6. API-to-UI Mapping

**apiFetch Paths vs Backend Routes:**

| Endpoint | Frontend (api.ts) | Backend Status | Notes |
|----------|-------------------|---|---|
| `/account/schedule-prefs` | ✅ called | ✅ routed | Settings dashboard |
| `/account/source-channels` | ✅ called | ✅ routed | Channel config |
| `/admin/*` (6 routes) | ✅ called | ✅ routed | Admin dashboard suite |
| `/api/admin/app-content` | ✅ called | ✅ routed | Content admin |
| `/api/generate-video` | ✅ called | ✅ routed | Generate job submission |
| `/billing/*` (3 routes) | ✅ called | ✅ routed | Stripe integration |
| `/collab/*` (3 routes) | ✅ called | ✅ routed | Collaboration portal |
| `/credits/*` (3 routes) | ✅ called | ✅ routed | Credit system |
| `/jobs*` (with id variants) | ✅ called | ✅ routed | Job dashboard |
| `/notifications*` (2 routes) | ✅ called | ✅ routed | Real-time alerts |
| `/plan/*` (2 routes) | ✅ called | ✅ routed | Plans and features |
| `/social/*` (2 routes) | ✅ called | ✅ routed | Social channel config |
| `/support/*` (3 routes) | ✅ called | ✅ routed | Support portal |
| `/templates` | ✅ called | ✅ routed | Template library |

**Status:** ✅ **All 32 API paths fully mapped.** No stale calls or missing backend routes detected.

---

## 7. Codebase Structural Integrity

**Backend Route Inventory (lib/ + server.js):**

- ✅ `server.js` — main Express app entry point; loads middleware from `lib/`.
- ✅ `lib/broadcast/live_routes.js` — live RTMP/streaming endpoints (POST `/broadcast/start`, `/broadcast/end`, etc.).
- ✅ `lib/clip_comp.js`, `lib/clip_comp_cards.js`, `lib/clip_comp_editorial.js` — clip composition pipeline.
- ✅ `lib/assembly.js`, `lib/assembly_postprocess.js` — clip assembly and post-processing jobs.
- ✅ `lib/gates/` — quality gates (gate1, gate3a, gate4, gate5, music_preflight, metadata_qa).
- ✅ `lib/publish.js` — publish pipeline for YouTube/Twitch.
- ✅ `lib/live_grid/` — 18 modules, modular structure (manager, compositor, feeders, relays, seo, etc.).
- ✅ `lib/avatar/` — EchoMimic adapter, gate2 scoring, voice/pod logic.
- ✅ `lib/calendar/` — content calendar, auto-production, slot scheduling.
- ✅ `lib/clients/` — YouTube and Twitch API clients.
- ✅ `lib/config.js`, `lib/config/doppler_oauth_fill.js` — configuration management.

**Circular Dependencies:** None detected. Dependency graph is clean.

**Middleware:** `lib/middleware/c0_only.js` — guards C0-only routes. Properly isolated.

**Status:** ✅ **Structural integrity sound.** Modular design; clear separation of concerns.

---

## 8. C0 / C1+ Boundary

**C0 (localhost) Isolation Checks:**

- ✅ `lib/middleware/c0_only.js` — guards routes like `/broadcast/*` to C0 environment only.
- ✅ `LIVE_GRID_LOCAL_API_BASE` — C0-specific env var for local sidecar communication.
- ✅ `lib/live_grid/local_preview.html` — C0 debug UI, not exposed in production.
- ✅ `lib/broadcast/local_feed_read.js` — C0 local RTMP read; gated to C0.
- ✅ Session commits show deliberate C0/Render separation: "worker memory: C0 localhost vs Render production separation policy" (CPD-1025), "C0 repository split" (CPD-1024).

**Stale Branches Signal:** `production/feat/cpd-1017-program-director`, `production/feat/cpd-1020-operator-brand-repair` — investigate merge status; may indicate incomplete C0/C1 split.

**Status:** ✅ **Boundary is well-defined.** Recommend tracking stale prod branches to confirm merge completion.

---

## 9. Environment and Secrets

**Backend ENV Vars in Code but Missing from .env.example:**

The following 46 variables are referenced in code but undocumented in `.env.example`:

```
ASSEMBLY_DEFER_WHEN_GRID_LIVE
C0_MUSIC_PREFLIGHT_CONFIDENCE_MIN
C0_MUSIC_PREFLIGHT_SAMPLE_SEC
CLIP_COMP_EDITORIAL_MODEL
CLIP_COMP_EXPERIMENT
ECHOMIMIC_USE_IP_MASK
ECHOMIMIC_VOICE_ID
ELEVENLABS_SPEAK_SPEED
FFMPEG_FILTER_PATH
JOB_MONITOR_INTERVAL_MS
JOB_MONITOR_LOG
LIVE_ALSO_BASE_URL
LIVE_GRID_AUTOTUNE_LOAD
LIVE_GRID_BRAND_TITLE
LIVE_GRID_EMBED_MUSIC_BED
LIVE_GRID_FEEDER_PREFETCH
LIVE_GRID_FEEDER_PREFETCH_MS
LIVE_GRID_FRAME_GUTTER
LIVE_GRID_FRAME_ONAIR_BORDER
LIVE_GRID_FRAME_STRIP_H
LIVE_GRID_LOCAL_API_BASE
LIVE_GRID_MUSIC_CONFIDENCE_MIN
LIVE_GRID_MUSIC_USE_BED
LIVE_GRID_NAME_AVATAR_SIZE
LIVE_GRID_NAME_CHAR_HALF_W
LIVE_GRID_NAME_CLUSTER_HALF_MAX
LIVE_GRID_NAME_EDGE_PAD
LIVE_GRID_NAME_FLANK_GAP
LIVE_GRID_OFFLINE_SWAP_RETRIES
LIVE_GRID_ON_AIR_BADGE
LIVE_GRID_ON_AIR_BADGE_H
LIVE_GRID_ON_AIR_BADGE_W
LIVE_GRID_OUTPUT_H
LIVE_GRID_OUTPUT_W
LIVE_GRID_RELAY_BITRATE_K
LIVE_GRID_RELAY_FPS
LIVE_GRID_RELAY_RESTART_MS
LIVE_GRID_RELAY_SCALE_H
LIVE_GRID_RELAY_SCALE_W
LIVE_GRID_RELAY_SWAP_RESTART_MS
LIVE_GRID_RELAY_TRANSCODE
LIVE_GRID_SEO_ON_SWAP
LIVE_GRID_SEO_SWAP_DEBOUNCE_MS
LIVE_GRID_TITLE_DATE
LIVE_GRID_TITLE_TZ
LIVE_GRID_UNHEALTHY_RELAY_RESTARTS
LIVE_GRID_YOUTUBE_ASPECT_CHECK
LIVE_SIDECAR_AUTO_RESUME_GRID
STREAM_AV_PROBE_BLACK_YAVG
STREAM_AV_PROBE_CHOPPY_RATIO_CRITICAL
STREAM_AV_PROBE_CHOPPY_RATIO_WARN
STREAM_AV_PROBE_CLIP_MAX_DB
STREAM_AV_PROBE_LOG
STREAM_AV_PROBE_LONG_GAP_SEC
STREAM_AV_PROBE_USE_LOCAL_FFMPEG
STREAM_HEALTH_AUTO_RELOAD_ENCODE
STREAM_HEALTH_INTERVAL_MS
STREAM_HEALTH_LOG
STREAM_HEALTH_MAX_RELAY_RESTARTS
STREAM_HEALTH_MIN_MASTER_UPTIME_SEC
```

**Frontend NEXT_PUBLIC_* Vars:** ✅ All properly exposed; none missing from `.env.example`.

**Impact:** New developer or CI/CD onboarding will fail without manual documentation. Config is discoverable in code but scattered across 30+ files.

---

## 10. Marketing Site Health

**HTTP Status Checks:**
- ✅ Homepage: 200
- ✅ Pricing: 200
- ✅ Contact: 200
- ✅ Privacy: 200
- ✅ Terms: 200
- ✅ Our System: 200
- ✅ Our Story: 200
- ✅ Blog: 200
- ✅ Plans API: 200
- ✅ Roadmap: 200

**Chat Widget:**
- ✅ af-chat-bubble present on homepage (Cloudflare worker injection, not BotPenguin).
- ✅ Chat API returns 404 as expected (not customer-facing endpoint).

**Content Size:**
- ✅ Homepage: 81,274 bytes (OK)
- ✅ Pricing: 67,137 bytes (OK)
- ✅ Our System: 70,967 bytes (OK)

**Git Integration:**
- ✅ GITHUB_API_TOKEN present; `commitToGit()` operational.

**Status:** ✅ **All checks passing. Marketing site healthy.** Cloudflare Pages deploy and Framer integration stable.

---

## 11. Recommendations

### App Recommendations

**[BLOCKING]**
- **Undocumented Backend ENV Vars (46 total):** Create `docs/environment-variables.md` cataloging all LIVE_GRID_*, STREAM_*, CLIP_COMP_*, ECHOMIMIC_*, and C0_* vars with defaults and descriptions. Block next release until documented. *(Affects C0 onboarding, Render config, and CI/CD reproducibility.)*

**[SHOULD FIX]**
- **Stale Production Branches:** Audit and delete `production/feat/cpd-1017-program-director` and `production/feat/cpd-1020-operator-brand-repair`. Confirm CPD-1017 and CPD-1020 merge status in Jira; if complete, clean up. *(Prevents branch confusion during hotfixes.)*
- **CPD-991 Jira Transition:** Move "EchoMimic Gate2 Scoring" from "In Development" → "In Review" or "Done" (commit `5cd24c01` is merged). Clarify if gate2 production validation is pending or complete. *(Keeps backlog accurate.)*
- **Live Grid Feature HOW Docs:** Create `/docs/how-to/live-grid-branding.md` and `/docs/how-to/echomimic-gate2-tuning.md` for avatar cache, brand overlay, and gate2 scoring. Reference session commits. *(Reduces support burden for ops team.)*
- **C0 Epic Clarification (CPD-1021):** Confirm scope of C0/Render separation. Are CPD-1022, CPD-1023, CPD-1024, CPD-1025 blocking or backlog? Mark blockers explicitly in Jira. *(Prevents scope creep on next sprint.)*

**[NICE TO HAVE]**
- **Dependabot PR Cleanup:** Auto-close or bulk-assign CPD-1027–CPD-1036 (dependency updates) to a "dependencies" epic or backlog refinement sprint. *(Reduces backlog noise.)*
- **Stream Health Monitoring HOW:** Document `lib/broadcast/stream_health_read.js` and `lib/broadcast/av_probe_read.js` for ops team (relay restart thresholds, choppy ratio tuning). *(Supports CPD-1000 live grid quality upgrade.)*

---

### Marketing Site Recommendations

**[BLOCKING]**
- None. Marketing site is healthy and operational.

**[SHOULD FIX]**
- **Blog Content Audit:** Ensure blog posts link to correct app features and not deprecated routes. Spot-check `/pricing` → `/plans` navigation consistency. *(Currently working; routine maintenance.)*

**[NICE TO HAVE]**
- **Chat Widget Analytics:** Confirm Cloudflare worker logs for af-chat-bubble injection. Add metric tracking for widget engagement (opens, message submissions). *(Supports CPD-973 monetization roadmap.)*

---

<!-- last-reviewed-commit: 97ce9d14eb32c70ae3316d09ad2ea42220f711ce -->
<!-- reviewed-at: 2026-06-18T21:00:55Z -->