# Aider Task — Pipeline Parity Deep Review

**Run when:** After any sprint touching `lib/routes/jobs_c1.js`, `lib/queue/worker.js`, `lib/routes/developer_api.js`, or `lib/services/pipeline_assembly.js`

**First performed:** 2026-06-01 overnight (produced CPD-485, CPD-487)
**Process:** Feed all dispatch path files to an LLM and compare paths systematically

---

## How to run

### Option A — Cursor agent (recommended, full 3-layer review)

Open a new Cursor chat and paste this prompt:

```
Perform a full 3-layer AuraFlux ecosystem health review.

## Layer 1 — Pipeline parity (internal consistency)

Read these files in full:
- lib/services/pipeline_assembly.js
- lib/routes/jobs_c1.js
- lib/queue/worker.js
- lib/routes/developer_api.js
- lib/portal_policy_runner.js
- lib/job_spec.js

Find gaps between the three dispatch paths (v1 developer_api, dashboard jobs_c1, BullMQ worker):
- Steps present on v1 but missing on dashboard/BullMQ
- Steps present on dashboard/BullMQ but missing on v1
- Extension workers receiving jobSpec correctly on all paths
- Assembly failure handling (does it abort or swallow?)
- Operator retry/advance callback completeness
- portalReports stored during pipeline on all paths

## Layer 2 — Pipeline dependencies (what pipeline needs)

Read:
- lib/ffmpeg_utils.js
- lib/queue/index.js
- lib/queue/worker.js
- lib/services/credits.js

Check:
- All external API credentials referenced in lib/ are present in .env.example
- Redis/BullMQ connection wired correctly
- FFmpeg path resolution works on Linux (Render) and macOS
- Clip sourcing (yt-dlp) available
- Graceful SIGTERM shutdown for in-flight jobs
- Credit deduction called on ALL three dispatch paths before/during pipeline

## Layer 3 — Pipeline consumers (what needs pipeline to be healthy)

Read:
- lib/services/job_grader.js
- lib/services/notifications.js
- lib/portals/portal5.js
- lib/services/token_store.js
- lib/routes/jobs.js
- lib/services/stripe_billing.js
- app/src/app/(app)/myjobs/[jobId]/page.tsx

Check:
- Grader reads portalReports and is called from pipeline completion on all paths
- Customer notifications dispatched on job complete from all paths
- portal5 publish wired + OAuth token refresh for expired platform tokens
- Operator dashboard has access to portalReports, gateResults, outputUrl, operator_review routing
- Job status UI polls for updates and renders outputUrl/video
- Stripe webhook handles subscription events + planTier synced to feature gates

## Output format

Three sections: LAYER 1 FINDINGS, LAYER 2 FINDINGS, LAYER 3 FINDINGS.
Each finding:
- Severity: CRITICAL / HIGH / MEDIUM / LOW
- File + line number
- Description
- Proposed fix

Finish with: OVERALL STATUS (GREEN/AMBER/RED) and top 3 things to fix before next E2E run.
```

### Option B — Static check (fast, less thorough)

```bash
node scripts/pipeline_parity_review.js
# Report: logs/pipeline_parity_review_<date>.md
```

---

## Review scope

| Path | Entry point | Shared module |
|------|-------------|---------------|
| v1 | `lib/routes/developer_api.js` POST /v1/jobs | `lib/services/pipeline_assembly.js` |
| Dashboard/inline | `lib/routes/jobs_c1.js` POST /jobs | `lib/services/pipeline_assembly.js` |
| BullMQ | `lib/queue/worker.js` | `lib/services/pipeline_assembly.js` |

---

## Checklist — what to verify on each path

- [ ] Assembly triggered after correct portal (portal0 for clip-only, portal1 for script jobs)
- [ ] TTS mix + post-TTS chrome called on `onPortalPass('tts_ext')`
- [ ] `ensureChromeApplied` called on `onPortalPass('portal3a')`
- [ ] `runJobComplete` called with grade + persist + notify
- [ ] `clipSpec` forwarded from payload into jobSpec
- [ ] `productionProfile` resolved via `resolveProductionProfileAndContentType`
- [ ] `streamer` wired from request body
- [ ] `format`, `effects`, `captions`, `audioOpts` forwarded from payload
- [ ] Assembly failure aborts portal sequence (does not continue to portal3a with no assembledPath)
- [ ] Credit deduction timing consistent across paths
- [ ] All portal extension workers have `isFeatureEnabled` gate

---

## History of findings

| Date | Commit | Gaps found | Status |
|------|--------|------------|--------|
| 2026-06-01 | 350c8cb | 5 gaps (assembly, clipSpec, profile, portal3b, effects) | Fixed same night |
| 2026-06-01 | a9ca549 | 7 gaps (clip-only assembly, TTS mix, worker complete parity, chrome safety net, streamer, developer_api drift) | Fixed same night |
| 2026-06-02 | — | Run tonight | Pending |

---

## Related

- Jira: CPD-485 — dashboard vs v1 pipeline parity
- Jira: CPD-487 — hard-fail + Sentry alert on missing assembledPath
- Code: `lib/services/pipeline_assembly.js` — shared assembly module
- Code: `scripts/pipeline_parity_review.js` — static 10-point check
- HOW: [Pipeline Parity & Codebase Health Review](https://aurafluxco.atlassian.net/wiki/spaces/CP/pages/24412161)
