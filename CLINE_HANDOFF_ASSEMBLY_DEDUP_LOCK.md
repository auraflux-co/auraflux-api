# CLINE_HANDOFF_ASSEMBLY_DEDUP_LOCK.md
→ Agent: Cline-A

**Author:** Claude Code, 2026-04-14
**Size:** S — server.js only, Tier 1
**Priority:** 🚨 SHIP BEFORE NEXT SMOKE TEST — Rob is burning HeyGen credits on duplicate assembly runs
**Problem:** Auto-advance fires `/assemble` 3 times for the same job. Each call gets a unique `asmId` (asm_timestamp), so no dedup logic triggers. Three FFmpeg processes run simultaneously, all writing to overlapping tmp files, all crash each other. No output, wasted credits.
**Root cause confirmed:** Three Gate 2 QA files in `output/qa_failures/` from the same test run with job IDs: `batch_1776214115100`, `asm_1776214429562`, `asm_1776214260241` — all fired within 60 seconds.
**1 commit.**

---

## The Fix — Server-Side Assembly Lock

The `/assemble` endpoint at `server.js:3468` accepts `jobId` (the script job ID, e.g. `script_news_1776214115100`) in `req.body` as `assemblyJobId`. This is the stable identifier across all three duplicate calls — they all have the same `assemblyJobId`.

Add a dedup check at `server.js:3493` (after `segsToProcess` validation, before `asmId` assignment):

### Add at `server.js:3493` — after the `segsToProcess.length` check, before `const asmId = ...`

**Current (`server.js:3490-3494`):**
```javascript
  if (!segsToProcess.length) {
    return res.status(400).json({ error: 'No segments provided' });
  }

  const asmId = assemblyId || ('asm_' + Date.now());
```

**Target:**
```javascript
  if (!segsToProcess.length) {
    return res.status(400).json({ error: 'No segments provided' });
  }

  // ── Assembly dedup lock ────────────────────────────────────────────────────
  // Prevents auto-advance race condition: if 3 /assemble calls fire for the
  // same jobId within seconds (confirmed smoke test 11, 2026-04-14), each
  // gets a unique asm_timestamp asmId — no existing guard caught duplicates.
  // Fix: check assemblyJobId (stable script job ID) against active assemblies.
  if (assemblyJobId) {
    const alreadyRunning = Object.values(assemblyJobs).some(job =>
      job.sourceJobId === assemblyJobId && job.status === 'running'
    );
    if (alreadyRunning) {
      console.warn(`[assemble] Duplicate /assemble rejected for jobId=${assemblyJobId} — assembly already running`);
      return res.status(409).json({ error: 'Assembly already in progress for this job', jobId: assemblyJobId });
    }
  }

  const asmId = assemblyId || ('asm_' + Date.now());
```

### Also: store `sourceJobId` on the assembly job at `server.js:3495`

**Current:**
```javascript
  assemblyJobs[asmId] = {
    pct: 0,
    log: '',
    status: 'running',
    outputPath: null,
    sceneTextMap: sceneTextMap || null,
    fullScript: fullScript || null
```

**Target:**
```javascript
  assemblyJobs[asmId] = {
    pct: 0,
    log: '',
    status: 'running',
    outputPath: null,
    sourceJobId: assemblyJobId || null,   // dedup lock key
    sceneTextMap: sceneTextMap || null,
    fullScript: fullScript || null
```

---

## Also Fix: Dashboard Auto-Advance Firing Multiple Times

The server fix stops duplicate assemblies from running, but the dashboard is still sending 3 `/assemble` requests. Check `cwn_production.html` for `assembleJob` calls in the auto-advance path and add a guard so it only fires once per job.

Search for: `grep -n "_autoAssembleFired\|assembleJob\|auto-advance" cwn_production.html`

The guard `_autoAssembleFired` should be set to `true` on the `batchJob` object BEFORE the `assembleJob()` call, not after. If it's set after (or inside a callback), a race allows multiple calls before the guard is checked.

**Pattern to enforce:**
```javascript
if (batchJob._autoAssembleFired) return;
batchJob._autoAssembleFired = true;  // set BEFORE the call
assembleJob(batchJob.id);
```

If the guard is already structured this way but still fires 3 times, the issue is that `batchJob` reference is being looked up fresh each time (e.g. via `JOBS.find()`) rather than using a closure reference — meaning each of the 3 callbacks gets a different object snapshot where `_autoAssembleFired` is still false.

Fix: use a module-level `Set` instead of a per-object flag:
```javascript
// At top of script (module level, outside any function):
var _assemblyFiredForJob = {};

// In the auto-advance completion handler:
if (_assemblyFiredForJob[batchJob.id]) return;
_assemblyFiredForJob[batchJob.id] = true;
assembleJob(batchJob.id);
```

---

## Verification

```bash
node -c server.js

# Simulate duplicate: send two /assemble calls for the same jobId
# First should succeed (200), second should return 409
curl -s -X POST http://localhost:3000/assemble \
  -H "Content-Type: application/json" \
  -d '{"segments":["http://test"],"segmentData":[],"contentType":"news","jobId":"test_job_123"}' &

curl -s -X POST http://localhost:3000/assemble \
  -H "Content-Type: application/json" \
  -d '{"segments":["http://test"],"segmentData":[],"contentType":"news","jobId":"test_job_123"}'
# Second call should return: {"error":"Assembly already in progress for this job","jobId":"test_job_123"}
```

Also verify: after a successful assembly completes (`status: 'done'`), a new `/assemble` call for the same `jobId` should be allowed (for rollback + re-assemble scenario). The lock only blocks `status === 'running'`.

---

## Commit Message

```
fix(assembly): add server-side dedup lock to prevent duplicate assembly runs

Smoke test 11 (2026-04-14) confirmed auto-advance fired /assemble 3 times
for the same job within 60s. Each call got a unique asm_timestamp asmId —
no existing guard caught duplicates. Three FFmpeg processes ran simultaneously,
all writing to overlapping tmp files, all crashed silently. No output, wasted
HeyGen credits.

Server fix:
- /assemble endpoint checks assemblyJobId against active assemblyJobs
- If sourceJobId matches a running assembly → 409 Conflict, log warning
- assemblyJobs[asmId].sourceJobId = assemblyJobId for dedup lookup

Dashboard fix:
- _autoAssembleFired guard moved to module-level _assemblyFiredForJob{}
  so closure/object-reference races can't bypass it

Two-layer: server rejects duplicates even if dashboard sends them.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

---

## Ship Order

```
node -c server.js
→ make server.js changes
→ make cwn_production.html changes
→ node -c server.js
→ git add server.js cwn_production.html STATUS.md && git commit
→ push
→ THEN run next smoke test
```
