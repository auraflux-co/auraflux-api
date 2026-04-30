# cursor.md

This file provides guidance to **Cursor** (AI coding agents in the Cursor IDE) and human contributors when working in this repository. It was formerly named `CLAUDE.md`.

> **Terminology:** As of 2026-04-29, **"gate" is replaced by "portal"** in all documentation and discussion. A job passes through **portals**; each portal has a **portal worker** (does the work) and a **QA agent** (marks compliant or non-compliant). Self-healing fires on non-compliant. Code files (`lib/gates/`, `gate*.js`) retain old names until the rename ticket lands — until then "gate" and "portal" are interchangeable in code references only.

## Cursor and product owner

**Cursor** is the day-to-day **architect and implementer** in this repo: it reads job specs and portals, proposes changes, runs tests and offline tooling, wires production behavior, and carries out technical work. **Rob** is the **product owner** — not expected to write code or run the CLI; he owns priorities, acceptance (“this matches what customers ordered”), and feedback on outcomes (pass/fail, creative/overlay bar, launch readiness). Plain product language is enough; Cursor maps it to files, env vars, tests, and scripts.

**Offline checks Cursor can run without a live job** (examples): `npm test -- job_spec_contracts.test.js ai_prompt_replay.test.js`, `npm run prompt-replay:offline`, and optional `AI_MEMORY_TRACE_ENABLED=true` for prompt traces (`lib/ai_memory_trace.js`).

## Session Start

**Read these files at the start of every session, in this order:**

1. `cursor.md` — architecture, rules, gotchas (this file)
2. `STATUS.md` — current tasks, active file locks, what's working, what's next
3. `AGENT_FILE_REGISTRY.md` — file ownership tiers, handoff size rules, multi-agent lock protocol. **Read before touching any file.**
4. **`docs/architecture/GATED_PIPELINE_ARCHITECTURE.md`** — the authoritative spec for the Gated Self-Healing Pipeline. Every agent touching pipeline code must read this.
5. **`docs/architecture/CHANGE_IMPACT_MAP.md`** — **read before any code change**.
6. **`docs/architecture/PIPELINE_CONTRACT_SPEC.md`** — **Job Spec Distribution Rule**: every gate worker, QA agent, and gate manager receives the FULL confirmed job spec. No agent reconstructs or cherry-picks fields. QA agent prompts (Gemini/Claude inside gates) must include sceneStructure, chrome, inputs, commitments, and qaThresholds from the job spec. This is a hard requirement — not optional. Maps every component's blast radius. If you change X, this tells you what else must change in the same commit.

### Full job success vs partial milestones

**Success for a job** (what to call “green” / “passed”) means: **all gates pass**, **creative and overlay meet product spec** (Rob’s creative review; QA may catch what he didn’t), and there is a **usable video** under `output/` (or the agreed handoff path). **Failure** = no usable video that meets that bar.

**Not** full-job success: Gate 0/1 only, `POST /generate-full-script` returning 200, script metrics, or “gates progressing” without a final spec-meeting asset. Those are **milestones** — log them as such; do **not** report them as Phase A green or launch-ready. **`STATUS.md` → Definition of done (full job run)** is authoritative.

**When jobs stay red:** follow **`docs/ops/PIPELINE_FAILURE_PLAYBOOK.md`** (classify layer → RCA → tune vs fix vs documented waiver → do not idle on red).

**Multi-agent rule:** If two sub-agents are running simultaneously, check `STATUS.md → 🔒 Active File Locks` before editing any Tier 1 or Tier 2 file. Declare your lock before your first edit. See `AGENT_FILE_REGISTRY.md` for the full protocol.

**Doc structure (as of 2026-04-16):**

- `docs/INDEX.md` — full index of all docs with descriptions. Read this to find anything.
- `docs/handoffs/` — all active and pending sub-agent task specs (named CLINE*HANDOFF*\* for historical reasons)
- `docs/dispatches/` — multi-handoff dispatch orders
- `docs/architecture/` — system design, pipeline specs, technical reference. **Product + control-plane view:** `docs/architecture/SYSTEM_ARCHITECTURE.md` (end-user entry paths, six content stages, monitoring, launch program)
- `docs/specs/` — feature specs and design specs (forward-looking)
- `docs/strategy/` — business strategy, roadmap, AuraFlux product plan, Phase 2 build spec
- `docs/ops/` — operational runbooks, checklists, commit rules
- `docs/archive/` — completed/superseded docs (historical reference only)

**Currently pending handoffs — check `docs/INDEX.md` for full list. Priority order:**

- `docs/handoffs/CLINE_HANDOFF_ASSEMBLY_ERROR_LOGGING.md` — Cline-A, wire logError() at 4 failure sites
- `docs/handoffs/CLINE_HANDOFF_FFMPEG_PERFORMANCE.md` — Cline-A, VideoToolbox hardware encoder
- `docs/handoffs/CLINE_HANDOFF_WAVE_0_CLEANUP.md` — Cursor, 16 dead-code cleanup items
- `docs/handoffs/CLINE_HANDOFF_PREFLIGHT_INLINE.md` — Cursor, replace confirm() popup
- `docs/handoffs/CLINE_HANDOFF_JOB_DISMISS.md` — Cline-B, job card dismiss fix
- `docs/handoffs/CLINE_HANDOFF_NBA_VOICEOVER_FFMPEG_V2.md` — Cline-A, post-News lock

---

## Operator Handoff (2026-04-22)

End-of-day summary for Rob and next-session agents:

- NBA long-form manual workflow was stabilized after restart handling fixes.
- Segment rebuild now preserves `source_clip` inserts for NBA long-form jobs (fix for "no clips" outcomes after resume/restart).
- Chrome runtime for Puppeteer was installed (`npx puppeteer browsers install chrome`), addressing non-fatal chrome-burn failures that previously dropped overlays/ticker/thumbnail render steps.
- NBA Gemini clip-analysis prompt now requests a timestamped `Timestamp | Narration` timeline table, and NBA script generation now explicitly follows those timeline rows when present.
- Manual HeyGen avatar edits were verified to carry into the NBA output (your update did apply in the latest run).

### Tomorrow: manual upload flow (post-restart)

For `c0` manual jobs, use this sequence:

1. Run job as normal (script + HeyGen request).
2. Wait for stage `awaiting_manual_segments`.
3. Open `tmp/manual_segments/<jobId>/read_me/README.txt` and `manifest.json`.
4. Upload only the required avatar files to `tmp/manual_segments/<jobId>/` using the exact `expectedFilename` values (for example `01_avatar_intro.mp4`, etc., as listed for that job).
5. Keep the folder name exactly as the canonical job id (for example `script_nba_...`), not just a numeric timestamp.
6. Source clips are auto-prefetched into the same manual folder (best effort). Do not manually add source clips unless README/manifest indicates a missing source clip.
7. Start assembly once all required avatar files are present and filenames match exactly.

Quick operator rule: `manifest.json` is source-of-truth for filenames/order; `README.txt` is the human checklist.

## Development Environment Setup

**4 terminals required:**

```bash
# Terminal 1 — Static file server (dashboard at localhost:8765)
cd ~/cwn-production && python3 -m http.server 8765

# Terminal 2 — Node API server (auto-restarts via nodemon, tees to logs/server.log)
cd ~/cwn-production && nodemon server.js 2>&1 | tee -a logs/server.log

# Terminal 3 — VectCut API server (port 9001, for video editing)
cd ~/cwn-production/VectCutAPI && ./venv-capcut/bin/python3 capcut_server.py

# Terminal 4 — Dashboard monitor (optional, for real-time logs)
cd ~/cwn-production && tail -f output/*.log
```

**Dashboard:** http://localhost:8765/cwn_production.html
**API:** http://localhost:3000
**VectCut API:** http://localhost:9001

**Note:** VectCut API is required for NBA/News intro card generation and short-form split-screen assembly

## Agent Model Routing

The principal coding agent (Cursor / Claude Code) owns this routing table. Update here when models change. Full domain split and file ownership in `AGENT_FILE_REGISTRY.md`.

| Agent                          | Model                       | Domain                                                                                                 | When to use                                    |
| ------------------------------ | --------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| **Cursor (principal session)** | Claude Sonnet 4.6           | Architecture, diagnosis, spec writing, roadmap, model routing decisions                                | Default — all interactive work with Rob        |
| **Sub-Agent A**                | Claude Sonnet 4.6 (spawned) | Backend pipeline — `lib/`, `server.js` pipeline functions, gates, FFmpeg, assembly, HeyGen, QA scoring | Spawned for parallel or isolated backend tasks |
| **Sub-Agent B**                | Claude Haiku 4.5 (spawned)  | Backend API/data — `server.js` endpoints, `data/`, `logs/`, job persistence, publish integration       | Spawned for formulaic endpoint additions       |
| **Sub-Agent C**                | Claude Sonnet 4.6 (spawned) | Frontend — `cwn_production.html`, `tools/`, `assets/`, AuraFlux React UI (Phase 2+)                    | Spawned for UI-only work                       |
| **Aider**                      | Configurable (see below)    | Batch edits, migrations, refactors, docs, scripts, cleanup                                             | See Aider routing rules below                  |

**Jira labels:** `sub_agent_a`, `sub_agent_b`, `sub_agent_c` — used in Assignee field on all tickets.

**Sub-Agent B (Haiku) rules — smaller context window:**

- NEVER read `server.js` in full — grep + targeted reads only
- Read only 50 lines around the target function
- One task at a time, no multi-file refactors

### Aider routing rules

Aider is a strong choice for tasks that are **well-scoped, repetitive, or touch many files in a predictable way**. Cursor calls Aider via `scripts/aider_plan.sh` or inline. Use it proactively — don't wait for Rob to ask.

**Use Aider when:**
| Task type | Examples |
|---|---|
| **Mass rename / find-replace across files** | CWN→AuraFlux rename (Block 4 item 11), variable renames, constant renames |
| **Repetitive boilerplate additions** | Adding `logError()` calls to 4 assembly failure sites, adding JSDoc to all gate workers |
| **Large file refactors where context fits** | Splitting `server.js` into modules, extracting endpoints to separate route files |
| **Doc generation / updates** | Updating `docs/INDEX.md`, generating `CHANGELOG.md`, syncing `STATUS.md` tables |
| **Script writing** | One-off migration scripts, backfill scripts, data cleanup CJS scripts |
| **Test file generation** | Writing Jest test skeletons from function signatures |
| **Prettier / formatting pass** | Block 4 item 9 — run Aider with `--cmd "npm run format"` |
| **`.gitignore` / config cleanup** | Block 4 item 10 — audit and fix in one pass |
| **Non-breaking overnight batch work** | Anything safe to run while you sleep |

**Do NOT use Aider when:**

- The task requires reading live server state or pm2 logs (Cursor does that)
- The change touches Gate logic, pipeline flow, or assembly.js in a non-trivial way (too risky for batch)
- Rob needs to approve before the change is made (Cursor shows plan first)
- The file is Tier 1 (`server.js` pipeline functions, `lib/assembly.js`) unless it's a surgical, well-defined edit

**How Cursor invokes Aider:**

```bash
# Standard: give Aider a targeted instruction
aider --message "In lib/error_logger.js, add a logError call at the 4 sites marked TODO_LOGERROR" lib/error_logger.js lib/assembly.js

# Overnight batch mode (safe, no interactive):
bash scripts/aider_plan.sh "task description" file1.js file2.js

# Formatting pass:
aider --message "Run npm run format and fix any Prettier violations" --yes
```

**Aider model config** (`scripts/aider_plan.sh`): defaults to Claude Sonnet. Can switch to GPT-4o for cost on large doc-only passes.

**Phase 3 pipeline model routing** (script gen → Pro, Gate 1 → Opus, etc.): see `AUTONOMOUS_PRODUCTION_ROADMAP.md` section 3.3.

---

## Core Architecture

### AI Design Hierarchy (April 2026 Update)

**CRITICAL:** New two-AI collaborative workflow established:

- **Gemini = Primary Design Owner** — Responsible for ALL visual strategy, placement decisions, pacing, design_brief generation
- **Claude = Implementation Lead** — Executes Gemini's designs via VectCut/FFmpeg, manages all Gemini API calls, NEVER assumes design choices

**Claude's Requirements:**

1. Consult Gemini for ALL visual decisions (hooks, safe zones, coordinates, overlay positions)
2. Pass Gemini's design_metadata directly into VectCutClient or FFmpeg filters
3. Report to Rob only when Gemini has approved design at Gate 3
4. Handle all one-off design tasks by prompting Gemini for strategy, then executing asset generation

**See:** `server.js:5867-5875` for design_metadata schema, `server.js:232-318` for VectCutClient implementation

### Agent Orchestration Policy (Owner-Friendly Workflow)

Use this policy for all implementation work so Rob can lead with ideas and review at checkpoints.

**Roles:**

- **Cursor = General Manager** — plans work, breaks tasks into safe steps, keeps `cursor.md` rules in force. **Rob** approves at human checkpoints (see below).
- **Gemini Flash = Visual Director** — used for visual/frame decisions (thumbnail hooks, layout quality, clickability checks).
- **Aider = Surgical Coder** — used for high-risk refactors or tightly scoped edits in large files.
- **Sub-Agents = Implementation layer** — the principal agent spawns them with a self-contained prompt; they read, edit, and commit. The principal agent reviews the result.

**When to call Aider:**

1. File is large (roughly >2000 lines) and change touches multiple functions/sections.
2. Refactor risk is high (shared utilities, assembly flow, API contract changes).
3. Precise, contained rewrite is needed without broad side effects.

**When NOT to call Aider:**

1. Small single-function edits or obvious bug fixes.
2. Simple config/text updates.
3. Tasks that are mostly planning, explanation, or review.

**Human checkpoints (required):**

1. **Before editing:** Show a short plain-English plan with affected files (use `CLINE_PLAN_TEMPLATE.md`).
2. **Before commit:** Show what changed and why in non-technical language.
3. **If behavior changes:** Ask for explicit approval before finalizing.

**Commit guardrails:**

1. Re-read `cursor.md` and `COMMIT_CHECKLIST.md` before every commit.
2. **HARD REQUIREMENT:** Update `STATUS.md` → `🤖 Last Agent Action` table in every commit that changes code. A pre-commit hook will block commits that skip this. See `COMMIT_CHECKLIST.md` for the full requirement.
3. **HARD REQUIREMENT:** Before staging files, search all `.md` files for references to the files you changed. Update every doc where the work is listed or described. The pre-commit hook will warn (5-second pause) about docs you may have missed. Stale docs = other agents working from wrong assumptions.
4. Commit only files related to the request.
5. Never commit secrets, `.env`, `tmp/`, `output/`, or credential files.
6. Keep commit message focused on intent ("why"), not just file list.

### Multi-Stage Production Pipeline

ClipzWorld News (CWN) is an AI-generated news/reaction show using Claude (script), Gemini (QA), and HeyGen (avatar). The production pipeline has 4 stages with 4 quality gates:

```
Script Gen → Gate 1 (≥90) → HeyGen Render → Gate 2 (≥85) → Assembly → Gate 3 (≥70) → Publish → Gate 4 (job_id)
```

**Key files:**

- `server.js` — Node.js API (6000+ lines, all endpoints)
- `cwn_production.html` — Dashboard UI (all production controls)
- `streamers.json` — Streamer roster with intro card data
- `cwn_style_guides.json` — Gemini-learned style fingerprints per content type
- `IMPLEMENTATION_SPEC.md` — Technical spec for missing features (NBA/News cards, short-form layout)
- `VectCutAPI/` — Python-based video editing API server (port 9001)

### Content Types & Forms

**3 content types:** `twitch` (Twitch clips), `nba` (NBA highlights), `news` (world news)
**2 form types:** `compilation` (long-form 16:9, 5-10min) or `short` (9:16, 45-60sec)

**Avatar IDs:**

- 16:9 compilations: `842f20b75ce242aea397f5030aa018aa` (landscape-native 4K, "ClipzWorld at his studio desk" — Bobby G faces viewer's LEFT)
- 9:16 shorts: `ed57439c9c3d...`

**Voice:** ID `2e598f1a6022448cb6710e5d44665325` ("cw") at 0.85 speed (compilations) or 0.95 speed (shorts)

### Script Generation (`/generate-full-script`)

**CRITICAL ROLE SWAP (as of April 2026):**

1. **Gemini analyzes all clips/games** — watches video with audio when available (Twitch CDN URLs, ESPN highlights), falls back to thumbnail analysis
2. **Gemini writes complete script** — uses `geminiScriptGeneration()` with style guides from `cwn_style_guides.json`
3. **Gate 1 QA (Claude)** — reviews Gemini's script via `claudeScriptQA()`, checks for placeholders, name errors, clip-to-streamer mismatches, scene count accuracy
4. **Returns:** `script`, `orderedClipUrls[]`, `scriptQA` results

**Why the swap:** Claude was generating only 11 scenes instead of 72 for Twitch content. Gemini now generates, Claude reviews.

**Critical implementation details:**

- Global Anthropic client initialized at `server.js:106` (required for Claude QA)
- `claudeScriptQA()` function at `server.js:1522-1728` performs Gate 1 review
- `geminiScriptGeneration()` function at `server.js:1437-1520` generates scripts with style guide integration
- Style guides loaded from `cwn_style_guides.json` per content type
- Expected scene count calculated: Twitch = `1 + (streamers × 7) + 1`, NBA/News = `1 + (items × 4) + 1`
- Gate 1 score ≥90 = auto-proceed to HeyGen, 70-89 = manual review, <70 = hard fail
- QA reports saved with "Scored by: Claude (did not write the script)" notation

**RECENT FIX (April 8, 2026):** Gemini was also generating incorrect scene counts (65 instead of 72). Enhanced both system and user prompts with:

- Explicit mathematical breakdown: "1 INTRO + (10 streamers × 7 scenes) + 1 OUTRO = 72 total"
- Examples showing scene structure per streamer
- Final validation reminder to count `=== HEADER ===` markers before submitting
- Emphasized "DO NOT COMBINE" and "DO NOT SKIP" for each header
- See `server.js:4594-4605` (system prompt) and `server.js:5460-5473` (user prompt)

**CRITICAL FIX (April 9, 2026) — Scene Header Normalization (commit 93aa22f):**
Root cause: Gemini writes `=== JAY CINCO_INTRO ===` (space) in script output despite prompt using `JAY_CINCO` (underscore). Claude's Gate 1 QA regex `[A-Z_0-9]+` doesn't match names with spaces, so those scenes were invisible to the scene counter.

Two-layer fix applied:

1. **Prompt-level** (line 6321): `getDisplayName().toUpperCase().replace(/\s+/g, '_')` — prevents spaces in the prompt template
2. **Output-level post-processing** (lines 6519-6528): After `script = geminiResult.script`, normalize ALL headers in Gemini's output:

```javascript
if (script && typeof script === 'string') {
  script = script.replace(/===\s+([^=]+?)\s+===/g, (match, name) => {
    const normalized = name.trim().replace(/\s+/g, '_');
    return `=== ${normalized} ===`;
  });
}
```

This converts `=== JAY CINCO_INTRO ===` → `=== JAY_CINCO_INTRO ===` and `=== TRAIL BLAZERS_INTRO ===` → `=== TRAIL_BLAZERS_INTRO ===` in the actual script before Gate 1 QA sees it.

**Test results after fix:**

- Test 2 (Twitch/Jay Cinco): 60/100 ❌ HARD FAIL → **85/100 🟡 MANUAL REVIEW** (37/37 scenes ✅)
- Test 4 (NBA/Trail Blazers): 45/100 ❌ HARD FAIL → **85/100 🟡 MANUAL REVIEW** (22/22 scenes ✅)
- Remaining -15 deduction is expected: empty clip arrays = unverifiable clip accuracy (not a structural failure)

### HeyGen Rendering (Frontend-driven)

Dashboard sends each script segment to HeyGen API individually. Frontend polls `/heygen-status/:videoId` until `COMPLETED`, then logs metrics via `/log-heygen-metrics` (new endpoint tracking total segments, avg render time, retries).

**Critical:** HeyGen segments contain `[CLIP PLAYS HERE]` markers — assembly must replace these with actual source clips at correct positions.

### Assembly Pipeline (`/assemble`)

**Inputs:** `{ asmId, segments[], contentType, formType, clipUrls[], title }`

**Process:**

1. **Gate 2 QA** — samples first/middle/last HeyGen segments, checks lip sync, audio, rendering quality
2. **Download segments** — uses cached files when possible, validates file size (≥100KB min)
3. **Intro cards** — Replaced by the newscast chrome sidebar active highlight (2026-04-15). `generateNewscastOverlay()` burns the full broadcast chrome on every avatar segment; the active sidebar card highlights as each story/game/streamer section plays. Legacy `generateIntroCardPNG()` (Twitch circle) and `generateGameStoryCardPNG()` (NBA TV card) are being removed in `CLINE_HANDOFF_SHARED_CHROME_SKINS.md` Parts 2+3.
4. **FFmpeg assembly:**
   - Normalize audio levels
   - Build concat list (avatar segments + source clips in order)
   - Insert intro cards as overlays at start of each streamer section
   - Bake ticker at bottom (cached for 1 hour via Puppeteer screenshot)
   - Apply crossfades between segments
5. **Gate 3 QA** — Gemini watches assembled video, checks pacing, transitions, freeze detection
6. **Auto-upload to Google Drive** — if Gate 3 passes (score ≥70)
7. **Save metrics** — writes `run_metrics_{asmId}.json` with per-stage timing

**Critical file operations:**

- Downloads use `downloadFile()` with SSRF protection (whitelisted domains only)
- Temp files auto-cleaned after 24 hours on server startup
- Assembly requires ~500MB disk overhead per job

### QA Gates (Gemini-powered)

All gates use `gemini-2.5-flash` with structured prompts + point deduction scoring:

| Gate | Stage       | Pass   | Manual | Fail      | Checks                                |
| ---- | ----------- | ------ | ------ | --------- | ------------------------------------- |
| 1    | Script      | ≥90    | 70-89  | <70       | Placeholders, name errors, structure  |
| 2    | HeyGen segs | ≥85    | 65-84  | <65       | Lip sync, audio, rendering artifacts  |
| 3    | Assembly    | ≥70    | 60-69  | <60       | Pacing, transitions, freeze detection |
| 4    | Publish     | job_id | —      | no job_id | Upload-Post confirmation              |

**QA logs saved to:** `output/qa_failures/gate{N}_{outcome}_{timestamp}.txt` (local only, never uploaded)

### Metrics Tracking (NEW)

`StageTimer` class tracks performance for each pipeline stage — now in `lib/metrics.js` (moved from server.js:222 during module split Phase 1):

```javascript
const timer = new StageTimer(jobId, 'Script Generation');
timer.addData('claudeTokens', 5420).addData('gate1Score', 95);
addStageMetrics(jobId, timer.end());
finalizeJobMetrics(jobId); // Saves to run_metrics_{jobId}.json
```

**Import:** `const { StageTimer, jobMetrics, initJobMetrics, addStageMetrics, finalizeJobMetrics } = require('./lib/metrics');`

**Tracked metrics:**

- Script gen: Gemini calls, Claude tokens, Gate 1 score
- HeyGen: segment count, avg render time (via `/log-heygen-metrics` endpoint)
- Assembly: download time, normalize time, FFmpeg encode, Gate 2 score
- Publish: platform count, Upload-Post request_id, success/failure

All jobs produce `output/run_metrics_{jobId}.json` with per-stage wall time + totals.

### RCA — Why ledger (`PipelineWhy`, `why_ledger`, `why:ledger`) (April 2026)

When a job misbehaves, read in this order: **what happened → which failure bucket → which layer to fix.**

1. **What:** gate, score, pass/fail, sendback, auto-action — existing NR `GateResult` / `GateSendback` plus **`PipelineWhy`** (same moment as interventions).
2. **Why class (`failureClass`):** `SPEC_VIOLATION` (script ignored job spec), `QA_INPUT_DEFECT` (gates judged on wrong or thin evidence), `PRODUCTION_DEFECT` (infra/API/pipeline bug), `UNKNOWN`, or `NONE` on clean passes. Defaults come from `inferFailureClass()` in `lib/why_ledger.js`; gate code may pass an explicit override when the cause is known.
3. **How to fix:** do not “tune Gate 1” until the class is right — spec issues → prompts/scaffold/job spec; QA_INPUT → Gate 0 / clip analysis / authorized facts plumbing; PRODUCTION → Chrome, FFmpeg, HeyGen, DB, timeouts, parse errors.

**Sources of truth (all written by `recordWhyLedger()`):**

| Sink      | Location                                                                                             |
| --------- | ---------------------------------------------------------------------------------------------------- |
| SQLite    | `why_ledger` table — `lib/db.js` (`saveWhyLedger`)                                                   |
| New Relic | Custom event **`PipelineWhy`**                                                                       |
| JSONL     | `logs/pipeline_events.jsonl` — lines with `"type":"why:ledger"` (via `lib/pipeline_event_logger.js`) |

**Wiring:** `lib/why_ledger.js`; emitted from `lib/monitoring.js` (gate bus + escalate + kill + restore), `lib/script_gen.js` (Gate 1 pipeline bus + auto-action), `lib/gates/gate1.js` (Claude JSON salvage path), `lib/assembly.js` (bus payload enrichment). Tests: `test/why_ledger.test.js`.

### Job Persistence & Pipeline Controls (April 2026)

The pipeline is now a fully persistent, recoverable state machine. Three closely-related features work together — if you touch any of them, touch the others too.

**1. Persistent job cards (`33a8800`)**

- In-memory `persistedJobs` object loaded from `data/jobs.json` at server startup (`server.js:115-120`)
- `saveJobCard(jobId, card)` writes to memory + disk on every mutation, prunes entries older than 7 days
- `GET /jobs` (`server.js:894-920`) returns the list for dashboard restore
- `data/jobs.json` is **runtime state** — must be gitignored, never committed
- Jobs are persisted starting at Gate 1 pass (`server.js:~6763`) and updated at every subsequent stage

**2. Dashboard auto-restore (`cfe2200`)**

- `restoreJobsFromServer()` in `cwn_production.html` calls `GET /jobs` on page init with a 1.5s delay, silently merges server-side cards not already in localStorage
- `↩ RESTORE JOBS` button in queue header = manual trigger
- Segments restored in `rendering` state so the `🔄 REFRESH IDs` button appears immediately, letting the operator recover any in-flight job after a page reload or server restart
- **Why this matters:** `loadJobs()` previously only read localStorage; a page refresh wiped the queue and orphaned any HeyGen-rendered segments

**3. Rollback + Force-Advance (`eac1073`)**
Pipeline state machine: `script_ready → all_sent → assembled → published`

- `POST /job/:id/rollback` — clears current-stage data, steps back one stage. Per-stage cleanup rules (`published→assembled` keeps `finalUrl`; `assembled→all_sent` resets segment URLs; `all_sent→script_ready` deletes `video_id`s)
- `POST /job/:id/advance` — force-passes the current gate (`gate1_forced`/`gate2_forced`/`gate5_forced`) so the next action button unlocks. **Does NOT fabricate URLs, does NOT skip file downloads** — if real data isn't ready, the next stage still fails loudly
- `detectStage(card)` helper infers stage from card fields for older cards without an explicit `card.stage`
- Dashboard: `↩ ROLLBACK` + `⏭ FORCE ADVANCE` buttons on every job card (`cwn_production.html:2145-2146`), calling `rollbackJob()` / `advanceJob()` with confirm() dialogs
- **Full spec + test checklist:** see `ROLLBACK_FORCE_ADVANCE_SPEC.md`
- **Known gap:** no audit trail yet — neither dashboard log nor `logs/errors.jsonl` record rollback/advance events. Follow-up work.

**Recovery flow after server crash or page reload:**

```
Page loads → restoreJobsFromServer() → GET /jobs → cards rebuilt from data/jobs.json
  → segments in "rendering" state → 🔄 REFRESH IDs → segments "completed"
  → ⚙ ASSEMBLE button appears → continue automated pipeline
If anything is stuck: ⏭ FORCE ADVANCE; if anything is wrong: ↩ ROLLBACK
```

### Source Clip Zoom-to-Fill Crop (`45f8980`)

Twitch clips often have white/black letterbox bars baked into the video itself (streamer's OBS scene is mispositioned). During assembly, source clips are now **zoom-to-fill cropped** rather than scale-to-fit letterboxed — the FFmpeg filter scales to cover the target frame and crops overflow, eliminating the baked-in borders. Trade-off: slight content loss at edges is acceptable; borders on every clip are not.

This is why the "hybrid manual Avatar V web-console upgrade" workflow is no longer needed — Avatar V renders with bordered frames, but the assembly-time crop now handles it automatically, restoring full API-driven automation.

## Publishing Workflow

### Title/Description Generation (`/generate-publish-copy`)

Claude generates:

- Title (60 chars max for YouTube)
- Description (platform-specific formatting)
- Hashtags (TikTok/Instagram)
- Pinned comment (YouTube)

Uses assembled video context + script content.

### Thumbnail Generation (`/generate-thumbnail`)

Auto-fills Canva templates (Option 3: `DAHGB0qZod4` or Option 4: `DAHGB-hGwds`):

- Uploads streamer profile images via Canva MCP
- Inserts hook line text
- Adds date overlay
- Returns design URL for manual export

### Multi-Platform Publish (`/publish`)

Single endpoint publishes to YouTube, TikTok, Instagram via Upload-Post API:

```javascript
{
  driveUrl: "https://drive.google.com/uc?export=download&id=...",
  platforms: ['youtube', 'tiktok', 'instagram'],
  title: "...",
  description: "...",
  contentType: 'long' | 'short',
  scheduledAt: null, // or ISO-8601 for scheduled publish
  metricsJobId: "script_twitch_123" // optional, links to metrics
}
```

Returns `request_id` (async) or `job_id` (scheduled). Frontend polls `/publish/status?request_id=X` for completion.

## Key Patterns & Conventions

### Error Handling

- **Command injection prevention:** Use `execFile()` instead of `exec()` for FFmpeg/FFprobe
- **SSRF protection:** `downloadFile()` validates URLs against trusted domain whitelist
- **File size validation:** Min 100KB, max 2GB for video segments
- **API error handling:** `callClaudeAPI()` wrapper provides detailed error messages for rate limits, auth failures, context length

### Security

- **Helmet middleware** enabled for security headers (CSP disabled for inline scripts, COEP disabled for embedded media)
- **CORS whitelist:** `localhost:8765`, `localhost:3000` (configurable via `ALLOWED_ORIGINS` env var)
- **Environment validation:** Server exits on startup if required API keys missing (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `HEYGEN_API_KEY`)
- **No hardcoded credentials:** All removed from `cwn-auth.js` and server code

### Performance Optimizations

- **Ticker caching:** 1-hour TTL, avoids Puppeteer re-render every job
- **Gemini upload retry:** 3 attempts with exponential backoff (2s, 4s, 8s)
- **Twitch token validation:** HEAD request before using stored CDN URLs (they expire ~1 hour)
- **Early download for high-expiry streamers:** Maya/Emily clips cached immediately after script gen (CDN tokens expire quickly)
- **Disk space pre-flight checks:** Validates free space before assembly (est. 20MB/segment + 500MB overhead)

### API Key Management

**Required in `.env`:**

```
ANTHROPIC_API_KEY=         # Claude Sonnet 4
GEMINI_API_KEY=            # Gemini 2.5 Flash
HEYGEN_API_KEY=            # Avatar rendering
HEYGEN_AVATAR_ID=          # Landscape avatar (16:9 compilations)
HEYGEN_AVATAR_SHORT_ID=    # Portrait avatar (9:16 shorts)
HEYGEN_VOICE_ID=           # Voice ID ("cw")
HEYGEN_SPEAK_SPEED=        # 0.85 for compilations, 0.95 for shorts
TWITCH_CLIENT_ID=          # Clip resolution
TWITCH_TOKEN=              # GQL API (formerly TWITCH_CLIENT_TOKEN)
DRIVE_FOLDER_ID=           # Google Drive folder for uploads
DRIVE_REFRESH_TOKEN=       # Run cwn-auth.js once to generate
UPLOADPOST_API_KEY=        # Multi-platform publish
UPLOADPOST_PROFILE=        # Upload-Post profile name
TOPAZLABS_API_KEY=         # Topaz Labs upscaling (optional)
CANVA_CLIENT_ID=           # Canva Connect API
CANVA_CLIENT_SECRET=       # Canva Connect API
VECTCUT_API_URL=           # VectCut API endpoint (http://localhost:9001)
SHORT_FORM_LOGO_SIZE=      # Logo size for short-form videos (80px)
SHORT_FORM_AUDIO_MIX=      # Audio mixing mode (both, source_only, avatar_only)
```

**First-time Google Drive setup:**

```bash
node cwn-auth.js  # Opens browser, saves DRIVE_REFRESH_TOKEN to .env
```

## Common Operations

### Manual Cleanup

```bash
# Keep 2 most recent MP4s, clean tmp/, preserve QA logs
curl -X POST http://localhost:3000/cleanup \
  -H "Content-Type: application/json" \
  -d '{"keepCount":2,"cleanTmp":true,"cleanQaLogs":false}'
```

### Test Intro Card Rendering

```bash
curl -X POST http://localhost:3000/burn-streamer-intro \
  -H "Content-Type: application/json" \
  -d '{"streamer":"jasontheween"}'
# Returns PNG path in output/
```

### Check Disk Usage

```bash
curl http://localhost:3000/disk-usage
# Returns: { totalGB, usedGB, freeGB, outputDirGB, tmpDirGB }
```

### Verify CapCut MCP Health

```bash
curl http://localhost:3000/capcut/health
# Returns: { ok: true, capcut: 'online' } or 503 if offline
```

## Streamer Display Names

**Critical:** Bobby G ALWAYS uses display names (never Twitch usernames) in spoken text:

```javascript
const STREAMER_DISPLAY_NAMES = {
  jasontheween: 'Jason',
  hasanabi: 'Hasan',
  stableronaldo: 'Ron', // NOT "StableRonaldo"
  yonnajay: 'Yonna', // NOT "YonnaJay"
  jaycinco: 'Jay Cinco', // NOT "Jaycinco"
  // ... (see server.js line 431-465)
};
```

Use `getDisplayName(twitchUsername)` helper — it handles case-insensitive lookup and phonetic overrides (e.g., "Yawn-uh" for Yonna).

## Bobby G Script Voice Rules

Scripts follow **Jon Stewart + Norm MacDonald + Space Ghost** blend:

1. **Flat delivery** — never say "incredible", "amazing", "crazy", "wild"
2. **[beat] pauses** — used liberally for timing AND as HeyGen segment boundaries
3. **Short sentences** — state fact, observation, done
4. **Never explain the joke** — clip speaks for itself
5. **Non-sequitur cold opens allowed** — Space Ghost influence for chaotic tone
6. **Always end:** "I'm Bobby G. See you tomorrow." (compilations) or "Subscribe. Appreciate you." (shorts)

**Gate 1 will fail if:**

- Script contains placeholder brackets like `[YOUR OBSERVATION HERE]`
- Wrong name used (Twitch username instead of display name)
- Missing required sections (cold open, outro)
- Too short (< target word count for content type)

## Configuration Constants

**Magic numbers extracted to CONFIG object** — now in `lib/config.js` (moved from server.js:137-177 during module split Phase 1):

```javascript
CONFIG.INTRO_CARD.CIRCLE_RADIUS = 160; // Intro card circle size
CONFIG.TRANSITIONS.DISSOLVE_DURATION = 0.7;
CONFIG.GEMINI.MAX_FILE_SIZE = 34 * 1024 * 1024; // 34MB upload limit
CONFIG.VIDEO.MIN_SEGMENT_SIZE = 100000; // 100KB minimum valid video
CONFIG.TICKER.CACHE_TTL_MS = 3600000; // 1 hour
```

**Import:** `const { CONFIG } = require('./lib/config');`

Change these instead of hardcoding values throughout codebase.

## Testing & Deployment

**No formal test suite.** Production testing done via dashboard + manual QA review. Each stage validates via Gemini gates.

**Deploy:**

```bash
git add -A
git commit -m "your message"
git push
# nodemon auto-restarts server.js — no manual step
```

**Server runs on macOS** (Darwin). FFmpeg paths auto-detect Windows vs Unix. Cross-platform compatibility maintained for future Railway/cloud deployment.

## Known Gotchas

1. **HeyGen segment order matters** — `orderedClipUrls[]` from script gen must match segment insertion points exactly
2. **Twitch CDN URLs expire ~1 hour** — always re-resolve with `resolveTwitchClipMp4()` at assembly time, not script time
3. **Maya/Emily clips expire fastest** — use early download cache (`tmp/early_clips/`) to survive long HeyGen render times
4. **Gate 2 samples only 3 segments** — first, middle, last. Fast streamers get auto-pass even if some segments have minor issues
5. **Ticker baked into video** — not a live overlay. Cached for 1 hour to avoid Puppeteer re-render overhead
6. **Universal newscast chrome — one template, three CSS skins** — `tools/clipzworld_newscast.html` is the single chrome template for all 3 content types. TV cards removed from all sets (2026-04-15). The sidebar's active card highlight IS the intro card — no separate TV card or circle overlay. Per-show differences injected at render time via `contentType` param in `generateNewscastOverlay()`: show name (`.top-brand`), sidebar item labels, and `--gold`/`--gold2`/`--red` CSS vars. News = default (no override). Twitch = purple `#6441A5`. NBA = blue `#17408B`. **Code status:** Part 1 (CSS injection + `contentType` param) shipped. Parts 2+3 (NBA/Twitch chrome migration, removing `generateGameStoryCardPNG()` and `generateIntroCardPNG()`) pending in `CLINE_HANDOFF_SHARED_CHROME_SKINS.md`.
7. **`[CLIP PLAYS HERE]` is structural marker** — never spoken by avatar, replaced by source clip video during assembly
8. **Assembly timeout: 30 minutes** — jobs abort if FFmpeg hangs (network issues, corrupted segment)
9. **Logo overlay now on ALL long-form videos** — 120px CWN logo, **top-LEFT at `20:20`**, 85% opacity. See `lib/config.js` LOGO_POS and `server.js` overlay burns.
10. **Short-form videos need 80px logo** — smaller size for 9:16 format, top-right at `W-w-15:15`

## File Locations

```
output/                  ← Final MP4s (500MB each), thumbnails, metrics JSON
output/qa_failures/      ← Gate failure logs (never uploaded to Drive)
tmp/                     ← HeyGen segments, intro cards, Gate 2 samples (auto-cleaned >24h)
tmp/early_clips/         ← Pre-downloaded Maya/Emily clips (survives HeyGen delay)
cwn_style_guides.json    ← Gemini-learned style per content type (POST /analyze-style-library)
streamers.json           ← Roster + intro card data (origin, fact, profile image URL)
```

**Never commit:** `.env`, `output/`, `tmp/`, `cwn-drive-key.json`

## Important Implementation Details

### Twitch Clip Resolution (GQL vs Thumbnail-derived URLs)

Two methods for getting MP4 URLs:

1. **GQL API** (`resolveTwitchClipMp4()`) — fetches signed CDN URL with `?sig=...&token=...` query params. Expires ~1 hour. Requires Twitch Client ID + Token. Preferred for assembly (high quality).
2. **Thumbnail-derived** (`twitchThumbToMp4()`) — converts `preview-480x272.jpg` → `.mp4`. Lower quality, no auth required. Fallback for Gemini analysis if GQL fails.

**Pattern:** Resolve both at script gen time (720p for Gemini, 1080p for assembly), cache early for high-expiry streamers, re-resolve at assembly time to get fresh tokens.

### FFmpeg Concat Protocol

Assembly uses `concat` demuxer (not filter):

```javascript
// concat.txt format:
file '/absolute/path/segment1.mp4'
file '/absolute/path/segment2.mp4'

// FFmpeg command:
ffmpeg -f concat -safe 0 -i concat.txt -c copy output.mp4
```

**Must re-encode (not copy)** when mixing HeyGen segments + source clips — they have different codecs. Use `-c:v libx264 -c:a aac`.

### Node Canvas Intro Cards

Rendered server-side with `node-canvas` (requires native Cairo deps):

```javascript
const canvas = createCanvas(720, 840);
const ctx = canvas.getContext('2d');

// 1. Draw profile image clipped to circle
ctx.beginPath();
ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
ctx.clip();
ctx.drawImage(profileImg, ...);

// 2. Draw gold ring border
ctx.strokeStyle = '#c7af4f';
ctx.lineWidth = 6;
ctx.stroke();

// 3. Draw text lines (name, origin, fact)
ctx.font = 'bold 68px Arial';
ctx.fillText(streamer.displayName, x, y);
```

Saved as PNG, overlayed via FFmpeg at `x=1460 y=40` for 3.5 seconds at start of each streamer segment.

### Gate QA Prompts

All gates use point-deduction scoring:

```
Start: 100 points
-5 for minor issue (e.g., slightly fast pacing)
-10 for moderate issue (e.g., wrong name used once)
-25 for major issue (e.g., missing audio in segment)
-100 (auto-fail) for critical failure (e.g., placeholder brackets in script)
```

Gemini returns JSON-like output parsed by regex. If parsing fails, gate auto-passes with warning (defensive design).

## Cost & Performance Targets

**Current production volume:** 60 long-form + 180 shorts/month

**Per-job costs:**

- HeyGen: ~$0.038/segment × avg 42 segments = ~$1.60/long-form
- Claude script gen: ~$0.05 (5000 tokens avg)
- Gemini QA (3 gates): ~$0.02 total
- Upload-Post: $50/mo flat (unlimited uploads)

**Total monthly:** ~$381 at full production

**Performance targets:**

- Script gen: <60s (Gemini parallel analysis)
- HeyGen render: ~6min total (42 segments × 8.5s avg render time)
- Assembly: <5min (FFmpeg concat + normalize + ticker bake)
- Total pipeline: <12min end-to-end (excluding HeyGen wait time)

Metrics now tracked per job via `run_metrics_{jobId}.json` — use this to identify bottlenecks.

## Pending Features (In Development)

See `IMPLEMENTATION_SPEC.md` for full technical specifications.

### 1. NBA Long-Form Intro Cards

**Status:** Specification complete, implementation pending
**What:** Resize `nba_thumbnail_generator.html` output to 640×360 TV-shaped overlay
**When:** Display at each `GAME#_[TEAMS]_INTRO` scene
**Position:** Right of Bobby G avatar at `overlay=W-640-40:H/2-180`
**Requires:** VectCut API running on port 9001

### 2. News Long-Form Intro Cards

**Status:** Specification complete, implementation pending
**What:** Scrape Open Graph images from article URLs, resize to 640×360
**When:** Display at each `STORY#_INTRO` scene
**Position:** Same as NBA cards (TV shape, right of avatar)
**Dependencies:** `axios`, `cheerio` (already in package.json)

### 3. Short-Form Split-Screen Layout

**Status:** Specification complete, implementation pending
**Format:** 1080×1920 portrait (9:16)
**Layout:**

- Top 50%: Bobby G avatar (1080×960, from HeyGen) — reaction visible on scroll
- Bottom 50%: Source clip (1080×960, cropped/scaled)
  **Content Flow:** Intro → Bobby G reacts (top) while clip plays (bottom)
  **Logo:** 80px CWN logo at `W-w-15:15` (smaller for vertical format)
  **Audio:** TBD - either mix both tracks or use source-only

### 4. VectCut API Integration

**Status:** Server running on port 9001, endpoints not yet implemented
**Location:** `/Users/robertgregory/cwn-production/VectCutAPI`
**Capabilities:** PiP, multi-track editing, video keyframes, overlay positioning
**Use Cases:** NBA/News card positioning, short-form split-screen assembly

### Implementation Priority

1. Start VectCut API server (port 9001) ✅
2. Add environment variables to .env
3. Create NBA card endpoint
4. Create News scraper endpoint
5. Implement short-form split-screen assembly
6. Run production test suite (`test_3_longform_production.js`)

## Monitoring Stack

**Roo Code is fully removed.** The pipeline event logger (`lib/pipeline_event_logger.js`, formerly `roo_bridge.js`) still runs and writes useful JSONL logs. The `.roo/` directory and all Roo scripts have been deleted.

### What New Relic already covers (no change needed)

| What                   | NR Event / Metric                         |
| ---------------------- | ----------------------------------------- |
| Gate pass/fail/score   | `GateResult` custom event                 |
| Job confirmed + spec   | `JobConfirmed`                            |
| Assembly start/finish  | `AssemblyRunStart`, `PipelineRunTerminal` |
| Gate sendbacks         | `GateSendback`                            |
| Failure classification | `PipelineWhy`                             |
| Publish success/fail   | `VideoPublished`                          |
| API latency + errors   | APM default                               |
| PM2 process health     | NR infra agent (if installed on Render)   |

NR dashboards + alert policies cover all observability. **Do not replace New Relic.**

### What replaced Roo's "intelligence layer"

| Roo role                  | Replacement                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| Gate owner autonomous fix | **Cursor at session start** reads `logs/pipeline_events.jsonl` + NR + pm2 logs, proposes fixes |
| Hourly reports            | **Dropped.** NR dashboards serve this.                                                         |
| Escalation protocol       | **Cursor escalates directly to Rob in chat**                                                   |
| Cross-gate correlation    | **Cursor reads SQLite at session start** — same data                                           |
| Pipeline orchestrator     | **Cursor + STATUS.md** — already the actual workflow                                           |

### What `pipeline_event_logger.js` writes

- `logs/pipeline_events.jsonl` — append-only event log, all bus events
- `logs/pipeline_status.json` — live active job snapshot
- `logs/pipeline_trigger.json` — latest job-started trigger for integrations

**Cursor reads these at session start** to understand what happened overnight without querying NR.

### Session-start monitoring protocol

Every Cursor session starts with:

```bash
# 1. Check what happened since last session
pm2 logs auraflux --lines 100 --nostream | grep -E "Gate 3a|hard fail|Assembly complete|assembled"

# 2. Check active job snapshot
cat logs/pipeline_status.json

# 3. Check overnight event log
tail -50 logs/pipeline_events.jsonl | node -e "
  const lines = require('fs').readFileSync('/dev/stdin','utf8').trim().split('\n');
  lines.forEach(l => { try { const e=JSON.parse(l); if(e.type.includes('fail')||e.type.includes('kill')) console.log(e.ts, e.type, e.jobId); } catch{} });
"

# 4. Check NR for any overnight patterns (manual — open NR dashboard)
```

### Alert replacement (Block 3 task)

When on Render.com, set up:

1. **New Relic alert policy** → `GateResult` where `outcome = 'hard_fail'` → email/Slack notification
2. **PM2 + healthcheck** → Render has built-in health checks + email on crash
3. **No separate monitoring process needed** — NR + Render handles it natively

---

## Session Handoff — 2026-04-24 (Rob + Cursor, end of night)

### Tonight's pipeline fixes (all shipped, server running)

All changes are in `lib/assembly.js`, `lib/manual_segment_workflow.js`, `lib/thumbnail.js`, `server.js`, `cwn_production.html`. Key fixes:

| Fix                                        | File                             | What it does                                                                                                                                            |
| ------------------------------------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ordinal-first folder names                 | `lib/manual_segment_workflow.js` | `00_nba_INTRO_…` folders now recognized as HeyGen exports (was returning null, skipping all avatars)                                                    |
| Gate 2 bypass for c0 manual                | `lib/assembly.js`                | c0 manual hold jobs skip Gate 2 + write synthetic `gate2: pass` to spec so Gate 3a preflight passes                                                     |
| assembledPath written to spec              | `lib/assembly.js`                | Before Gate 3a runs, `assembledPath` + `outputPath` are saved to the job spec — fixes "canProduce: no assembledPath" 0/100 hard fail                    |
| Drive non-blocking                         | `lib/assembly.js`                | Drive quota failure sets `localUrl = /download/{file}` fallback; Gate 4/5 + job card continue                                                           |
| finalUrl uses local fallback               | `server.js`                      | `asmJob.localUrl` used when `asmJob.driveUrl` is null — `stage: assembled` persists                                                                     |
| Startup-resume skips assembled             | `server.js`                      | Jobs at `assembled`/`published`/`gate5_forced` are never re-emitted on server restart (was causing oscillation)                                         |
| Puppeteer Chrome path                      | `server.js`, `lib/thumbnail.js`  | Both now walk `~/.cache/puppeteer/chrome/<ver>/` before system Chrome; `PUPPETEER_EXECUTABLE_PATH` pinned in `.env`                                     |
| News orientation metadata                  | `cwn_production.html`            | `fetchCwnNewsVideos` adapter now forwards `orientation`, `sourceOrientation`, `pillarboxFilter` — was dropping them, causing Gate 0 NEWS_CLIP_GATE_FAIL |
| `manual-segments/resume` accepts assembled | `server.js`                      | Resume endpoint now rolls back `assembled`/`gate5_forced` jobs inline without needing a separate `/rollback` call first                                 |

### 3 jobs mid-run when we stopped (check in morning)

```
script_nba_1777070825982  — NBA Friday Apr 24, Knicks/Cavaliers/Nuggets — 14 avatar + 3 clip
script_nba_1776894535846  — NBA Wednesday Apr 22, 76ers/Blazers/Rockets — 14 avatar + 3 clip
script_news_1776873014386 — News Wednesday Apr 22, 1 story — 6 avatar + 1 clip
```

These were assembling when we signed off. Check `pm2 logs auraflux --lines 100 --nostream` for completion. If `Gate 3a` passed, dashboard should show Approve button. If Gate 3a still fails, check `[GATE3A_NOT_READY]` lines — the `assembledPath` fix should have resolved it.

**To re-queue any failed job:**

```bash
curl -X POST http://127.0.0.1:3000/job/<jobId>/manual-segments/resume -H "Content-Type: application/json"
```

### Gate 2 architecture decision (permanent)

**Gate 2 is now c0-bypassed.** The bypass is conditional on `shouldUseManualCheckpoint()` — only fires when `jobSpecId.startsWith('c0_')`. Future customers (C1+) uploading their own renders will still run Gate 2 fully. This is the correct separation:

- **c0**: fetch → scaffold → HeyGen → operator reviews → assembly. Gate 2 = redundant.
- **C1+**: upload/link/idea → AI generates → Gate 2 checks render quality. Gate 2 = critical.

---

## Launch Roadmap (Rob + Cursor agreed 2026-04-24, updated 2026-04-25)

### AuraFlux C1+ Architecture — Independent Services, One Job Spec

**Agreed 2026-04-25. This is the definitive C1+ architecture.**

**The core principle:** Stages are not a pipeline. They are **independent services** that each:

- Read what they need directly from the **Job Spec**
- Do their work independently
- Write their output back to the **Job Spec**
- Are called by the orchestrator **only when the Job Spec says they're needed**
- Have **zero dependency on each other** — they don't call each other, don't read each other's outputs

```
                        ┌──────────────────────┐
                        │      JOB SPEC         │
                        │  (single source of   │
                        │    truth, Postgres)  │
                        └──────────┬───────────┘
                                   │  read/write
          ┌────────────┬───────────┼───────────┬────────────┐
          ↓            ↓           ↓           ↓            ↓
       FETCH       SCAFFOLD     ASSEMBLY   PREFLIGHT     UPLOAD
   (independent) (independent) (independent) (independent) (independent)
```

The **orchestrator** (lightweight job runner on Render) watches the Job Spec and calls the right service at the right time. No service knows or cares what other services exist.

---

#### The Job Spec — single document, all stages write to it

Every service reads from and writes to one place. Nothing is passed between services directly.

```json
{
  "jobId": "job_...",
  "customerId": "c1",
  "status": "in_progress",

  "order": {
    "inputMode": "url_scrape | ui_upload | customer_storage | ai_generate",
    "outputFormats": ["16:9", "9:16"],
    "designSpec": { "skin": "sports", "chrome": {}, "captions": true }
  },

  "fetch": {
    "status": "complete",
    "assets": [{ "url": "r2://...", "durationSec": 90, "analysis": { "timestamps": [] } }]
  },

  "scaffold": {
    "status": "skipped",
    "scenes": null
  },

  "assembly": {
    "status": "complete",
    "outputs": [
      { "format": "16:9", "url": "r2://output/...", "durationSec": 420 },
      { "format": "9:16", "url": "r2://shorts/...", "durationSec": 58 }
    ],
    "thumbnailUrl": "r2://thumbs/..."
  },

  "preflight": {
    "status": "complete",
    "packages": [
      {
        "videoUrl": "r2://output/...",
        "platforms": ["youtube", "tiktok"],
        "youtube": {
          "title": "...",
          "description": "...",
          "tags": [],
          "pinnedComment": "...",
          "privacyStatus": "private",
          "scheduledAt": null
        },
        "tiktok": { "caption": "...", "hashtags": [] }
      }
    ]
  },

  "upload": {
    "status": "pending_review",
    "results": [],
    "publishedAt": null
  }
}
```

---

#### What each service does

**FETCH** — called when `order.inputMode` is set, `fetch.status = null`

- Scrapes URL / handles upload / pulls from customer storage / triggers RunPod AI
- Runs Gemini analysis on raw assets (timestamps, highlights, crop regions)
- Writes `fetch.assets` + `fetch.status = complete` to Job Spec
- Has no knowledge of scaffold, assembly, preflight, or upload

**SCAFFOLD** _(optional)_ — called when `fetch.status = complete` AND `order.designSpec.scaffold = true`

- Reads `fetch.assets` + `order.designSpec` from Job Spec
- Produces scene plan (script, scene headers, durations)
- Writes `scaffold.scenes` + `scaffold.status = complete`
- Skipped entirely if customer doesn't need scripted scenes

**ASSEMBLY** — called when `fetch.status = complete` (scaffold optional)

- Reads `fetch.assets` + `scaffold.scenes` (if present) + `order.designSpec` from Job Spec
- Runs FFmpeg: cuts, stitches, crops, captions, chrome overlay, watermarks
- Writes `assembly.outputs` + `assembly.thumbnailUrl` + `assembly.status = complete`
- Does not know who uploaded the assets or what happens after

**PREFLIGHT** — called when `assembly.status = complete`

- Reads `assembly.outputs` + `order` from Job Spec
- Generates publish copy (Claude: titles, descriptions, hashtags, pinned comment)
- Packages everything Upload-Post needs per platform
- Writes `preflight.packages` + `preflight.status = complete`
- Does not touch video files, does not call Upload-Post

**UPLOAD** — called when `preflight.status = complete` AND customer approves

- Reads `preflight.packages` from Job Spec
- Sends R2 URL + metadata to Upload-Post
- Deletes from R2 on `publish:all_done`
- Prompts customer: schedule or publish now, private → public
- Writes `upload.results` + `upload.status = complete`

---

#### Service ordering — customers declare exactly what they need

Every job declares which services to run. The orchestrator only enqueues declared services. Nothing runs automatically unless ordered.

```json
{
  "order": {
    "services": ["fetch", "assembly", "preflight", "upload"],
    "scaffold": false
  }
}
```

**Any combination is valid:**

| Customer order                                             | Services run                  | Use case                                                         |
| ---------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------- |
| `["fetch"]`                                                | Fetch only                    | "Scrape this URL and store the clips for me"                     |
| `["fetch", "scaffold"]`                                    | Fetch + Scaffold              | "Get this content and write me a scene plan"                     |
| `["fetch", "assembly", "preflight", "upload"]`             | Full pipeline, no scaffold    | "Download, cut, package, publish — I don't need scripted scenes" |
| `["fetch", "scaffold", "assembly", "preflight", "upload"]` | Full pipeline                 | "Get content, script it, produce it, publish it"                 |
| `["assembly", "preflight", "upload"]`                      | Assembly → Preflight → Upload | "I already have clips in storage, just cut and publish"          |
| `["preflight"]`                                            | Preflight only                | "I have a finished video, just generate my titles and hashtags"  |
| `["preflight", "upload"]`                                  | Preflight + Upload            | "Video is done, package and publish it"                          |

**Services have no hardcoded dependencies on each other.** Each service checks the Job Spec for what it needs:

- **Assembly** without Scaffold → reads `job_spec.fetch.assets` directly, no scene structure required
- **Assembly** without Fetch → reads `job_spec.order.inputs.assets` (customer-provided R2 URLs)
- **Preflight** without Assembly → reads `job_spec.order.inputs.videoUrl` (customer provides finished video)
- **Upload** without Preflight → reads `job_spec.order.publishDefaults` (customer pre-configured titles/tags)

Each service gracefully handles its inputs being absent — it reads from wherever the data is in the Job Spec, not from a specific prior service.

**The orchestrator rule:** only enqueue a service if it is in `order.services` AND its required inputs are present in the Job Spec. If inputs aren't there yet, wait. If they'll never be there (service not ordered), never enqueue.

---

#### Recovery — Work Orders, not restarts

When a service fails or produces output that a downstream service can't use, it does **not** trigger a full restart. It issues a **Work Order** — a targeted instruction written to the Job Spec telling a specific service exactly what needs to be redone.

**The Work Order model:**

```
Service encounters a problem
  → writes a Work Order to Job Spec: { service, type, payload, reason }
  → sets its own status to "needs_work_order" (not "failed")
  → exits cleanly

Orchestrator sees Work Order → enqueues the target service with that work order
Target service reads work order → does only the requested work → writes result → exits
Orchestrator re-enqueues the original service with just the fixed piece
```

**Example A — Assembly receives a corrupt clip from Fetch:**

```
1. Assembly starts processing 10 clips
2. Clip 4 is corrupt — cannot encode
3. Assembly writes to Job Spec:
   workOrders: [{ service: "fetch", type: "re_fetch_asset",
     payload: { assetIndex: 4, originalUrl: "...", reason: "corrupt_on_decode" }}]
   assembly.status = "waiting_on_work_order"
4. Orchestrator enqueues Fetch with that work order
5. Fetch re-fetches only clip 4 → updates job_spec.fetch.assets[4]
6. Fetch marks work order complete
7. Orchestrator re-enqueues Assembly: "resume from asset 4"
8. Assembly picks up 9 good clips + 1 fresh clip → completes
```

**Example B — Assembly produces output that Preflight flags as missing metadata:**

```
1. Preflight reads assembly output — thumbnail is missing
2. Preflight writes work order: { service: "assembly", type: "generate_thumbnail",
     payload: { outputIndex: 0, reason: "thumbnail_missing" }}
   preflight.status = "waiting_on_work_order"
3. Orchestrator enqueues Assembly with thumbnail-only work order
4. Assembly generates just the thumbnail → writes r2:// URL back to job_spec
5. Assembly marks work order complete
6. Orchestrator re-enqueues Preflight — it picks up where it left off
```

**Example C — Assembly needs Scaffold to revise specific scenes:**

```
1. Assembly encodes scene 3 — source clip is 5s but scene needs 30s
2. Assembly writes work order: { service: "scaffold", type: "revise_scenes",
     payload: { sceneIds: ["SCENE_3"], directive: "extend to 30s, add b-roll" }}
3. Scaffold revises only scene 3 → updates job_spec.scaffold.scenes[2]
4. Assembly re-processes only scene 3 → merges with 9 completed scenes → done
```

**Work Order structure in Job Spec:**

```json
{
  "workOrders": [
    {
      "id": "wo_abc123",
      "service": "fetch | scaffold | assembly | preflight | upload",
      "type": "re_fetch_asset | revise_scenes | generate_thumbnail | repackage_platform | ...",
      "payload": {},
      "status": "pending | in_progress | complete | failed",
      "createdBy": "assembly",
      "createdAt": "2026-04-25T...",
      "completedAt": null
    }
  ]
}
```

**The key:** no service ever says "start over." Every failure produces a minimal, targeted work order. The rest of the job's completed work is preserved. Customers never lose progress they already paid for.

---

#### What maps to existing code

| C1+ service              | Current code                                  | Status                                             |
| ------------------------ | --------------------------------------------- | -------------------------------------------------- |
| Fetch — URL scrape       | `lib/sources/` (nba, news, twitch)            | ✅ Refactor to write Job Spec + exit               |
| Fetch — UI upload        | Not built                                     | 🔲 Block 3                                         |
| Fetch — Customer storage | Not built                                     | 🔲 Block 3                                         |
| Fetch — AI generate      | RunPod integration                            | 🔲 Block D                                         |
| Scaffold (optional)      | `lib/scaffold.js`, `lib/script_gen.js`        | ✅ Refactor as optional queue worker               |
| Assembly                 | `lib/assembly.js`                             | ✅ Refactor to queue worker, reads Job Spec only   |
| Preflight                | Buried in assembly.js + gate5.js              | 🔲 Extract as standalone queue worker              |
| Upload                   | `lib/gates/gate5.js`                          | ✅ Refactor to queue worker, reads preflight block |
| R2 storage               | Not built                                     | 🔲 Block 3                                         |
| Orchestrator             | In-memory pipelineBus (synchronous, blocking) | 🔲 BullMQ + Redis, event-driven                    |

**The biggest current problem:** `lib/assembly.js` is one 4000-line function that runs everything sequentially and synchronously — Gate 2, FFmpeg, Gate 3a, Gate 3b, Gate 4, Gate 5 — all in one blocking chain. If any step fails, the whole chain fails. In Block 3 this splits into independent queue workers that each read from the Job Spec, do one thing, and exit.

#### Orchestrator — watches Job Specs, enqueues declared services only

```
Job Spec created with order.services = ["fetch", "assembly", "upload"]
  → Orchestrator enqueues Fetch
  → Fetch completes, writes job_spec.fetch
  → Orchestrator checks: Assembly in order? Yes. Inputs ready? Yes. → enqueues Assembly
  → Assembly completes, writes job_spec.assembly
  → Orchestrator checks: Preflight in order? No. Upload in order? Yes. Inputs ready? Yes. → enqueues Upload
  → Upload completes
  → Job done
```

Scaffold was not in the order — it never ran. Preflight was not in the order — it never ran.

**Services are independent queue workers. They never call each other. They never wait for each other.**

Each queue is independent. If Assembly is slow (large FFmpeg job), Preflight for a different job is already processing. No service blocks any other.

**Re-run a single service:** set `job_spec.assembly.status = null` → orchestrator re-enqueues Assembly only. Fetch results are still in the Job Spec. Assembly picks them up and runs again. Nothing else touches.

**Implementation:** BullMQ + Redis on Render. Each service is a `Worker` on its own named queue. The orchestrator is a `QueueEvents` listener that checks `order.services` and input availability before enqueuing.

---

### AuraFlux product vision — input modes

```
Use My Content          Link Content           Start From Idea
(upload clips/video)    (Twitch/YouTube/URL)   (text prompt → AI)
        ↓                       ↓                      ↓
        ←────────────── FETCH → SCAFFOLD? → ASSEMBLY ──────────────→
        ←─────────────── PREFLIGHT → UPLOAD ───────────────────────→
              YouTube / TikTok / Instagram (private draft → publish)
```

**HeyGen is not in C1+ architecture.** Avatar + scaffold + manual hold = c0-only legacy path.
C1+ customers bring their own content or generate via RunPod/SVD. Assembly is FFmpeg-only.

**C0 benefits from C1+ infrastructure** (Render, R2, queue, Postgres) but does not drive decisions.

### C1+ pipeline stages (no HeyGen)

```
1. Ingest       Upload MP4 / paste URL / enter prompt
2. Analyze      Gemini watches content → timestamps, highlights, crop regions
3. Cut          FFmpeg: -ss [start] -to [end] -c copy (lossless) or re-encode for crop
4. Enhance      Optional: RunPod/ComfyUI SVD for AI motion / style transfer
5. Assemble     FFmpeg concat → normalize → chrome overlay → ticker
6. Store        Cloudflare R2 (temp) → public URL
7. Publish      Upload-Post: R2 URL → YouTube/TikTok/IG
8. Cleanup      Delete from R2 on publish-confirmed (or 7-day paid retention)
```

### What RunPod/SVD adds for C1+ (Start From Idea mode)

```
Text prompt → SDXL image → SVD (img2vid, 14-25 frames, 2-4s clip) → FFmpeg stitch
```

- SVD motion: `motion_bucket_id` (low=subtle, high=intense), `fps`
- ComfyUI on RunPod RTX 4090 (serverless, pay per second, pause when idle)
- No avatar, no script scaffold, no HeyGen

### C0 vs C1+ — critical architectural boundary

**C0 (ClipzWorld News) is Rob's internal production tool.** It proves the pipeline works and produces real content, but it is NOT the product. Do not over-engineer c0 infrastructure.

**C1+ is the product.** Every infrastructure decision is made for C1+.

| Concern             | C0 policy                           | C1+ policy                           |
| ------------------- | ----------------------------------- | ------------------------------------ |
| Video storage       | Local `output/` — download manually | R2 — delete on publish-confirmed     |
| Publish             | Manual download is fine             | R2 URL → Upload-Post → auto-delete   |
| Drive upload        | Broken — do not fix                 | Not used — R2 replaces it            |
| HeyGen              | c0-only legacy path                 | **Not in C1+ pipeline**              |
| Manual segment hold | c0-only                             | **Not in C1+ pipeline**              |
| Gate 2              | Bypassed for c0                     | Full render QA for C1+ uploads       |
| Dashboard           | `cwn_production.html` c0 ops tool   | `app.auraflux.co` for C1+            |
| Retention           | No policy — files sit in output/    | Free: delete on publish. Paid: 7-day |

**Rule for future agents:** Only fix c0 issues if they block producing a usable MP4. Everything else is C1+ work.

### C0 vs C1+ — critical architectural boundary

### Target architecture (Block 3+)

**Domain:** `auraflux.co` (`.co` — confirmed)

```
auraflux.co           ← marketing site       Vercel Static / Render Static Site
app.auraflux.co       ← customer dashboard   Next.js on Vercel (apps/web/)
api.auraflux.co       ← backend API          Render Web Service (apps/server/ ← this repo)
```

```
Frontend     Vercel / Next.js + Shadcn     apps/web/          → app.auraflux.co
Backend      Render.com / Node.js          apps/server/       → api.auraflux.co  ← this repo
Marketing    Vercel Static                 apps/marketing/    → auraflux.co
AI Engine    RunPod.io / ComfyUI + SVD     external API
Storage      Cloudflare R2                 replaces local output/   (free 10GB/mo)
Queue        BullMQ + Redis                replaces pm2 + in-memory jobs
DB (billing) PostgreSQL on Render          credits, voice profiles, Stripe events
DB (jobs)    SQLite on persistent disk     job pipeline — full PG cutover is CPD-51 phase 2
```

**Render services at launch (~$34/mo total):**
| Service | Plan | Cost |
|---|---|---|
| Web Service (`auraflux-api`) | Starter | $7/mo |
| PostgreSQL | Starter | $7/mo |
| Redis (BullMQ) | Starter | $10/mo |
| Persistent Disk (10GB) | — | $10/mo |
| Static Site (marketing) | — | Free |
| Cloudflare R2 (video storage) | — | Free ≤10GB |

**Vercel plan:** Stay on Hobby ($0) until Block 3, then upgrade to Pro ($25/mo) for commercial use + team + unlimited builds.

**Monorepo structure (when we build it):**

```
auraflux/
├── apps/
│   ├── server/     ← current cwn-production repo, moved here
│   └── web/        ← new Next.js frontend (Vercel)
├── packages/
│   ├── shared/     ← TypeScript types, job spec contracts, validation
│   └── ffmpeg-utils/ ← shared FFmpeg helpers
└── package.json    ← turborepo or pnpm workspaces
```

### AI video generation (C1+ path, no HeyGen)

For customers not using HeyGen avatar:

1. **Text→Video**: Prompt → SDXL image → SVD (Stable Video Diffusion) → FFmpeg assemble
2. **Long→Short**: Upload MP4 → Gemini timestamps → `ffmpeg -ss [start] -to [end] -c copy` → 9:16 crop
3. **Short→Long**: Upload clip → ComfyUI extend / FFmpeg loop + assemble

RunPod implementation:

- Use ComfyUI template (RTX 4090 recommended)
- `thecooltechguy/ComfyUI-Stable-Video-Diffusion` nodes for SVD
- Serverless endpoints for on-demand scaling
- Pause pods between jobs to control cost

---

## Block Execution Plan (ordered, with owner handoff notes)

## AuraFlux Build Plan — Phased Architecture

**Architect: Cursor. Sub-Agents: A (backend), B (API/data), C (frontend). Batch work: Aider.**
**No HeyGen in any C1+ phase. HeyGen stays in c0 code path, untouched.**

---

### What stays from c0 vs what gets built new

#### Stays (refactored, not rewritten)

| File / Module                         | What it becomes in C1+                                              |
| ------------------------------------- | ------------------------------------------------------------------- |
| `lib/sources/` (nba, news, twitch)    | **Fetch service** — generalized scraper, writes to Job Spec         |
| `lib/assembly.js` (FFmpeg core)       | **Assembly service** — split into queue worker, reads Job Spec only |
| `lib/script_gen.js` (Gemini analysis) | **Fetch** gets Gemini analysis; **Scaffold** gets script gen        |
| `lib/scaffold.js`                     | **Scaffold service** — optional queue worker                        |
| `lib/gates/gate5.js`                  | **Upload service** — reads Preflight block from Job Spec            |
| `lib/thumbnail.js`                    | Stays in Assembly service                                           |
| `lib/chrome_overlay_ffmpeg.js`        | Stays in Assembly service                                           |
| `lib/job_spec.js`                     | **Job Spec store** — SQLite on persistent disk (sync); PG cutover in CPD-51 phase 2 |
| `lib/publish.js` (Upload-Post calls)  | Stays in Upload service                                             |

#### Removed from C1+ (stays in c0 code path, not deleted)

| File / Module                       | Status                | Notes                                                                  |
| ----------------------------------- | --------------------- | ---------------------------------------------------------------------- |
| `lib/gates/gate2.js`                | **Kept for c0**       | HeyGen render QA — c0 only, bypassed via `shouldUseManualCheckpoint()` |
| `lib/heygen_folder_map.js`          | **Kept for c0**       | HeyGen folder routing — c0 only                                        |
| `bin/heygen-poller.js`              | **Kept for c0**       | HeyGen polling — c0 only                                               |
| `lib/manual_segment_workflow.js`    | **Kept for c0**       | Manual hold + ordinal matching — c0 only                               |
| HeyGen calls in `lib/script_gen.js` | **Kept for c0**       | Gated behind `shouldUseManualCheckpoint()`                             |
| `data/jobs.json`                    | **Kept for c0 local** | Replaced by PostgreSQL on Render; local dev still uses JSON            |
| Google Drive upload                 | **Kept for c0 local** | Replaced by R2 on Render; c0 local can still try Drive                 |

**Nothing gets deleted.** C1+ services are additive. C0's entire HeyGen → manual review → assembly workflow continues to run exactly as it does today on localhost. The flag `shouldUseManualCheckpoint()` (checks `jobSpecId.startsWith('c0_')`) is what keeps the paths separate.

#### Built new for C1+

| What                                  | Where                        | Phase   |
| ------------------------------------- | ---------------------------- | ------- |
| Cloudflare R2 storage layer           | `lib/storage/r2.js`          | Phase 2 |
| BullMQ orchestrator                   | `lib/orchestrator/index.js`  | Phase 2 |
| Queue workers (Fetch, Assembly, etc.) | `lib/workers/`               | Phase 2 |
| PostgreSQL Job Spec store             | `lib/db/job_spec_pg.js`      | Phase 2 |
| Work Order system                     | `lib/workers/work_orders.js` | Phase 2 |
| UI upload endpoint                    | `server.js` → `apps/server/` | Phase 2 |
| Customer storage credentials handler  | `lib/workers/fetch/`         | Phase 3 |
| Preflight service                     | `lib/workers/preflight.js`   | Phase 2 |
| RunPod/ComfyUI integration            | `lib/ai/runpod.js`           | Phase 4 |
| SVD text-to-video workflow            | `lib/ai/svd_workflow.js`     | Phase 4 |
| Next.js frontend                      | `apps/web/`                  | Phase 3 |
| Marketing site                        | `apps/marketing/`            | Phase 3 |
| `render.yaml`                         | repo root                    | Phase 2 |

---

### Phase 1 — Block 2: Validate c0 baseline (do first, gate to everything)

**Goal:** Prove the existing pipeline produces usable MP4s end-to-end on c0.
**No new architecture. No refactoring. Just test runs.**

**6 test cases (execute in order):**

| #   | Run                     | Config                    | Pass bar                                    |
| --- | ----------------------- | ------------------------- | ------------------------------------------- |
| 1   | NBA long-form 1-clip    | 1 game, live HeyGen       | Usable MP4 in `output/`, 14 avatars visible |
| 2   | News long-form 1-clip   | 1 story, portrait AJ clip | Usable MP4, correct chrome                  |
| 3   | Twitch long-form 2-clip | Jason, 2 clips            | Usable MP4                                  |
| 4   | NBA short-form          | nba-short, 1 game         | Usable 9:16 MP4                             |
| 5   | NBA long-form 3-clip    | 3 games full episode      | Gate 3a ≥70                                 |
| 6   | News long-form 5-story  | 5 stories full episode    | Gate 3a ≥70                                 |

**Who:** Rob runs from dashboard. Cursor monitors logs, fixes any gate failures between runs.
**Done when:** All 6 produce usable MP4s. Gate 3a passes (≥60). No manual intervention required.

---

### Phase 2 — Block 3: Render infrastructure + C1+ foundations

**Goal:** Running on Render. R2 storage wired. BullMQ queues live. Services decoupled from server.js.\*\*
**Unblocked by:** Phase 1 complete.

#### Step 2.1 — Render deploy (Cursor + Sub-Agent B)

- Write `render.yaml` — Web Service, PostgreSQL, Redis, Persistent Disk
- Migrate env vars from `.env` → Render environment panel
- Replace pm2 with `node apps/server/server.js` (Render manages process)
- Fix Puppeteer/Chrome path for Render's Linux environment
- FFmpeg build step in `render.yaml`
- Health check: `/health`
- **Rob does:** confirm Web Service shows green in Render dashboard

#### Step 2.2 — Cloudflare R2 storage (Cursor + Sub-Agent B)

- Sign up at cloudflare.com → create R2 bucket `auraflux-video`
- `lib/storage/r2.js` — `uploadToR2(localPath)`, `getPublicUrl(key)`, `deleteFromR2(key)`
- Replace `uploadToDrive()` with `uploadToR2()` in assembly.js
- Wire delete-on-publish: after `publish:all_done`, delete R2 object
- **Rob does:** create Cloudflare account, create R2 bucket, paste `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_URL` into Render env

#### Step 2.3 — PostgreSQL Job Spec migration (Sub-Agent A + Aider)

- Aider: generate Drizzle ORM schema for `job_specs` table (mirrors current SQLite schema + `order.services` + `workOrders` columns)
- Sub-Agent A: `lib/db/job_spec_pg.js` — drop-in replacement for `lib/job_spec.js` using Postgres
- Migrate existing SQLite data → Postgres (one-time script via Aider)
- Feature flag: `USE_PG=true` in env to switch between SQLite (c0 local) and Postgres (Render)

#### Step 2.4 — BullMQ orchestrator + queue workers (Sub-Agent A)

- `lib/orchestrator/index.js` — watches Job Spec updates, enqueues declared services
- `lib/workers/fetch.worker.js` — reads `order`, calls appropriate source scraper, writes `job_spec.fetch`
- `lib/workers/assembly.worker.js` — reads Job Spec, runs FFmpeg, writes `job_spec.assembly`
- `lib/workers/preflight.worker.js` — reads Job Spec, generates publish copy, writes `job_spec.preflight`
- `lib/workers/upload.worker.js` — reads Job Spec preflight block, calls Upload-Post, deletes R2
- Work Order handler — each worker checks `job_spec.workOrders` for pending orders addressed to it
- **c0 path untouched:** existing `heygen:all_complete` → assembly flow stays as-is, gated by `shouldUseManualCheckpoint()`

#### Step 2.5 — UI upload endpoint (Sub-Agent B)

- `POST /upload` — accepts multipart video upload, saves to R2, creates Job Spec with `sourceType: "ui_upload"`
- Returns `jobId` for frontend polling
- Validates: MP4/MOV only, max 2GB, virus-scan placeholder

#### Step 2.6 — Preflight as standalone service (Sub-Agent A)

- Extract publish copy generation from `assembly.js` and `gate5.js` into `lib/workers/preflight.worker.js`
- Reads `job_spec.assembly.outputs` + `job_spec.order`
- Calls Claude for title/description/hashtags/pinned comment
- Writes `job_spec.preflight.packages`
- Assembly no longer generates publish copy — it just produces the video

---

### Phase 3 — Block 4: Next.js frontend + C1 foundations

**Goal:** `app.auraflux.co` live. First external customer can create a job.
**Unblocked by:** Phase 2 complete.

#### Step 3.1 — Monorepo restructure (Aider)

```
auraflux/
├── apps/
│   ├── server/     ← current repo moved here
│   └── web/        ← new Next.js app
├── packages/
│   └── shared/     ← TypeScript types, Job Spec schema
└── package.json    ← pnpm workspaces
```

#### Step 3.2 — Next.js app scaffolding (Sub-Agent C)

- `apps/web/` — Next.js 15, Tailwind, Shadcn UI
- Three input mode cards: Use My Content / Link Content / Start From Idea
- Job status page — polls `GET /api/jobs/:id` from `api.auraflux.co`
- Service selector — customer picks which services to run (`order.services`)
- Publish review page — shows assembled video, confirms preflight copy before upload

#### Step 3.3 — Block 4 cleanup (Aider batch)

- Prettier pass across all files
- `.gitignore` audit — ensure `output/`, `tmp/`, `data/jobs.json`, `.env` are all ignored
- CWN→AuraFlux rename audit — propose list, Rob approves
- ~~Remove `.roo/modes/*.yaml`~~ ✅ Done — entire `.roo/` directory removed
- ~~Remove `roo-watcher` from `ecosystem.config.js`~~ ✅ Done

#### Step 3.4 — Load test (Cursor)

- `npm run load-test:health` — autocannon hits `/health`, HeyGen off
- Confirm Render handles concurrent requests without crash

---

### Phase 4 — Block D: RunPod/ComfyUI + AI generation

**Goal:** "Start From Idea" mode live. Customers can generate video from text prompt.
**Unblocked by:** Phase 3 complete. **Not launch-blocking.**

#### Step 4.1 — RunPod setup (Rob + Cursor)

- **Rob:** sign up at runpod.io, add $20 credits
- **Rob:** launch ComfyUI pod (RTX 4090 template with SVD)
- **Rob:** paste `RUNPOD_API_KEY` + `RUNPOD_ENDPOINT_ID` into Render env

#### Step 4.2 — SVD text-to-video (Sub-Agent A)

- `lib/ai/runpod.js` — POST to RunPod ComfyUI serverless endpoint
- SVD workflow: text prompt → SDXL image → SVD (14-25 frames) → MP4 output → R2
- `lib/ai/svd_workflow.json` — ComfyUI workflow definition (SDXL + SVD nodes)
- Fetch service: if `sourceType = "ai_generate"`, call RunPod, store result in R2
- Pause/resume pod management (cost control)

#### Step 4.3 — Long-to-short + short-to-long (Sub-Agent A)

- Assembly service: if `order.outputFormats` includes both `"16:9"` and `"9:16"` → produce both in one run
- Gemini timestamp extraction: for long-form → short-form, Gemini identifies top 3 clip moments
- FFmpeg crop: `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920`
- Short-to-long: FFmpeg concat + optional SVD clip extension

---

### Agent routing by phase

| Phase | Task                                   | Agent                          | Notes                         |
| ----- | -------------------------------------- | ------------------------------ | ----------------------------- |
| 1     | c0 test runs                           | Rob (runs) + Cursor (monitors) | Dashboard only                |
| 2.1   | Render deploy                          | Cursor + Sub-Agent B           | `render.yaml`, env mapping    |
| 2.2   | R2 wiring                              | Sub-Agent B                    | 30-line swap in assembly.js   |
| 2.3   | Postgres migration                     | Sub-Agent A + Aider            | Schema + migration script     |
| 2.4   | BullMQ workers                         | Sub-Agent A                    | Core refactor — highest risk  |
| 2.5   | Upload endpoint                        | Sub-Agent B                    | Standard Express endpoint     |
| 2.6   | Preflight service                      | Sub-Agent A                    | Extract from assembly.js      |
| 3.1   | Monorepo                               | Aider                          | File moves + package.json     |
| 3.2   | Next.js app                            | Sub-Agent C                    | Scaffolding + 3-mode UI       |
| 3.3   | Cleanup (Prettier, .gitignore, rename) | Aider                          | Overnight batch               |
| 3.4   | Load test                              | Cursor                         | Run + interpret               |
| 4.1   | RunPod setup                           | Rob + Cursor                   | Sign up + pod config          |
| 4.2   | SVD integration                        | Sub-Agent A                    | RunPod API + ComfyUI workflow |
| 4.3   | Long↔short transforms                  | Sub-Agent A                    | FFmpeg + Gemini timestamps    |

---

### What Rob needs to do (and when)

| When              | Action                                                                          |
| ----------------- | ------------------------------------------------------------------------------- |
| **Now (Phase 1)** | Run 6 test cases from dashboard. Report pass/fail per run.                      |
| **Phase 2 start** | Create Cloudflare account + R2 bucket → paste 4 env vars                        |
| **Phase 2 start** | Confirm Render Web Service shows green after deploy                             |
| **Phase 3 start** | Review + approve CWN→AuraFlux rename list                                       |
| **Phase 3 start** | Review Next.js UI design before Sub-Agent C builds it                           |
| **Phase 4 start** | Sign up RunPod, add $20 credits, launch ComfyUI pod → paste 2 env vars          |
| **Always**        | Approve any change that touches `order.services` contract or customer-facing UI |

---

## Session Handoff — 2026-04-25 + 2026-04-26 (Rob + Cursor, overnight)

This was a large two-session run. All changes are uncommitted working copy changes on top of the last committed state (`f214868`). Everything listed below is live in the running server (`pm2: auraflux, pid 97046`).

### C0 / C1+ balance note

Every fix below is tagged **[C0]** (fixes c0 short/long production), **[C1+]** (removes architectural blocker for future customers), or **[BOTH]**. No C1+ work was removed or regressed. The gate bypass fixes were uncommitted regressions in the working copy — committed code (6 days ago) was already correct.

---

### 04/25 — Gate system audit + short-form pipeline fixes

| Fix                                                  | File(s)                                              | Why                                                                                                                                                                                                                                                   | C0/C1+?                 |
| ---------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `localFiles` index mismatch in group assembly        | `lib/assembly.js`                                    | `.push()` caused index drift when segments were skipped — chrome overlays applied to wrong segments                                                                                                                                                   | BOTH                    |
| `processSegmentToTs` label lookup fragile            | `lib/assembly.js`                                    | Was string-matching filename to find label — broke on any naming variation. Now uses direct `segsToProcess[segIdx]`                                                                                                                                   | BOTH                    |
| Temp concat/stitch list files not cleaned            | `lib/assembly.js`                                    | `*_stitch_list.txt` and `*_concat_list.txt` leaked to disk after every job                                                                                                                                                                            | BOTH                    |
| Gate 3/4/5 short-form bypass (structural)            | `lib/assembly.js`                                    | Working copy had Gates 3/4/5 inside `else { // LONG-FORM }` block — short-form jobs never ran QA or published. Committed code (6 days ago) was correct; uncommitted changes regressed it                                                              | **C0 critical**         |
| Gate 4/5 blocked by Drive upload failure             | `lib/assembly.js`                                    | Gate 4/5 was inside `if (driveUrl)` — when Drive upload failed/was skipped, publishing never ran. Fixed: Gate 4/5 now always runs after Drive attempt, uses `assemblyJobs[asmId].driveUrl` which is consistently set (real URL or localhost fallback) | **C0 critical**         |
| `SKIP_DRIVE_UPLOAD` path missing driveUrl            | `lib/assembly.js`                                    | When `SKIP_DRIVE_UPLOAD=true`, `assemblyJobs[asmId].driveUrl` was never set — Gate 5 had no URL to publish. Fixed: sets localhost fallback URL                                                                                                        | C0                      |
| `uploadSignal` override in Gate 4                    | `lib/gates/gate4.js`                                 | If Gemini returned `uploadSignal: true` but internal checks added blockers, signal stayed `true`. Fixed: `uploadSignal = blockers.length > 0 ? false : geminiSignal`                                                                                  | BOTH                    |
| `lockedOutro` required for non-avatar jobs           | `lib/gates/gate1.js`                                 | `canProduce` check blocked any job without `designSpec.voice.lockedOutro` — a HeyGen-only field. Fixed: conditional on `hasAvatarWorkflow` check                                                                                                      | **C1+ blocker removed** |
| `seedJobSpecFromScript` hardcoded `customerId: 'c0'` | `lib/job_spec.js`                                    | Fallback job spec creation always assigned C0 customer — C1+ jobs would inherit wrong config. Fixed: queries `customer_id` from `jobs` table                                                                                                          | **C1+ blocker removed** |
| NBA/News inline clip/story picker                    | `cwn_production.html`                                | "PICK CLIPS" / "PICK STORIES" buttons load available content with checkboxes before job dispatch — implements Content Confirmation Gate for C0, precursor pattern for C1+                                                                             | **BOTH**                |
| Batch shorts selector (×1/×3/×5)                     | `cwn_production.html`                                | Select how many concurrent shorts to generate from the same picker pool                                                                                                                                                                               | C0                      |
| Content Confirmation Gate documented                 | `docs/architecture/DECOUPLED_VIDEO_PRODUCT_STACK.md` | Formalizes Stage 0 / Stage 0b as architectural principles for C1+ — "inputs.items fully populated before `createJobSpec()` runs"                                                                                                                      | C1+                     |

---

### 04/26 — Short-form 3-phase timeline + QA + picker wiring

| Fix                                           | File(s)                          | Why                                                                                                                                                                                                                                                                                                                               | C0/C1+?          |
| --------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| **REACTION folder ordinal mismatch**          | `lib/manual_segment_workflow.js` | HeyGen exports named `02_nbaS_REACTION_<id>` → `ord=2`. Code searched `heygenOrdinal=1` (count of avatar-only segments before REACTION, skipping source clips). `2 ≠ 1`. REACTION silently skipped every time. **Fix:** check `n.ord === i` (absolute index) first, then `n.ord === heygenOrdinal` as fallback                    | **C0 critical**  |
| NBA short 3-phase timeline disabled           | `lib/assembly.js`                | `useHookClipReactionMode` had `&& !isNbaShort` — explicitly disabled for NBA. NBA shorts always fell to fallback single-pass. **Fix:** removed the exclusion — all short content types use the same 3-phase (HOOK → CLIP window → REACTION) layout                                                                                | **C0 critical**  |
| Short-form avatar incompleteness warning      | `lib/assembly.js`                | When REACTION is missing (no file in manual folder), fallback ran silently. **Fix:** explicit warn log listing each missing file by `expectedFilename` so operator knows exactly what to drop                                                                                                                                     | C0               |
| Clip duration in fallback path (4-second bug) | `lib/assembly.js`                | Fallback single-pass trimmed clip to `avatarDuration` (~4s HOOK length). **Fix:** now uses `SHORT_CLIP_WINDOW_MAX_SEC` (default 25s)                                                                                                                                                                                              | **C0 critical**  |
| 3-phase clip window default too short         | `lib/assembly.js`                | Default was 12s. For 75s+ ESPN highlights, 12s might show wrong part. **Raised to 25s.** Overridable via `SHORT_CLIP_WINDOW_MAX_SEC` in `.env`                                                                                                                                                                                    | C0               |
| `clipFilesMeta` tracking missing              | `lib/assembly.js`                | `clipFiles` array had paths but no metadata — `clipTimingTargets` (Gemini's key moment timestamps) were lost before short-form assembly. **Fix:** added `clipFilesMeta[]` parallel array built alongside `clipFiles`                                                                                                              | BOTH             |
| Timing seek not wired for short-form          | `lib/assembly.js`                | Short-form clip trim always started at second 0. For a 75s clip, the Murray play is at ~0:38. **Fix:** `-ss seekOffset` added using `clipTimingTargets[0].start - 1s` pre-roll. Logs `⏩ Clip seek: Xs` when active                                                                                                               | BOTH             |
| Gate 3a blind to wrong clip content           | `lib/gates/gate3a.js`            | Gate 3a prompt said "YOU DO NOT CHECK: script content, names." For short-form it can't distinguish a correct clip from a wrong game. **Fix:** for short-form, added `clipContentMatchesScript` boolean to Gemini response + prompt gives Gemini the HOOK/REACTION text to check against                                           | C0               |
| Gate 3a wrong clip scoring                    | `lib/gates/gate3a.js`            | `clipContentMatchesScript=false` deducts **-40 points** and logs `GATE3A_WRONG_CLIP_CONTENT`. Blocks Gate 4 on wrong clip.                                                                                                                                                                                                        | BOTH             |
| Picker not wired to SHORT buttons             | `cwn_production.html`            | `generateShort()` always fetched fresh from ESPN/AJ regardless of picker selections. **Fix:** at top of `generateShort('nba')` and `generateShort('news')`, checks `_nbaPickerGames` / `_newsPickerStories` for `_selected` items and uses them directly, skipping the ESPN/AJ fetch                                              | C0 (C1+ pattern) |
| `generateShortBatch` used all picker items    | `cwn_production.html`            | Batch flow used all picker games (even unselected). **Fix:** prefers selected items, falls back to all picker items with clips, then falls back to auto-fetch                                                                                                                                                                     | C0               |
| Picker "feeds both" label                     | `cwn_production.html`            | UI had no indication the picker fed both LONG FORM and SHORT. Added "↑ feeds both" label between PICK CLIPS and LONG FORM buttons                                                                                                                                                                                                 | C0               |
| Short-form user prompts outdated              | `lib/script_gen.js`              | All 3 content types (NBA/news/twitch) had HOOK as "1 flat sentence" and REACTION as "1-2 deadpan sentences." **Updated per spec:** HOOK = 1-2 lines under 3 seconds, state value/shock/stakes immediately. REACTION = 2-4 lines, fast-paced punchy commentary that adds value (the take, not the recap). Word target: 50-80 words | C0               |
| System prompts outdated                       | `lib/script_gen.js`              | `SYSTEM_PROMPTS['nba-short']`, `['news-short']`, `['twitch-short']` all rewritten to match same HOOK/REACTION spec, preserving each show's distinct voice/tone                                                                                                                                                                    | C0               |

---

### Key facts for next session

**Drive auth (clarified):** `publish.js` uses `} else try {` — without `DRIVE_CLIENT_ID`/`SECRET`, OAuth2 is skipped entirely and it falls to service account key file (`Option 2`). Service account works fine if the key file has folder access. Do not add OAuth2 creds unless specifically needed.

**SHORT_CLIP_WINDOW_MAX_SEC:** New env var (default 25s). Add to `.env` to tune the clip window length for shorts.

**Manual segments folder naming:** Both `02_avatar_reaction.mp4` (flat file, absolute index) and `02_nbaS_REACTION_<id>/` (nested HeyGen export folder, absolute index) are now correctly resolved. The operator should continue naming files/folders with the absolute segment index (00=HOOK, 01=CLIP, 02=REACTION) matching `manifest.json`.

**Wrong clip root cause:** `nba_source.js` refreshes `item.clipUrl` before Gemini analyzes it. `orderedClipUrls` uses that refreshed URL for the prefetch. The clip Gemini sees and the clip assembled are always the same URL — they do not diverge. "Wrong game" = the auto-selection always uses `items[0]`. The picker solves this: selected game → only that item is passed to `callFullScriptServer`.

**Gate 3a short-form check:** Now asks Gemini to verify the clip on screen matches the player/team/event named in HOOK/REACTION text. Wrong clip = -40 points, blocks Gate 4. Requires `jobSpec.state.savedOutputs.filledScript` to be populated (it always is for short-form jobs).

**Pending tasks (not done):**

- Audit Gate 2 prerequisite chain for C1+ escape hatch
- Gate 5 single global `UPLOADPOST_PROFILE` → per-customer credentials for C1+
- BullMQ queue workers for C1+ pipeline
- `groupSegmentsByLabel` `itemIdx: -1` issue (LOW)
- Gate 5 `passed: anySuccess` misleading outcome (LOW)
- Twitch clip picker (no picker today — shorts auto-select highest-viewed clip across all streamers)

---

## Next Session Plan — 2026-04-27 (Rob + Cursor)

**Gate before everything:** Run Phase A E2E matrix first. Only move to Block 3+ if tests pass.

### Block 2 — Tests (run first, ~1 hr)

1. `npm test` — Jest 96 tests (16 suites), should be clean
2. Phase A E2E matrix — 6 job types (NBA long, News long, Twitch long, NBA short, News short, Twitch short)
   - Verify: NBA short REACTION appears (ordinal fix), clip is 25s not 4s
   - Verify: Gate 3a semantic content check fires for wrong-clip
   - Verify: Gate 4/5 runs regardless of Drive upload outcome
   - Verify: Dashboard picker selections flow into `generateShort` + `generateShortBatch`

### Block 3 — Render Migration (~2 hrs, IF tests pass)

5. Render.com deploy — Node.js backend (`api.auraflux.co`)
   - Source: `docs/ops/RENDER_RUNBOOK.md`, `docs/ops/RENDER_DEPLOY_CHECKLIST.md`, `docs/ops/POST_RENDER_TASKS.md`
   - Post-deploy tasks from `docs/handoffs/AIDER_HANDOFF_RENDER_READINESS.md`
   - Env vars, PM2 → Render process config, health check endpoint

### Block 4 — Platform/Architecture (~remaining hours)

6. **Serena MCP** — code intelligence for symbolic search, analysis, and editing (replaces Rovo Dev; active via MCP in Cursor)
7. **C0→C1+ UI code review + Equinox assessment**
   - Review `cwn_production.html` against C1+ Next.js/Shadcn target
   - Equinox = the new frontend design system; assess migration gap
8. **Autocannon load test** (HeyGen OFF, `GATE_TEST_MODE=true`)
   - `scripts/load_test_autocannon.js` — `npm run load-test:health`
9. **Prettier setup** — `.prettierrc` exists, run `npm run format:check` then `npm run format`
10. **GitHub cleanup / .gitignore** — audit untracked files, tighten ignore rules
11. **CWN→AuraFlux rename audit** — `docs/ops/RENAME_CWN_TO_AURAFLUX.md`

### Block 4 (cont.) — C1+ Decoupled Stack Architecture

Per `docs/architecture/DECOUPLED_VIDEO_PRODUCT_STACK.md`:

**Stack:**

- Frontend: Vercel / Next.js / Shadcn (`app.auraflux.co`)
- Backend: Render.com / Node.js — FFmpeg, API orchestration (`api.auraflux.co`)
- AI Engine: RunPod.io / ComfyUI + SVD — GPU video generation (serverless endpoints)

**Key workflows to implement:**

1. **Text-to-Video**: Prompt → Node.js → RunPod ComfyUI (SVD/SVD-XT) → S3 URL → frontend
2. **Long→Short**: Upload → Node.js FFmpeg split+resize 9:16 → optional ComfyUI enhancement
3. **Short→Long**: Upload short → ComfyUI high-context extension or FFmpeg loop/assemble

**Gemini clip analysis integration:**

- Feed video to Gemini → get top 3 timestamps + crop suggestions
- Pass timestamps to FFmpeg: `ffmpeg -ss [start] -i [input] -to [end] -c copy [output]`
- For vertical crop: `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920`
- Use `ffprobe` to find keyframe cut points for lossless cuts

**SVD pipeline:**

- SDXL generates base image from prompt
- SVD (`svd.safetensors` 14 frames / `svd_xt.safetensors` 25 frames) generates clip
- FFmpeg post-process: frame sequence → MP4, upscale, stitch scenes
- ComfyUI as node-based orchestrator for SDXL→SVD→FFmpeg workflows
- `motion_bucket_id`: low = subtle motion, high = intense; VRAM-limited → start 512×512 then upscale

**RunPod setup steps (when ready):**

1. Create account, add credits, launch ComfyUI pod (RTX 4090 recommended)
2. Select template with Stable Video Diffusion (`thecooltechguy/ComfyUI-Stable-Video-Diffusion`)
3. Wire RunPod API key on Render backend (never on frontend)
4. Use serverless endpoints for on-demand, cost-controlled generation
5. Pause pods when not in use

**Pending C1+ blockers (carry-forward):**

- Gate 5 per-customer `UPLOADPOST_PROFILE` credentials
- BullMQ queue workers for pipeline stages
- Cloudflare R2 replacing local disk / Google Drive for C1+ assets
- `groupSegmentsByLabel` `itemIdx: -1` (LOW)
- Gate 5 `passed: anySuccess` misleading (LOW)
