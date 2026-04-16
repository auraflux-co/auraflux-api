# CLINE_HANDOFF_PIPELINE_RESILIENCE.md

**Assigned to:** Cline-A (Claude Sonnet 4.6)  
**Priority:** CRITICAL — blocks all production runs  
**Date:** 2026-04-16  
**Scope:** server.js, lib/assembly.js, lib/qa.js, cwn_production.html  

---

## Why This Exists

Every News long-form smoke test run has required 8–12 manual button clicks and produced either a broken video or no video at all. Root causes identified across 3 test runs:

1. Assembly jobs live only in memory — nodemon restart kills them mid-run
2. Source clip segments (type: `source_clip`) are not persisted in `data/jobs.json` — restore reconstructs only avatar segments, assembly runs with 0 clips
3. HeyGen poller completes but does not auto-trigger assembly — human must click ASSEMBLE
4. Gate 3 never ran on this session's run — assembly was killed by restart before FFmpeg finished
5. Logging is raw `console.log` — no levels, no structure, no gate-specific directives when failures occur
6. QA gates report scores but don't emit actionable directives — the code has no way to self-heal

**HeyGen credits burned due to these failures: ~1500 scenes across repeated runs**

---

## Failures To Fix — In Priority Order

---

### Fix 1: Persist Assembly Job State to Disk (CRITICAL)

**Problem:** `assemblyJobs` in `lib/assembly.js` is a plain in-memory object. When nodemon restarts mid-assembly (file watch, crash, manual touch), the job is gone. No resume, no retry, no record.

**Fix:**
- On every `assemblyJobs[asmId]` mutation, write the job state to `data/assembly_jobs.json` (same pattern as `data/jobs.json` / `saveJobCard`)
- On server startup, load `data/assembly_jobs.json` into `assemblyJobs`
- Jobs in `status: 'assembling'` at load time should be marked `status: 'interrupted'` with a log entry — they cannot resume (FFmpeg is gone) but the state should be visible
- Jobs older than 24h should be pruned on load
- `data/assembly_jobs.json` must be gitignored (already covered by `data/` gitignore pattern — verify)

**Key fields to persist per job:**
```javascript
{
  asmId, status, pct, log, outputPath, filename,
  gate2Score, gate2Outcome, gate3Score, gate3Outcome,
  startedAt, completedAt, contentType, formType,
  segmentCount, clipCount
}
```

Do NOT persist the full `log` string on every update — it can grow to 50KB. Write log on completion or failure only.

---

### Fix 2: Persist Source Clip Segments in jobs.json (CRITICAL)

**Problem:** When a job card is saved to `data/jobs.json` via `saveJobCard()`, only HeyGen avatar segments are stored. The 3 `source_clip` scenes (type: `source_clip` in the script JSON) are built client-side from `orderedClipUrls` and never written to disk. After restore, the dashboard rebuilds 14 avatar rows but drops the 3 clip rows — assembly runs avatar-only.

**Evidence from this run:**
- Script had 17 scenes: 14 avatar + 3 `source_clip` (scenes 04, 09, 14)
- `orderedClipUrls` array in job card has 3 Brightcove HLS entries
- Dashboard showed "14 avatar + 0 clips" after restore
- Assembled video was avatar-only — Gate 3 would have reviewed a clipless cut

**Fix — two parts:**

**Part A: Save source_clip segments to jobs.json**

In `saveJobCard()` (server.js), when the script contains `source_clip` scenes, build segment entries from `orderedClipUrls` and store them alongside avatar segments:

```javascript
// When saving job card with script + orderedClipUrls:
const sourceClipSegments = (card.orderedClipUrls || []).map((clip, i) => ({
  type: 'source_clip',
  label: clip.label || `STORY${i+1}_CLIP`,
  clipUrl: clip.clipUrl || clip.url,
  pageUrl: clip.pageUrl || '',
  storyIndex: clip.storyIndex,
  status: 'ready'  // source clips don't render via HeyGen
}));
card.sourceClipSegments = sourceClipSegments;
```

**Part B: Restore source_clip rows in dashboard**

In `restoreJobsFromServer()` (cwn_production.html), after rebuilding avatar segment rows from the job card, also insert `source_clip` rows at the correct positions using `card.sourceClipSegments` and the script's scene order:

- Walk `script.scenes` array
- For each scene with `type: 'source_clip'`, find the matching `sourceClipSegments` entry by `label` or `storyIndex`
- Insert it at the correct position in the segment list
- Mark it `status: 'ready'` (not `rendering`) — source clips don't need HeyGen

---

### Fix 3: Auto-Trigger Assembly When All Segments Complete

**Problem:** HeyGen poller (`startHeyGenPoller`) completes and marks all segments done, but nothing triggers assembly. Human must click ASSEMBLE. This is a manual step that can be missed, especially after a page restore.

**Fix — server-side auto-trigger:**

In `startHeyGenPoller()` (server.js), after marking the last segment complete:

```javascript
// After all avatar segments are completed:
const allDone = card.segments.every(s => s.status === 'completed');
if (allDone && card.sourceClipSegments) {
  // Auto-trigger assembly
  const asmId = `asm_${Date.now()}`;
  const segmentData = buildSegmentSequence(card); // interleaves avatar + source_clip by scene order
  triggerAssembly({ asmId, segmentData, contentType: card.contentType, jobId: card.jobId });
  saveJobCard(card.jobId, { ...card, asmId, stage: 'assembling' });
  console.log(`[poller] All segments complete — auto-triggering assembly ${asmId}`);
}
```

`buildSegmentSequence()` should walk `script.scenes` in order, inserting:
- Avatar segments by matching `scene.id` → `card.segments[].sceneId`
- Source clip segments by matching `scene.type === 'source_clip'` → `card.sourceClipSegments[]`

This produces the correct interleaved sequence without human coordination.

**Dashboard impact:** The ASSEMBLE button becomes a secondary fallback (visible but not primary). The primary flow is server-driven.

---

### Fix 4: Structured Logging with Pino

**Problem:** All logging is raw `console.log`. No levels, no structure, no filtering. Gate failures don't emit actionable directives. Impossible to grep for specific failure modes or build automated remediation.

**Fix:** Replace `console.log/warn/error` with Pino.

**Install:**
```bash
npm install pino pino-pretty
```

**Setup in server.js (top-level):**
```javascript
const pino = require('pino');
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' } }
    : undefined
});
```

**Log levels to use:**
- `logger.info()` — normal pipeline progress (segment submitted, gate passed)
- `logger.warn()` — soft failures (HLS transcode fallback, Gate 2 manual review)
- `logger.error()` — hard failures (Gate hard fail, FFmpeg crash, missing file)
- `logger.debug()` — verbose internals (only in development, LOG_LEVEL=debug)

**Gate failure directives — emit structured objects:**
```javascript
// When Gate 1 fails:
logger.error({
  gate: 1,
  score: score,
  jobId: jobId,
  directive: 'REGENERATE_SCRIPT',
  reason: qaResult.failReasons,
  autoAction: 'rollback_to_start'
});

// When assembly clip missing:
logger.error({
  gate: 'assembly',
  jobId: jobId,
  directive: 'FETCH_SOURCE_CLIPS',
  missingClips: missingLabels,
  autoAction: 'rebuild_segment_sequence'
});

// When Gate 3 fails:
logger.error({
  gate: 3,
  score: score,
  jobId: jobId,
  directive: score >= 50 ? 'RETRY_ASSEMBLY' : 'ROLLBACK_TO_HEYGEN',
  reason: qaResult.failReasons
});
```

**All lib/ modules** (assembly.js, qa.js, script_gen.js, publish.js) should import the logger from a shared module:
```javascript
// lib/logger.js
const pino = require('pino');
module.exports = pino({ level: process.env.LOG_LEVEL || 'info' });
```

```javascript
// In each lib/ module:
const logger = require('./logger');
```

---

### Fix 5: QA Gate Self-Healing Directives

**Problem:** Gates score and pass/fail but don't tell the pipeline what to do next. The pipeline stalls and waits for a human.

**Fix — per-gate auto-action logic:**

**Gate 1 (Script QA, score ≥90 pass):**
- Score ≥90: auto-proceed to HeyGen submission
- Score 70–89: log `directive: MANUAL_REVIEW`, save to `data/jobs.json`, emit structured log, pause pipeline (human reviews)
- Score <70: log `directive: REGENERATE_SCRIPT`, auto-rollback job to `start`, re-trigger `/generate-full-script` (max 1 auto-retry)

**Gate 2 (HeyGen segment QA, score ≥85 pass):**
- Score ≥85: auto-proceed to assembly trigger
- Score 65–84: log `directive: MANUAL_REVIEW`, flag specific segments, continue assembly with warning
- Score <65: log `directive: RERENDER_SEGMENTS`, identify failed segment IDs, re-submit those segments to HeyGen only (not full re-render)

**Gate 3 (Assembly QA, score ≥70 pass):**
- Score ≥70: auto-upload to Drive
- Score 60–69: log `directive: MANUAL_REVIEW`, upload anyway but flag for review
- Score <60 and missing clips detected: log `directive: RETRY_ASSEMBLY_WITH_CLIPS`, re-trigger assembly with rebuilt segment sequence
- Score <60 other: log `directive: ROLLBACK_TO_HEYGEN`, step back to `all_sent` stage

**Implementation:** Add `autoAction()` function in `lib/qa.js` that takes gate number + score + context, returns `{ action, directive, reason }`. Called after every gate evaluation.

---

### Fix 6: Dashboard Becomes Read-Only Monitor

**Problem:** ASSEMBLE, REFRESH IDs, FORCE ADVANCE, ROLLBACK are all buttons that require human attention. These are escape hatches that became the primary flow.

**Fix:**
- Remove ASSEMBLE button — assembly auto-triggers from poller (Fix 3)
- Remove REFRESH IDs button — poller handles ID collection internally
- Keep FORCE ADVANCE as curl-only escape hatch (remove from UI, document in ops runbook)
- Keep ROLLBACK as curl-only escape hatch (remove from UI)
- Dashboard shows: pipeline stage indicator, per-segment status, gate scores, log stream
- Dashboard primary actions: **GENERATE** only (+ CLEAR JOBS, PUBLISH when ready)

**Curl escape hatches (documented in ops runbook):**
```bash
# Force advance stuck job
curl -X POST http://localhost:3000/job/:id/advance

# Rollback job one stage
curl -X POST http://localhost:3000/job/:id/rollback

# Manual assembly trigger (emergency)
curl -X POST http://localhost:3000/assemble -H "Content-Type: application/json" \
  -d '{"asmId":"asm_manual","segments":[...],"contentType":"news"}'
```

---

## Implementation Order

Do these in order — each fix depends on the previous:

1. **Fix 4 first** — Pino logging. Everything else will use it. Low risk, high payoff.
2. **Fix 1** — Assembly job persistence. Stops losing in-flight jobs on restart.
3. **Fix 2** — Source clip persistence. Stops avatar-only assembly.
4. **Fix 3** — Auto-trigger assembly from poller. Removes ASSEMBLE button dependency.
5. **Fix 5** — Gate self-healing directives. Removes force-advance dependency.
6. **Fix 6** — Dashboard cleanup. Remove buttons after server-side automation is proven.

---

## Files Affected

| File | Changes |
|------|---------|
| `lib/logger.js` | NEW — shared Pino logger module |
| `server.js` | Pino setup, poller auto-trigger, gate auto-action calls |
| `lib/assembly.js` | Disk persistence for assemblyJobs, structured logging |
| `lib/qa.js` | `autoAction()` function, structured gate failure logs |
| `lib/script_gen.js` | Pino import, structured logging |
| `lib/publish.js` | Pino import, structured logging |
| `cwn_production.html` | Restore source_clip segments, remove ASSEMBLE/REFRESH buttons |
| `data/assembly_jobs.json` | NEW runtime file (gitignored) |

---

## Test Checklist

After implementation, run a News long-form job and verify:

- [ ] Gate 1 passes → HeyGen submission starts automatically (no button)
- [ ] All HeyGen segments complete → assembly starts automatically (no ASSEMBLE button)
- [ ] Assembly includes source clips (14 avatar + 3 clips, not 14 + 0)
- [ ] Nodemon restart mid-assembly → job marked `interrupted` in dashboard, not lost
- [ ] Gate 3 passes → Drive upload starts automatically
- [ ] Gate 3 fails → directive logged, auto-action taken (retry or rollback)
- [ ] Page refresh → full 17-segment sequence restored (14 avatar + 3 source_clip)
- [ ] Pino logs show structured JSON with gate, score, directive fields
- [ ] No manual buttons pressed between Generate and Publish

---

## Do NOT

- Do not remove the `/job/:id/rollback` and `/job/:id/advance` API endpoints — keep as curl escape hatches
- Do not auto-retry Gate 1 more than once — infinite loops burn HeyGen credits
- Do not persist the full assembly log string on every update — write on completion only
- Do not touch `generateNewscastOverlay()` or FFmpeg filter chains — out of scope
