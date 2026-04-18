# AuraFlux System Overview
**Date:** 2026-04-18
**Status:** Authoritative — current production state on branch `feature/gate-worker-system`
**Audience:** All agents, new sessions, Customer 1 onboarding

---

## What AuraFlux Is

AuraFlux is a multi-customer AI video production platform. It takes source media (clips, news articles, sports highlights, or raw ideas) and produces broadcast-quality videos through a gated, self-healing pipeline.

**Customer 0** is ClipzWorld News (CWN) — the reference implementation. Bobby G is the avatar host. Three content types: News, Twitch clips, NBA highlights.

**Customer 1+** inherit the same pipeline, gates, and infrastructure. They configure `config/customers/{id}.json` — no code changes needed.

---

## Tech Stack (Current — 2026-04-18)

### Runtime
| Component | Technology | Notes |
|---|---|---|
| Language | Node.js v25.9.0 | Server + all lib modules |
| Process manager | PM2 v5+ | `npm run restart` = zero-downtime reload. App name: `auraflux` |
| Web framework | Express 4.18 | All API endpoints in server.js |
| Database | SQLite (better-sqlite3 12.9) | WAL mode, 3 tables: jobs, gate_results, job_metrics. Migrates to Postgres at Render deploy |
| ORM | None (raw SQL) → Drizzle at Render | |
| Queue | BullMQ 5.74 + Redis (ioredis 5.10) | 6 named queues: pipeline, gate, heygen-poll, assembly, upload, monitoring. Redis via Homebrew on localhost:6379 |

### AI Providers
| Provider | Use | Model |
|---|---|---|
| Anthropic Claude | Gate 1 style QA, Gate 3b commitment verification | claude-sonnet-4-6 |
| Google Gemini | Gate 0 source confirm, Gate 3a assembly QA, Gate 4 broadcast QA, script generation | gemini-2.5-flash |
| HeyGen | Avatar video rendering (Bobby G) | Template IDs: landscape `a917e52ebb164cc8ab3da97936361829`, portrait `ae51839648a84ce891bd83e0a44798db` |

### Infrastructure
| Component | Technology | Notes |
|---|---|---|
| Monitoring | New Relic (paid) | App name: AuraFlux. NR agent + infra container running |
| Containers | Docker | `cwn-server:local`, `cwn-poller:local` images built. New Relic infra agent running in Docker. Server runs native via PM2 (not Docker) for VideoToolbox FFmpeg |
| Video processing | FFmpeg (native macOS) | VideoToolbox hardware encoder on macOS, libx264 fallback on Linux |
| Chrome rendering | Puppeteer 24.40 | Newscast chrome overlay rendered to PNG, burned via FFmpeg |
| Static file server | Python http.server | Dashboard at localhost:8765 |
| Deployment target | Render | Docker auto-detected. Migration ready — Dockerfile complete |

### MCP Servers (Claude Code access)
| MCP | Purpose |
|---|---|
| BullMQ | Queue inspection, job monitoring via Redis |
| New Relic NerdGraph | NRQL queries via `NEW_RELIC_USER_KEY`. Account: 7957415 |
| Canva | Thumbnail generation |
| Google Drive/Gmail/Calendar | File delivery, auth |
| HeyGen | Avatar video via API |

### Customer 0 Specific
| Asset | Value |
|---|---|
| Long-form avatar ID | `842f20b75ce242aea397f5030aa018aa` |
| Short-form avatar ID | `ed57439c9c3d4a398f3b247b75714b13` |
| Voice ID | `2e598f1a6022448cb6710e5d44665325` (Bobby G, "cw") |
| Speak speed | 0.85 (long-form), 0.95 (short-form) |
| Chrome template | `tools/clipzworld_newscast.html` — one template, three CSS skins |

---

## Job Types (COMPACT / EXTRACT)

Every job is one of two types × three input methods:

| Code | Customer Name | What It Does |
|---|---|---|
| `COMPACT_FETCH` | Source Harvesting | Scrape source → script → avatar → assemble long-form (**current production**) |
| `COMPACT_DIRECT` | Curation Assembly | Customer provides clips → script → avatar → assemble |
| `COMPACT_GEN` | Synthetic Anthology | Runway/Higgsfield generates clips → assemble |
| `EXTRACT_DIRECT` | Viral Mining | Twelve Labs indexes provided video → extract best moments → shorts |
| `EXTRACT_FETCH` | Channel Repurposing | Scrape YouTube/ESPN → Twelve Labs → extract → shorts |
| `EXTRACT_GEN` | Concept Atomization | Generate master video → extract shorts (COMPACT_GEN → EXTRACT_DIRECT) |

**Job ID format:** `{customerId}_{COMPACT|EXTRACT}_{DIRECT|FETCH|GEN}_{contentType}_{timestamp}`
Example: `c0_COMPACT_FETCH_news_1776446778097`

---

## Pipeline Flow — End to End

```
Dashboard (localhost:8765)
  │
  ├─ Customer fires Generate
  │     └─ createJobSpec() → DB (jobs table, semantic job ID)
  │
  ▼
PRE-GENERATE (canProduce checks)
  All active stages report readiness before any credits burn
  │
  ▼
GATE 0 — Gemini Source Confirmation
  ffprobe confirms source URLs resolve, detects format (16:9/9:16)
  Authoritative format decision — all downstream gates read this
  │ PASS ↓  FAIL → stop, fix source, no credits burned
  ▼
SCAFFOLD GENERATION (system-owned)
  lib/scaffold.js generates scene headers from Job Spec + template formula
  Gemini receives scaffold with [DIALOGUE] slots — fills dialogue only
  Structural failures are now impossible
  │
  ▼
GATE 1 — Claude Style QA
  Checks: voice style, entity names, commentary accuracy, outro
  Does NOT check: scene count, structure, format (system-guaranteed)
  Score ≥90 → pass | 70-89 → one sendback with surgical fix directive | <70 → escalate
  │ PASS ↓
  ▼
HEYGEN RENDERING
  Each scene submitted as individual video → Bobby G renders
  Long-form: 7-42 segments depending on content type
  Poller checks completion every 30s
  │ ALL COMPLETE ↓
  ▼
GATE 2 — Render Quality (Code + ffprobe)
  ffprobe is ground truth — no AI overrides it
  Checks: file size (>100KB), audio stream present, freeze detection, avatar framing
  Hard fail: freeze detected OR audio missing → batch stops immediately
  Score ≥85 → pass | 65-84 → operator review | <65 → hard fail
  │ PASS ↓
  ▼
ASSEMBLY (FFmpeg)
  Concat avatar segments + source clips
  Burn newscast chrome overlay (Puppeteer PNG → FFmpeg overlay)
  Burn ticker at bottom
  Burn logo bug (bottom-right mug)
  Normalize audio levels
  │
  ▼
GATE 3a — Gemini Qualitative Assembly Review
  Watches EARLY/MIDDLE/LATE 20s samples (not full video)
  Checks: freeze, source clips visible, audio continuous, chrome visible
  Passes downstreamHeadsUp to Gate 3b and Gate 4
  Score ≥70 → pass | 60-69 → pass with notes | <60 → hard fail + targeted FFmpeg alarm
  │ PASS ↓
  ▼
GATE 3b — Claude Commitment Verification (Analytical)
  Does NOT watch video — reads Gate 3a report + Job Spec designSpec
  Checks: chrome skin, logo position, dimensions, aspect ratio, clip count, audio mix
  Mismatches → targeted re-assembly of specific fields (not HeyGen rollback)
  │ PASS ↓
  ▼
DRIVE UPLOAD
  Assembled video → Google Drive → driveUrl saved to Job Spec
  │
  ▼
GATE 4 — Gemini Full Video Broadcast Ready
  Watches COMPLETE assembled video (not samples)
  Reads ALL prior gate reports as context
  Checks: pacing end-to-end, audio quality full runtime, compounding issues, content accuracy, brand
  broadcastReady=true → uploadSignal=true → authorizes Gate 5
  Large files (>480MB): falls back to Gate 3a findings + ffprobe
  │ PASS + uploadSignal ↓
  ▼
GATE 5 — Upload Confirmation (Code only, no AI)
  Refuses to fire without gate4.uploadSignal === true (hard stop)
  Pre-publish validator: YouTube/TikTok/Instagram API limits checked, violations corrected
  Upload-Post API delivers to platforms as private drafts
  Per-platform retry (max 3), one platform fail does not stop others
  job_id confirmed per platform → job marked published
```

---

## Gate Workers — Who Does What

### Gate 0 — Gemini / ffprobe
**Single question:** Did we get what was ordered?
**How work is produced:** ffprobe probes source URLs for format, duration, reachability
**Three states:**
- `canProduce()`: GEMINI_API_KEY present? source items in Job Spec?
- `commit()`: "I will confirm N sources resolve, detect format, confirm title matches"
- `run()`: probe each source, return confirmedFormat (authoritative for all downstream)

**Fix approach:** Hard fail on any issue — no retry, fix the source

---

### Gate 1 — Claude (Style QA)
**Single question:** Does the script meet the committed style?
**How work is produced:** System generated scaffold → Gemini filled dialogue → Claude reviews
**Three states:**
- `canProduce()`: filled script in savedOutputs? Claude API key? style guide loaded?
- `commit()`: "I will verify voice, names, accuracy, outro. I will NOT check structure."
- `run()`: score style checks, build surgical fix directive if sendback needed

**Fix approach:** Score 70-89 → one sendback with exact fix directive (what scene, what's wrong, what to write instead). Score <70 → escalate with full fix directive. Gemini receives directive and rewrites specific scenes.

**QA agent knows:** How Gemini produced the script. What HeyGen needs (scene markers). That a surgical fix is success, a vague rejection is failure.

---

### Gate 2 — Code + ffprobe (Render Quality)
**Single question:** Are the renders production quality?
**How work is produced:** HeyGen rendered Bobby G speaking each scene
**Three states:**
- `canProduce()`: ffprobe available? segment paths exist? Gate 1 passed?
- `commit()`: "I will validate N segments — freeze, audio, framing for confirmed format"
- `run()`: ffprobe each segment, freeze detection, file size check

**Fix approach:** Code-only. Freeze or audio missing = hard fail, stop batch. No AI call.

---

### Gate 3a — Gemini (Qualitative Assembly)
**Single question:** Does the assembled video look right at 3 sample points?
**How work is produced:** FFmpeg assembled avatar segments + source clips + chrome overlay + ticker
**Three states:**
- `canProduce()`: assembled file exists >100KB? Gemini Files API available? Gate 2 passed?
- `commit()`: "I will watch EARLY/MIDDLE/LATE samples, check freeze/clips/audio/chrome"
- `run()`: extract 20s clips, upload to Gemini, analyze each, build findings + fix directive

**Fix approach:** Freeze → targeted FFmpeg alarm (not full re-assembly). Audio/chrome issues → fix directive to assembly with timestamp and nature of issue. Passes `downstreamHeadsUp` to Gate 4.

**QA agent knows:** Full 8-step production chain. How to write fix directives for FFmpeg. That Gate 4 watches the full video — Gate 3a is 3 samples only.

---

### Gate 3b — Claude (Commitment Verification)
**Single question:** Did assembly deliver what was committed?
**How work is produced:** Gate 3a qualitative findings + Job Spec designSpec
**Three states:**
- `canProduce()`: Gate 3a report available? designSpec has content?
- `commit()`: "I will verify chrome skin, logo position, dimensions, clip count, audio mix"
- `run()`: analytical comparison of designSpec vs Gate 3a findings. No video watch.

**Fix approach:** `mismatch_fixable` → targeted re-assembly of specific field. `mismatch_escalate` → human review.

---

### Gate 4 — Gemini (Broadcast Ready)
**Single question:** Is this video ready to air?
**How work is produced:** Complete assembled video after all prior gates passed
**Three states:**
- `canProduce()`: Gate 3b passed? assembled file accessible? Gemini available?
- `commit()`: "I will watch the complete video. My pass is the upload authorization."
- `run()`: upload full video to Gemini, evaluate pacing/audio/accuracy/brand end-to-end

**Fix approach:** `blockers` array must contain specific, actionable fixes with timestamps and instructions — not generic descriptions. Notes (non-blocking) surface to operator but don't block upload.

**QA agent knows:** Complete production chain from Gate 0 through assembly. That its pass = upload authorization. Standard: "would I be comfortable if this aired tonight?"

---

### Gate 5 — Code (Upload Confirmation)
**Single question:** Did upload succeed on all platforms?
**How work is produced:** Gate 4 issued uploadSignal
**Three states:**
- `canProduce()`: gate4.uploadSignal === true? Upload-Post API key? driveUrl saved?
- `commit()`: "I will deliver to [platforms] as private drafts and confirm job_id per platform"
- `run()`: pre-publish validator → Upload-Post API → poll for job_id confirmation

**Fix approach:** Pre-publish validator corrects metadata violations before upload (truncates, reformats). Per-platform retry max 3. One platform failure does not stop others.

---

## Inter-Gate Intelligence

Every gate from Gate 1 onward reads all prior gate reports before running. Each gate output includes:

```javascript
upstreamContext: {
  reviewedReports: ['gate0', 'gate1', ...],
  confirmedClean: ['gate0: format confirmed', 'gate2: all renders passed', ...],
  escalatedConcerns: [{ originGate, originalFlag, currentAssessment, severity, recommendedFix }],
  downstreamHeadsUp: 'one sentence for the next gate to watch for'
}
```

This turns the pipeline into a conversation, not a chain of independent checkpoints.

---

## Monitoring + Recovery

`lib/monitoring.js` listens to `pipelineBus` events:

| Signal | Action |
|---|---|
| Gate worker silent >10min | Log + escalate to Claude Code |
| QA sendback loop (2nd fail) | Escalate — commitment/architecture issue, not production |
| External API error | Attempt recovery, restore job from last clean gate |
| Gate hard fail | Run recovery decision tree |

**Recovery decision tree:**
1. Root cause fixable automatically → fix + restore from last clean gate
2. Root cause needs code change → log for Claude Code, job holds
3. Root cause unfixable → kill cleanly (mark failed, preserve all outputs, determine restart gate)

**Restart gate:** Walk `state.savedOutputs` and `state.gateResults`, find furthest gate that passed, restart from there. Same Job ID — prior gate outputs preserved.

---

## Customer Config System

One JSON file per customer: `config/customers/{customerId}.json`

Pipeline code reads customer config via `lib/customerConfig.js`:
- `loadCustomerConfig(customerId)` — resolves env vars, returns config
- `getGateThresholds(customerId, templateId, gate, defaults)` — per-gate pass/fail thresholds
- `getVoiceConfig(customerId, templateId)` — prohibitedWords, outroLine, speakerName

Gate workers never hardcode customer names. They read from Job Spec → customerConfig.

**Customer 1 onboarding:** Create `config/customers/c1.json`, fill in templates, providers, thresholds, voice rules. No gate code changes.

---

## Branch Status (2026-04-18)

Branch: `feature/gate-worker-system` — 20 commits ahead of main

All gate workers built, wired, tested in active jobs:
- ✅ Gate 0: built, wired, firing
- ✅ Gate 1: built, wired, firing (Claude + Gemini QA)
- ✅ Gate 2: built, wired, firing (replaced broken poller Gate 2)
- ✅ Gate 3a: built, wired, firing
- ✅ Gate 3b: built, wired, firing (reads designSpec when commitments empty)
- ✅ Gate 4: built, wired, firing (480MB fallback for large files)
- ✅ Gate 5: built, wired, fires on gate4.uploadSignal
- ✅ Scaffold: built, wired into script gen
- ✅ Monitoring: built, startMonitoring() called at server start
- ✅ customerConfig: universal threshold loading from customer JSON
- ✅ Semantic job IDs: COMPACT/EXTRACT + DIRECT/FETCH/GEN format
- ✅ Legacy Gate 6: removed (dead code comment)
- ✅ QA agent prompts: know how work was produced, fix directive approach, goal is passage not rejection

**Pending:** Merge to main after full production test cycle (News + Twitch + NBA + Short all passing Gate 5).
