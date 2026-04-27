# Post-Render Migration Task List

**Created:** 2026-04-19  
**Last updated:** 2026-04-27  
**Status:** Pending — execute after Render deploy smoke test passes  
**Owner:** Claude Code (architect) + Sub-Agents A/B/C (implementation)  
**Trigger:** Rob says "Render is live, start post-render tasks"

This document captures everything that was deferred until after Render deploy.
Nothing here blocks the migration itself — these are improvements that only
make sense once the pipeline is running in the cloud.

---

## Priority 1 — Wire Before Customer 1

These must be done before onboarding any paying customer.

### 1.1 New Relic Alert Policy → Webhook/Email on Escalation
**Why deferred:** NR alerts need a production URL to POST to. No production URL until Render is live.  
**What to build:** Alert policy in New Relic that fires when `GateResult.passed=0` appears 3+ times in 1 hour, or `PIPELINE_ESCALATION` label appears in logs. Webhook POSTs to a Render endpoint (`/internal/alert`) which emails Rob and logs to `docs/reports/roo/escalation_{ts}.md`.  
**Files to change:** `server.js` (add `/internal/alert` endpoint), New Relic UI (alert policy config).  
**Owner:** Sub-Agent B  
**Why it matters:** On Render, Roo/Cursor don't run. This is the replacement for Roo's escalation layer in cloud. Without it, gate failures are silent until Rob checks logs manually.

### 1.2 Roo → Production Gate Intelligence Handoff
**Why deferred:** Roo is local dev only. Render needs an in-process equivalent.  
**What to build:** `lib/monitoring.js` already emits `escalate()` and `GateResult` NR events. Add one thing: when `monitoring.js` calls `escalate()`, also write `docs/reports/roo/escalation_{ts}.md` directly (same format as Roo would write). This means Claude Code sees the same escalation file whether running locally (Roo writes it) or on Render (monitoring.js writes it).  
**Files to change:** `lib/monitoring.js` (~10 lines).  
**Owner:** Sub-Agent A  

### 1.3 Set `TZ=UTC` in Render Environment
**Why deferred:** Render env vars set in dashboard, not local.  
**What to do:** In Render dashboard → Environment → add `TZ=UTC`. Ensures all logs, metrics, gate reports, NR events use UTC. Single timezone across all surfaces.  
**Owner:** Rob (dashboard action, 2 minutes)  
**Reference:** `memory/project_render_timezone.md`

### 1.4 Persistent Disk Sizing Confirmation
**Why deferred:** Need real job volume data from production runs.  
**What to do:** After first 10 production runs on Render, check actual disk usage per job. Confirm 50GB allocation is sufficient (`500MB/job × ~100 jobs buffer`). Resize if needed in Render dashboard.  
**Owner:** Rob (dashboard action after 10 jobs)

---

## Priority 2 — First Week on Render

### 2.1 `generateNewscastOverlay()` → `generateChromeOverlay()` Rename
**Why deferred:** 61 references across codebase. Low risk but high surface area — do after Render proves stable.  
**What to build:** Rename `generateNewscastOverlay()` → `generateChromeOverlay()`, `clipzworld_newscast.html` → `chrome_template.html`. Function reads `designSpec.chrome.templateFile` instead of hardcoded CWN path.  
**Files to change:** `lib/assembly.js`, `server.js`, `tools/clipzworld_newscast.html`, all callers.  
**Owner:** Sub-Agent A  
**Reference:** `memory/project_newscast_rename.md`

### 2.2 `designSpec` Decoupling — Remove `contentType` Branches
**Why deferred:** Requires careful audit across all assembly/QA code. Safe to do once pipeline is stable on Render.  
**What to build:** Remove all `if (contentType === 'nba')` branches from assembly and QA. Replace with `jobSpec.designSpec` reads. Items[] in sceneStructure carry chrome card data per item, not per contentType.  
**Owner:** Sub-Agent A  
**Reference:** `memory/project_designspec_decoupling.md`

### 2.3 Server.js Module Split Phase 2+
**Why deferred:** Blocked on Render stability — don't split while debugging deploy issues.  
**What to build:** Continue splitting `server.js` into `lib/routes/`. Phase 1 done (config.js, metrics.js). Phases 2-5 pending: health routes, assembly routes, publish routes, script gen routes.  
**Owner:** Sub-Agent A  
**Reference:** `docs/strategy/ROADMAP.md` line 103

### 2.4 Gate 1 Diagnostic Upgrade
**Why deferred:** Phase 2 — nice-to-have improvement, not a blocker.  
**What to build:** Gate 1 clip diagnostic — when Gate 1 fails due to clip accuracy issues, surface exact clip → claim mismatches with timestamps. Helps Gemini fix directive target the right scenes.  
**Owner:** Sub-Agent A  
**Reference:** `CLINE_HANDOFF_GATE1_CLIP_DIAGNOSTIC_UPGRADE.md`

---

## Priority 3 — Customer 1 Readiness

### 3.1 Gate Documentation Package
**Why deferred:** Write after Customer 0 hits stable pass rates (≥85% Gate 0→5).  
**What to build:** `docs/architecture/gates/gate0.md` through `gate5.md` — logic, scoring, customerConfig vs universal, edge cases, known limitations. This is the Customer 1 reuse package.  
**Owner:** Aider (docs-only task)  
**Reference:** `memory/project_gate_documentation.md`

### 3.2 CWN → AuraFlux Rename (2845 references)
**Why deferred:** Do after pipeline tests pass + Render stable. Risk of breaking references during active development.  
**What to do:** Run rename audit. `CWN`/`ClipzWorld` stays in customer-facing assets (Bobby G, show brand). `cwn_` prefixes in internal files → `auraflux_`.  
**Owner:** Aider (batch rename, overnight task)  
**Reference:** `memory/project_brand_rename.md`

### 3.3 Twelve Labs — Long-to-Short Pipeline
**Why deferred:** Phase 2 after gate system stable on Render.  
**What to build:** Marengo semantic moment extraction from assembled long-form → FFmpeg cuts → shorts with zero new HeyGen/script credits. New `EXTRACT_DIRECT` job type.  
**Owner:** Claude Code (architecture) → Sub-Agent A (implementation)  
**Reference:** `memory/project_twelvelabs_shorts.md`

### 3.4 Runway MCP — Idea-to-Video Pipeline
**Why deferred:** Phase 2. Requires new `COMPACT_GEN` sourceType adapter.  
**What to build:** Customer provides idea → Runway generates clips from text/image → same pipeline downstream (Gate 0 confirms Runway clips, rest unchanged).  
**Owner:** Claude Code (architecture) → Sub-Agent A (implementation)  
**Reference:** `memory/project_runway_mcp.md`

---

## Priority 4 — Platform Ownership (Roadmap Bucket 5)

### 4.1 Direct YouTube/TikTok/Instagram APIs
**Why deferred:** Upload-Post works now. Direct APIs are cost savings + reliability improvement.  
**What to build:** Phase in alongside Upload-Post. YouTube Data API v3, TikTok Content Posting API, Instagram Graph API. Upload-Post stays as fallback.  
**Reference:** `docs/strategy/ROADMAP.md` — Bucket 5

### 4.2 Title/Description Generator Quality Fix
**Why deferred:** Rob currently uses ChatGPT for this — investigate `CLINE_HANDOFF_PUBLISH_SYSTEM_OVERHAUL.md` fix first, then measure quality.  
**Reference:** `memory/feedback_title_desc_generator.md`

---

### 1.5 HeyGen Template API Dynamic Text (Deferred)
**Why deferred:** Template dynamic text injection never solved in April 2026 sessions.  
**What was learned:** `/v2/template/{id}/generate` with `variables` is the correct endpoint. Variable must be `type: voice`. The `properties` object needs `type`, `input_type`, `input_text` fields mirroring the regular voice object. Template script area must have static text present for substitution. Short-form template (`b3da`) still needs the variable configured.  
**What blocks it:** Duration test showed 6.45s (matching our text length) but Bobby G read the static placeholder text not our dynamic text. Variable substitution for speech not fully confirmed.  
**When to revisit:** After stable production runs with avatar path. Contact HeyGen support with the specific variable structure question.  
**Owner:** Claude Code

---

---

## Environment Variables — Complete Render Panel Checklist

Set all of these in **Render Dashboard → Environment** for `auraflux-api` before first deploy. Values marked `sync: false` in `render.yaml` must be filled manually. Non-secret values are already set inline in `render.yaml`.

### Required (pipeline will not start without these)
- [ ] `ANTHROPIC_API_KEY` — Claude script QA
- [ ] `GEMINI_API_KEY` — Gemini script gen + gate analysis
- [ ] `HEYGEN_API_KEY` — avatar rendering (c0 path)
- [ ] `HEYGEN_AVATAR_ID` — landscape 16:9 avatar ID
- [ ] `HEYGEN_AVATAR_SHORT_ID` — portrait 9:16 avatar ID
- [ ] `HEYGEN_VOICE_ID` — voice ID for all avatar renders
- [ ] `HEYGEN_SPEAK_SPEED` — e.g. `0.85` for long-form, `0.95` for shorts
- [ ] `TWITCH_CLIENT_ID` — Twitch GQL clip resolution
- [ ] `TWITCH_TOKEN` — Twitch API auth token
- [ ] `UPLOADPOST_API_KEY` — multi-platform publish
- [ ] `UPLOADPOST_PROFILE` — Upload-Post profile name
- [ ] `NEW_RELIC_LICENSE_KEY` — **40-char license key** (not Ingest key)
- [ ] `DRIVE_FOLDER_ID` — Google Drive folder for video uploads
- [ ] `DRIVE_REFRESH_TOKEN` — OAuth2 refresh token (run `node cwn-auth.js` locally to generate)

### Optional (features degrade gracefully without these)
- [ ] `HEYGEN_AVATAR_SHORT_NBA_ID` — NBA-specific short avatar
- [ ] `HEYGEN_AVATAR_SHORT_NEWS_ID` — News-specific short avatar
- [ ] `HEYGEN_AVATAR_SHORT_TWITCH_ID` — Twitch-specific short avatar
- [ ] `HEYGEN_TEMPLATE_LANDSCAPE` — HeyGen template ID for 16:9
- [ ] `HEYGEN_TEMPLATE_PORTRAIT` — HeyGen template ID for 9:16
- [ ] `HEYGEN_FOLDER_ID_NBA_NFL` — HeyGen folder routing for NBA
- [ ] `HEYGEN_FOLDER_ID_NEWS` — HeyGen folder routing for News
- [ ] `HEYGEN_FOLDER_ID_TWITCH` — HeyGen folder routing for Twitch
- [ ] `CANVA_CLIENT_ID` — thumbnail generation via Canva
- [ ] `CANVA_CLIENT_SECRET` — Canva API secret
- [ ] `TOPAZLABS_API_KEY` — video upscaling (optional)
- [ ] `ATLASSIAN_API_TOKEN` — Jira/Rovo MCP (IDE-side, not server-side)

### Already set inline in render.yaml (verify, do not duplicate)
- `NODE_ENV=production`
- `PORT=10000`
- `TZ=UTC`
- `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium`
- `GATE_TEST_MODE=false`
- `NEW_RELIC_APP_NAME=auraflux-api-prod`
- `C0_MANUAL_SEGMENT_CHECKPOINT=true`

---

## Already Tracked Elsewhere (Do Not Duplicate)

These are in handoffs/ROADMAP and don't need to move here:
- NBA voiceover FFmpeg v2 — `CLINE_HANDOFF_NBA_VOICEOVER_FFMPEG_V2.md`
- Publish system overhaul — `CLINE_HANDOFF_PUBLISH_SYSTEM_OVERHAUL.md`
- Shared chrome skins — `CLINE_HANDOFF_SHARED_CHROME_SKINS.md`
- Short-form dashboard fix — `memory/project_shorts_dashboard_bug.md`
- GitLab vs GitHub — `memory/project_gitlab_revisit.md` (resolve before CI/CD lock)
