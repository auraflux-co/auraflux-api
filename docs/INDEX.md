# CWN Docs Index
**Last updated:** 2026-04-15  
**Migration target:** Confluence (CP space) — this index becomes the CP space map

Root-level files that must stay in root (read by agents at session start):
- `CLAUDE.md` — architecture, rules, gotchas. Read first every session.
- `STATUS.md` — current tasks, active locks, what's working, what's next
- `AGENT_FILE_REGISTRY.md` — file ownership tiers, lock protocol, agent roster
- `README.md` — project overview

---

## docs/handoffs/ — Active & Pending Agent Work
Handoffs written by Claude Code, executed by Cline-A / Cline-B / Cursor / Aider.
All pending work lives here. Archive after the associated commit lands.

| File | Agent | Status | What it does |
|------|-------|--------|-------------|
| `CLINE_HANDOFF_PIPELINE_RESILIENCE.md` | Cline-A | **PENDING — CRITICAL** | Assembly persistence, source clip restore, auto-trigger, Pino logging, gate self-healing |
| `CLINE_HANDOFF_ASSEMBLY_ERROR_LOGGING.md` | Cline-A | **PENDING** | Wire logError() at 4 assembly failure sites → errors.jsonl |
| `CLINE_HANDOFF_FFMPEG_PERFORMANCE.md` | Cline-A | **PENDING** | VideoToolbox on macOS, libx264 ultrafast on Linux — ~5x speedup |
| `CLINE_HANDOFF_HEYGEN_TEMPLATES.md` | Cline-A | **PENDING** | Switch HeyGen to template IDs (long + short) |
| `CLINE_HANDOFF_HEYGEN_720P_DOWNSCALE.md` | Cline-A | **PENDING** | Render at 720p + Lanczos upscale in normalize step |
| `CLINE_HANDOFF_NBA_VOICEOVER_FFMPEG_V2.md` | Cline-A | **PENDING (post-News lock)** | NBA live-narration voiceover over highlights |
| `CLINE_HANDOFF_NBA_NARRATION_WORD_COUNT.md` | Cline-A | **PENDING (post-NBA prompt)** | Word count calibration for NBA narration style |
| `CLINE_HANDOFF_AUTO_PUBLISH_THUMB_AND_COMMENT.md` | Cline-A | **PENDING** | Auto-generate thumbnail + wire to Upload-Post |
| `CLINE_HANDOFF_THUMBNAIL_WIRE.md` | Cline-A | **PENDING** | Wire Canva thumbnail generation into assembly pipeline |
| `CLINE_HANDOFF_PUBLISH_COPY_REWRITE.md` | Cline-A | **PENDING** | Rewrite publish copy generator (Rob using ChatGPT instead) |
| `CLINE_HANDOFF_QA_GATE_HARDENING.md` | Cline-A | **PENDING** | Gate 2/3 scoring hardening |
| `CLINE_HANDOFF_GATE1_CLIP_DIAGNOSTIC_UPGRADE.md` | Cline-A | **PENDING** | Better Gate 1 clip diagnostics |
| `CLINE_HANDOFF_GATE3_POLLER_RACE_FIX.md` | Cline-A | **SHIPPED 2516d47** | Gate 3 / Drive / Upload-Post never ran — poller race condition fix |
| `CLINE_HANDOFF_NEWS_CHROME_FIX.md` | Cline-A | **SHIP NEXT** | AL JAZEERA label fix (applied), dark story cards, seek corruption, thumbnail |
| `CLINE_HANDOFF_SHARED_CHROME_SKINS.md` | Cline-A | **SHIP NEXT** | Universal newscast chrome — per-show CSS skins (Twitch/NBA), TV card removal, white trim fix |
| `CLINE_HANDOFF_SHORTS_SCRIPT_QA_FIX.md` | Cline-A | **PENDING (after chrome skins)** | Short-form Gate 1 fixes — clip/scene count deductions, outro, random clip selection |
| `CLINE_HANDOFF_SMOKE12_FIXES.md` | Cline-A | **SHIPPED 4fa8a9b** | TV card removed, portrait zoom-to-fill, category label, show name indent |
| `CLINE_HANDOFF_WAVE_0_CLEANUP.md` | Cursor | **PENDING** | 16 dead-code / unused import cleanup items |
| `CLINE_HANDOFF_PREFLIGHT_INLINE.md` | Cursor | **SHIPPED 8a9362e** | Replace confirm() popup with inline preflight panel |
| `CLINE_HANDOFF_ROLLBACK_ADVANCE_GAPS.md` | Cline-B | **SHIPPED 96ca354** | scriptJobId persist, dedup lock clear, rollback overshoot, audit trail |
| `CLINE_HANDOFF_JOB_DISMISS.md` | Cline-B | **PENDING** | Job card dismiss clears data/jobs.json not just localStorage |
| `CLINE_HANDOFF_ASSEMBLY_DEDUP_LOCK.md` | Cline-A | **PENDING** | Prevent duplicate assembly runs on same job |
| `CLINE_HANDOFF_STRICT_CLIPS_DEDUP_DROPDOWN.md` | Cline-A | **PENDING** | Deduplicate clips in dropdown |
| `CLINE_HANDOFF_AL_JAZEERA_403_WORKAROUND.md` | Cline-A | **PENDING** | Al Jazeera 403 bypass |
| `CLINE_HANDOFF_NEWS_CLIP_SCRAPING.md` | Cline-A | **PENDING** | News clip scraping improvements |
| `CLINE_HANDOFF_GAP_51_STAGE_DIRECTION_LEAK.md` | Cline-A | **PENDING** | Stage direction leak fix |
| `CLINE_HANDOFF_SSML_BEAT_REPLACEMENT.md` | Cline-A | **PENDING** | Replace [beat] with SSML pauses |
| `CLINE_HANDOFF_AUTO_ADVANCE_HARDENING.md` | Cline-A | **SHIPPED** | Auto-advance pipeline hardening |
| `CLINE_HANDOFF_DIRECTIVE_SIDECAR_REFACTOR.md` | Cline-A | **SHIPPED** | Directive sidecar read/write refactor |
| `CLINE_HANDOFF_RESTORE_AUTO_ADVANCE.md` | Cline-A | **SHIPPED** | Restore auto-advance after sidecar refactor |
| `CLINE_HANDOFF_RETRY_ASSEMBLY_DISABLE.md` | Cline-A | **SHIPPED** | Disable broken retry endpoint (501 stub) |
| `CLINE_HANDOFF_HEYGEN_PAUSE_UNLOCK.md` | Cline-A | **PENDING** | HeyGen pause/unlock for long render queues |
| `CLINE_HANDOFF_TWITCH_12_STREAMER_DROP_VISIBILITY.md` | Cursor | **PENDING** | Twitch 12-streamer drop visibility fix |
| `CLINE_HANDOFF_VECTCUT_LONGFORM_FOUNDATION.md` | Cline-A | **PENDING** | VectCut long-form foundation |
| `CLINE_HANDOFF_NBA_VECTCUT_VOICEOVER.md` | Cline-A | **PENDING** | NBA VectCut voiceover integration |
| `CLINE_HANDOFF_LAYOUT_DIMENSIONS_AND_HANDOFF_CONFIRMATION.md` | Cline-A | **PENDING** | Layout dimension fixes |
| `CLINE_HANDOFF_RESTORE_JOB_FILTER.md` | Cline-B | **PENDING** | Job filter restore on dashboard |
| `CLINE_HANDOFF_POST_SHIP_VERIFICATION_NEWS.md` | Cline-A | **PENDING** | Post-ship QA checklist for News |
| `CLINE_HANDOFF_POST_SHIP_VERIFICATION_NBA.md` | Cline-A | **PENDING** | Post-ship QA checklist for NBA |
| `CLINE_HANDOFF_SMOKE_TEST_BUGS.md` | Cline-A | **PENDING** | General smoke test bug fixes |
| `CLINE_HANDOFF_STORY_CARD_VISIBILITY.md` | Cursor | **PENDING** | Story card text/bg contrast — white text, opaque bg, subtle border |
| `CLINE_HANDOFF_PHONETIC_PRONUNCIATION.md` | Aider | **PENDING** | Bobby G speaks phonetic hints aloud — remove parenthetical hints from all 3 prompts |
| `CLINE_HANDOFF_GATE3_AUTOPUBLISH_FIX.md` | Cline-A | **CRITICAL** | Gate 3 error fallback blocks Gate 6 — every April 15 assembly failed to upload |
| `CLINE_HANDOFF_AJ_CLIP_QUALITY.md` | Cline-A | **PENDING** | Al Jazeera clip quality — constrain encode to libx264 + maxrate 4M |

---

## docs/dispatches/ — Multi-Handoff Dispatch Orders
Dispatch files coordinate multiple handoffs in sequence. Archive after all constituent handoffs ship.

| File | Status | What it coordinates |
|------|--------|-------------------|
| `CLINE_DISPATCH_NBA_VOICEOVER_V2_QUEUED.md` | **QUEUED — post-News lock** | NBA voiceover V2 full dispatch sequence |

---

## docs/architecture/ — How the System Works
Authoritative technical reference. Read before touching any pipeline code.

| File | What it covers |
|------|---------------|
| `GATED_PIPELINE_ARCHITECTURE.md` | **READ THIS FIRST** — the complete 4-gate pipeline spec. Authoritative. |
| `CHROME_DIRECTIVE_ARCHITECTURE.md` | Directive sidecar system — how per-scene chrome overlays work |
| `PLATFORM_ARCHITECTURE.md` | Naming conventions, content type definitions, platform targets |
| `CWN_ENVIRONMENT_MAP.md` | Full environment map — every API, library, tool, service with definitions and diagram |
| `QA_GATES.md` | Gate 1-4 scoring rules, thresholds, pass/fail behavior |
| `ROLLBACK_FORCE_ADVANCE_SPEC.md` | Rollback and force-advance pipeline controls spec |
| `UPLOAD_API_SPEC.md` | Upload-Post API integration spec |
| `HEYGEN_OPTIONS_INVENTORY.md` | Every HeyGen lever available — templates, avatars, voices, quality settings |
| `RAILWAY_MIGRATION_DECISION.md` | Why Railway, architecture decision record |
| `SERVER_SPLIT_PLAN.md` | Plan to split server.js into modules (Phase 2 prep) |
| `FUTURE_4K_MIGRATION_PLAN.md` | Parked — 4K upgrade plan when bandwidth/storage allows |

---

## docs/specs/ — Feature & Design Specs
Forward-looking specs for features in progress or upcoming. Not handoffs — these describe what we're building toward.

| File | What it covers |
|------|---------------|
| `SET_DESIGN_SPEC_NEWS.md` | News set design — authoritative spec for what the overlay should look like |
| `SHARED_NEWSCAST_SET_MIGRATION.md` | Migration plan for shared newscast set across all content types |
| `VISUAL_DESIGN_SPEC.md` | Visual design standards — colors, typography, overlay layout rules |
| `PUBLISH_COPY_SPEC.md` | Title/description/hashtag generation spec per platform |
| `PHASE_2_BUILD_SPEC.md` | **AuraFlux Phase 2** — full 6-week build plan, stack locked, prerequisites |
| `PHASE_2_DESIGN_PACKAGE.md` | AuraFlux design package — UI patterns, component decisions |
| `AURAFLUX_BRAND.md` | AuraFlux brand identity — name, domain, visual direction |
| `AURAFLUX_PRODUCTION_MODEL.md` | AuraFlux production model — how CWN pipeline becomes a multi-tenant product |
| `AURAFLUX_REVERSE_PIPELINE_SPEC.md` | Reverse pipeline spec — customer input → automated output |

---

## docs/strategy/ — Business, Roadmap & Product
Where we're going and why. ICP, pricing, AuraFlux product plan, Phase 2 build spec.

| File | What it covers |
|------|---------------|
| `AUTONOMOUS_PRODUCTION_ROADMAP.md` | Master roadmap — Phase 1 → Phase 2 → Phase 3 milestones and sequencing |
| `ROADMAP.md` | Post-smoke-test work — what ships after all 6 content type/form gates pass |
| `BUSINESS_STRATEGY.md` | ICP, pricing, GTM, outreach, competitive positioning |
| `PHASE_2_BUILD_SPEC.md` | AuraFlux Phase 2 — full 6-week build plan, stack locked, prerequisites |
| `PHASE_2_DESIGN_PACKAGE.md` | AuraFlux design package — UI patterns, component decisions |
| `AURAFLUX_BRAND.md` | AuraFlux brand identity — name, domain, visual direction |
| `AURAFLUX_PRODUCTION_MODEL.md` | How CWN pipeline becomes a multi-tenant product |
| `AURAFLUX_REVERSE_PIPELINE_SPEC.md` | Reverse pipeline spec — customer input → automated output |

---

## docs/ops/ — Operational Runbooks & Standing Procedures
How to run the operation day-to-day. Checklists, agent schedules, commit rules.

| File | What it covers |
|------|---------------|
| `COMMIT_CHECKLIST.md` | **Read before every commit** — STATUS.md update, doc sync, staging rules |
| `OVERNIGHT_TASKS.md` | Aider overnight task schedule — what runs 1-6am, what it touches |
| `POST_PUBLISH_MANUAL_CHECKLIST.md` | 20% of post-publish tasks that can't be automated |
| `POST_PUBLISH_TASKS.md` | Full post-publish task list (discovered during Twitch long-form review) |
| `CREATIVE_VS_OPERATIONS.md` | What needs Rob + Claude creative alignment vs pure automation |
| `CODE_REVIEW.md` | Latest Cline code review report — findings, dead code, cleanup candidates |

---

## docs/archive/ — Historical / Superseded (67 files)
Completed handoffs, old diagnostic docs, dated dispatch orders, superseded specs.
**Do not read these for current state** — they describe how things used to work.
Migrates to Confluence archive space. No action needed until then.

Notable archived items:
- All News smoke test 1-11 fix handoffs (superseded by SMOKE12_FIXES)
- TV card handoffs (TV card removed entirely in 4fa8a9b)
- RETRY_ASSEMBLY handoff (retry disabled, 501 stub shipped)
- All dated dispatch orders (Apr 11, Apr 13)
- Old diagnostic postmortems (ticker, Twitch long-form broken)
- Pre-Cursor Cline-C workflow docs (CLINE_PLAN_TEMPLATE, CLINE_USAGE_GUIDE, etc.)
