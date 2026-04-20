# CLINE-A SESSION START INSTRUCTIONS

**Date:** 2026-04-16  
**Assigned to:** Cline-A (Claude Sonnet 4.6)  
**Session Goal:** Continue CLINE_HANDOFF_PIPELINE_RESILIENCE.md — Fix 1 (assembly job persistence), then Fixes 2, 3, 5, 6 in order

---

## Session Start Command

```
Read CLAUDE.md and STATUS.md — continue CLINE_HANDOFF_PIPELINE_RESILIENCE.md, Fix 1 remaining (add saveAssemblyJob at all 20+ mutation points + export), then Fix 2, 3, 5, 6 in order.
```

---

## Context Summary

You are implementing **6 critical pipeline resilience fixes** to stop losing jobs mid-assembly and eliminate manual button clicks. The handoff document is `docs/handoffs/CLINE_HANDOFF_PIPELINE_RESILIENCE.md`.

**Root problem:** Every News long-form smoke test requires 8–12 manual clicks and produces broken/missing videos. ~1500 HeyGen scenes burned due to these failures.

**Current state:**
- Fix 4 (Pino logging) — **NOT STARTED** (do this first per implementation order)
- Fix 1 (assembly job persistence) — **PARTIALLY STARTED** (needs completion)
- Fix 2 (source clip persistence) — **NOT STARTED**
- Fix 3 (auto-trigger assembly) — **NOT STARTED**
- Fix 5 (gate self-healing) — **NOT STARTED**
- Fix 6 (dashboard read-only) — **NOT STARTED**

---

## Fix 1 Status: Assembly Job Persistence

**What's needed:** Persist `assemblyJobs` object to `data/assembly_jobs.json` on every mutation, load on startup.

**Search results show 75 mutation points in lib/assembly.js** where `assemblyJobs[asmId]` is written to. These include:

### Critical mutations found:
1. Initial job creation (`assemblyJobs[asmId] = { pct: 0, ... }`)
2. Status changes (`status = 'failed'`, `'done'`, `'ffmpeg_done'`, `'manual_review'`)
3. Progress updates (`pct = 0-100`)
4. Gate scores (`gate2Score`, `gate2Outcome`, `gate3Score`, `qaScore`, `qaOutcome`)
5. Output paths (`outputPath`, `filename`, `driveUrl`, `thumbFrame`)
6. Error states (`error`, `gate2Error`, `gate6Error`)
7. Metadata (`duration`, `sizeMB`, `segmentDurations`, `publishResult`)

**Implementation needed:**

### Part A: Create `saveAssemblyJob()` function
```javascript
// In lib/assembly.js, after assemblyJobs declaration

const ASSEMBLY_JOBS_FILE = path.join(__dirname, '..', 'data', 'assembly_jobs.json');

function saveAssemblyJob(asmId) {
  if (!assemblyJobs[asmId]) return;
  
  try {
    // Read existing file
    let allJobs = {};
    if (fs.existsSync(ASSEMBLY_JOBS_FILE)) {
      const raw = fs.readFileSync(ASSEMBLY_JOBS_FILE, 'utf8');
      allJobs = JSON.parse(raw);
    }
    
    // Update this job (exclude large log field — write only on completion)
    const jobToSave = { ...assemblyJobs[asmId] };
    if (jobToSave.status !== 'done' && jobToSave.status !== 'failed') {
      delete jobToSave.log; // Don't persist 50KB log on every update
    }
    
    allJobs[asmId] = jobToSave;
    
    // Prune jobs older than 24h
    const now = Date.now();
    Object.keys(allJobs).forEach(id => {
      const job = allJobs[id];
      const age = now - (job.startedAt || 0);
      if (age > 24 * 60 * 60 * 1000) {
        delete allJobs[id];
      }
    });
    
    // Write atomically
    fs.writeFileSync(ASSEMBLY_JOBS_FILE, JSON.stringify(allJobs, null, 2), 'utf8');
  } catch (err) {
    console.error(`[saveAssemblyJob] Failed to persist ${asmId}:`, err.message);
  }
}
```

### Part B: Load on startup
```javascript
// In lib/assembly.js, after assemblyJobs declaration

function loadAssemblyJobs() {
  if (!fs.existsSync(ASSEMBLY_JOBS_FILE)) return;
  
  try {
    const raw = fs.readFileSync(ASSEMBLY_JOBS_FILE, 'utf8');
    const loaded = JSON.parse(raw);
    
    Object.keys(loaded).forEach(asmId => {
      const job = loaded[asmId];
      
      // Mark interrupted jobs
      if (job.status === 'assembling') {
        job.status = 'interrupted';
        job.interruptedAt = Date.now();
        console.log(`[assembly] Job ${asmId} was interrupted — marked as interrupted`);
      }
      
      assemblyJobs[asmId] = job;
    });
    
    console.log(`[assembly] Loaded ${Object.keys(loaded).length} assembly jobs from disk`);
  } catch (err) {
    console.error('[assembly] Failed to load assembly jobs:', err.message);
  }
}

// Call on module load
loadAssemblyJobs();
```

### Part C: Add `saveAssemblyJob(asmId)` after EVERY mutation

**You must add `saveAssemblyJob(asmId);` after each of these 75+ mutation points:**

1. After initial job creation
2. After every `assemblyJobs[asmId].status = ...`
3. After every `assemblyJobs[asmId].pct = ...` (but throttle — only save on 10% increments)
4. After every gate score assignment
5. After every error assignment
6. After outputPath/driveUrl/filename assignments
7. After publishResult/gate6Status assignments

**Throttling strategy for pct updates:**
```javascript
// Only save on 10% increments to reduce disk I/O
if (pct % 10 === 0 || pct === 100) {
  saveAssemblyJob(asmId);
}
```

### Part D: Export the function
```javascript
// At bottom of lib/assembly.js
module.exports = {
  handleAssemble,
  assemblyJobs,
  TICKER_CACHE,
  TICKER_MAP,
  saveAssemblyJob  // ADD THIS
};
```

### Part E: Verify gitignore
```bash
# Verify data/assembly_jobs.json is gitignored
grep -n "data/" .gitignore
# Should show: data/ is already ignored
```

---

## Implementation Order (from handoff doc)

**Do these in order — each depends on the previous:**

1. ✅ **Fix 4 first** — Pino logging (install pino + pino-pretty, create lib/logger.js, replace console.log)
2. **Fix 1** — Assembly job persistence (add saveAssemblyJob at all 75 mutation points)
3. **Fix 2** — Source clip persistence (save sourceClipSegments in jobs.json, restore in dashboard)
4. **Fix 3** — Auto-trigger assembly from poller (remove ASSEMBLE button dependency)
5. **Fix 5** — Gate self-healing directives (auto-retry/rollback logic)
6. **Fix 6** — Dashboard cleanup (remove manual buttons, curl-only escape hatches)

---

## Files You'll Touch

| File | Changes |
|------|---------|
| `lib/logger.js` | **NEW** — shared Pino logger module (Fix 4) |
| `lib/assembly.js` | Disk persistence, saveAssemblyJob(), loadAssemblyJobs(), Pino imports |
| `lib/qa.js` | autoAction() function, structured gate failure logs, Pino imports |
| `lib/script_gen.js` | Pino imports, structured logging |
| `lib/publish.js` | Pino imports, structured logging |
| `server.js` | Pino setup, poller auto-trigger, gate auto-action calls |
| `cwn_production.html` | Restore source_clip segments, remove ASSEMBLE/REFRESH buttons |
| `data/assembly_jobs.json` | **NEW** runtime file (gitignored) |
| `package.json` | Add pino + pino-pretty dependencies |

---

## Test Checklist (After All 6 Fixes)

Run a News long-form job and verify:

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

## DO NOT

- Do not remove `/job/:id/rollback` and `/job/:id/advance` API endpoints — keep as curl escape hatches
- Do not auto-retry Gate 1 more than once — infinite loops burn HeyGen credits
- Do not persist the full assembly log string on every update — write on completion only
- Do not touch `generateNewscastOverlay()` or FFmpeg filter chains — out of scope

---

## Quick Reference: 75 Mutation Points Found

Search results show `assemblyJobs[asmId]` is mutated at these operations:

**Status changes (8):**
- `status = 'failed'` (4 locations)
- `status = 'done'` (2 locations)
- `status = 'ffmpeg_done'` (1 location)
- `status = 'manual_review'` (1 location)

**Progress updates (5):**
- `pct = 0-100` (5 locations with calculations)

**Gate 2 fields (7):**
- `gate2Score`, `gate2Outcome`, `gate2FailedSegments`, `gate2RetryAttempts`, `gate2Error`, `topazEnhancedSegments`, `heygenReRenderAvailable`

**Gate 3/QA fields (9):**
- `qaScore`, `qaReport`, `qaOutcome`, `qaRetryAttempts`, `qaNote`, `topazEnhanced`, `topazRequestID`

**Output fields (7):**
- `outputPath`, `filename`, `duration`, `sizeMB`, `thumbFrame`, `thumbFilename`, `segmentDurations`

**Drive/Publish fields (7):**
- `driveUrl`, `thumbDriveUrl`, `publishCopy`, `gate6Status`, `publishResult`, `publishRequestId`, `publishJobId`

**Error fields (3):**
- `error`, `gate6Error`

**Metadata (4):**
- `sceneTextMap`, `fullScript`, `tickerPct`

**Total: 50+ unique field assignments across 75+ mutation operations**

---

## Next Steps

1. Read `docs/handoffs/CLINE_HANDOFF_PIPELINE_RESILIENCE.md` in full
2. Start with Fix 4 (Pino logging) — install dependencies, create lib/logger.js
3. Then complete Fix 1 — add saveAssemblyJob() at all 75 mutation points
4. Continue with Fixes 2, 3, 5, 6 in order
5. Run test checklist on a News long-form job
6. Update STATUS.md when complete

---

## Lock Declaration

Before starting, add this to STATUS.md → `🔒 Active File Locks`:

```markdown
| lib/assembly.js | Cline-A | CLINE_HANDOFF_PIPELINE_RESILIENCE.md Fixes 1-6 | 2026-04-16 [TIME] ET |
| lib/qa.js | Cline-A | CLINE_HANDOFF_PIPELINE_RESILIENCE.md Fix 5 | 2026-04-16 [TIME] ET |
| server.js | Cline-A | CLINE_HANDOFF_PIPELINE_RESILIENCE.md Fix 3 | 2026-04-16 [TIME] ET |
```

---

**Good luck! This is critical infrastructure work. Take your time, test thoroughly, and update STATUS.md when each fix is complete.**
