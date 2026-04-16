# DASHBOARD_DECOUPLING_SPEC.md

**Status:** Design spec — not yet implemented  
**Date:** 2026-04-16  
**Author:** Claude Code  
**Target:** Phase 1.5 (before Railway deploy, after pipeline resilience lands)

---

## Problem Statement

The CWN dashboard (`cwn_production.html`) is currently a **stateful orchestrator**, not a display layer. It owns:

- The segment sequence (built by walking DOM rows)
- HeyGen polling (client-side interval, dies on tab close)
- Assembly trigger (client-side POST built from DOM state)
- Job state (localStorage as primary, server as secondary)
- Source clip tracking (DOM variables, lost on refresh)

Every production failure in the April 2026 smoke tests traced back to this coupling:
- Assembly ran with 0 clips because source clips were DOM state, not server state
- Assembly was killed because nodemon restart wiped in-memory jobs
- HeyGen poller stopped when the tab was backgrounded or refreshed
- Force-advance, rollback, refresh IDs were all manual buttons because the server had no autonomous drive

**The dashboard should be a terminal window, not a co-pilot.**

---

## Target Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    BROWSER (dashboard)                   │
│                                                         │
│  ┌─────────┐    ┌──────────────────────────────────┐   │
│  │ GENERATE│    │  READ-ONLY STATUS DISPLAY         │   │
│  │ button  │    │  - Job stage indicator            │   │
│  └────┬────┘    │  - Segment list + statuses        │   │
│       │         │  - Gate scores                    │   │
│       │         │  - Assembly log stream (SSE)      │   │
│       │         │  - Drive URL when done            │   │
│       │         └──────────────────────────────────┘   │
└───────┼─────────────────────────────────────────────────┘
        │ POST /generate-full-script
        ▼
┌─────────────────────────────────────────────────────────┐
│                    SERVER (node.js)                      │
│                                                         │
│  Pipeline State Machine                                  │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐            │
│  │ Script   │──▶│ HeyGen   │──▶│ Assembly │            │
│  │ Gen +    │   │ Submit + │   │ + Gate 3 │            │
│  │ Gate 1   │   │ Poll     │   │ + Drive  │            │
│  └──────────┘   └──────────┘   └──────────┘            │
│                                                         │
│  data/jobs.json — single source of truth                │
│  data/assembly_jobs.json — assembly state               │
│  logs/pipeline.log — structured Pino output             │
└─────────────────────────────────────────────────────────┘
```

---

## What Moves to the Server

### 1. Segment Sequence Ownership

**Current:** Dashboard builds `segmentData` by walking DOM rows at ASSEMBLE click time.

**Target:** Server builds the full segment sequence at Gate 1 pass time and saves it to `data/jobs.json`:

```javascript
// Saved to jobs.json at Gate 1 pass:
card.segmentSequence = buildSegmentSequence(script.scenes, orderedClipUrls);
// [
//   { type: 'avatar', sceneId: 'scene_01', label: 'scene 01' },
//   { type: 'avatar', sceneId: 'scene_02', label: 'scene 02' },
//   ...
//   { type: 'source_clip', label: 'STORY1_CLIP', clipUrl: '...', pageUrl: '...' },
//   ...
// ]
```

Dashboard reads `card.segmentSequence` from `GET /jobs` and renders it. It never builds the sequence itself.

### 2. HeyGen Polling

**Current:** `startHeyGenPoller()` called from dashboard JS, runs as `setInterval` in the browser tab. Tab close = polling stops.

**Target:** Server-side poller only. Dashboard SSE stream receives segment completion events.

```javascript
// Server emits via SSE when segment completes:
res.write(`data: ${JSON.stringify({ type: 'segment_complete', sceneId, videoId, url })}\n\n`);
```

Dashboard subscribes to `GET /jobs/:id/stream` (SSE) and updates segment status in real time. No polling logic in the browser at all.

### 3. Assembly Trigger

**Current:** ASSEMBLE button POSTs `segmentData` built from DOM.

**Target:** Server auto-triggers assembly when all avatar segments complete (poller detects). Dashboard has no ASSEMBLE button — it just watches the SSE stream update from `all_sent` → `assembling`.

Emergency manual trigger remains as curl only:
```bash
curl -X POST http://localhost:3000/job/:id/assemble
```

### 4. Job State Primary Store

**Current:** Dashboard writes to localStorage first, syncs to server second. On restore, server is treated as secondary.

**Target:** Server `data/jobs.json` is the only source of truth. Dashboard never writes to localStorage for pipeline state. On page load, dashboard calls `GET /jobs` and renders server state directly.

localStorage can still be used for UI preferences (column widths, sort order, display settings) — never for pipeline state.

### 5. Gate Transitions

**Current:** Gate transitions triggered by dashboard buttons (FORCE ADVANCE, ROLLBACK).

**Target:** Gate transitions are server-internal. Pipeline state machine in server.js owns all transitions. Dashboard displays current stage only.

Escape hatches remain as curl endpoints — removed from UI.

---

## New Server Endpoints Required

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `GET /jobs/:id/stream` | GET (SSE) | Real-time event stream for segment completion, gate scores, stage changes |
| `POST /jobs/:id/assemble` | POST | Manual assembly trigger (curl escape hatch only) |
| `GET /jobs/:id/sequence` | GET | Returns full `segmentSequence` array for a job |

---

## Dashboard After Decoupling

`cwn_production.html` becomes ~40% smaller. Remaining responsibilities:

**Reads (display only):**
- `GET /jobs` on load — render all job cards
- `GET /jobs/:id/stream` (SSE) — live updates per job
- `GET /assemble-progress/:asmId` — assembly log polling (or SSE)

**Writes (user-initiated only):**
- `POST /generate-full-script` — user clicks GENERATE
- `POST /publish` — user clicks PUBLISH (after reviewing assembled video)
- `POST /generate-thumbnail` — user clicks THUMBNAIL
- `POST /generate-publish-copy` — user clicks PUBLISH COPY
- `POST /cleanup` — user clicks CLEAR JOBS

**Removed from dashboard:**
- ASSEMBLE button
- REFRESH IDs button  
- FORCE ADVANCE button
- ROLLBACK button
- All segment sequence building logic
- All HeyGen polling intervals
- All localStorage pipeline state writes

---

## SSE Event Schema

```javascript
// Segment completed
{ type: 'segment_complete', jobId, sceneId, videoId, url, completedAt }

// Stage changed
{ type: 'stage_change', jobId, from, to, at }

// Gate scored
{ type: 'gate_score', jobId, gate, score, outcome, directive }

// Assembly progress
{ type: 'assembly_progress', jobId, asmId, pct, logLine }

// Assembly complete
{ type: 'assembly_complete', jobId, asmId, filename, gate3Score, driveUrl }

// Error
{ type: 'pipeline_error', jobId, gate, directive, reason, autoAction }
```

---

## Migration Strategy

Do not do this all at once. Incremental path:

**Phase A — Server owns sequence (ship with pipeline resilience):**
- `buildSegmentSequence()` runs server-side at Gate 1 pass
- `card.segmentSequence` saved to `jobs.json`
- Dashboard reads sequence from server on restore instead of rebuilding from DOM
- ASSEMBLE button still exists but reads `card.segmentSequence` from server instead of DOM

**Phase B — Server owns polling:**
- Move HeyGen poller fully to server
- Add SSE endpoint `GET /jobs/:id/stream`
- Dashboard subscribes to SSE for segment updates
- Remove client-side polling intervals

**Phase C — Server owns assembly trigger:**
- Auto-trigger assembly from server poller when all segments complete
- Remove ASSEMBLE button from UI
- Add curl escape hatch documentation to ops runbook

**Phase D — Full cleanup:**
- Remove REFRESH IDs, FORCE ADVANCE, ROLLBACK from UI
- Remove all localStorage pipeline state writes
- Dashboard is pure read + 5 write actions

**Each phase is independently shippable and testable.**

---

## Relationship to CLINE_HANDOFF_PIPELINE_RESILIENCE.md

The pipeline resilience handoff (Fixes 1–6) is the prerequisite for this spec. Specifically:

- Fix 1 (assembly persistence) enables Phase C
- Fix 2 (source clip persistence) is Phase A
- Fix 3 (auto-trigger) is Phase C
- Fix 4 (Pino logging) enables SSE event emission
- Fix 5 (gate directives) populates SSE `pipeline_error` events
- Fix 6 (dashboard cleanup) is Phase D

**Do pipeline resilience first. Then migrate phases A→D.**

---

## What This Unlocks

Once fully decoupled:

1. **Tab can be closed mid-run** — server drives the pipeline, browser just reconnects and reads current state via SSE
2. **Multiple operators** can watch the same job from different browsers simultaneously
3. **CLI monitoring** — `curl http://localhost:3000/jobs/:id/stream` streams live pipeline events to terminal
4. **Cloud deploy** — dashboard becomes a static file on CDN, server is the only thing that needs to be on Railway/Render
5. **Mobile monitoring** — any browser can watch a job in progress
6. **Automated test harness** — test scripts can POST generate, subscribe to SSE, assert gate scores without a browser
