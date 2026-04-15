# CLINE HANDOFF: Rollback / Force-Advance Gaps

**Agent:** Cline-B
**Priority:** HIGH — burning HeyGen credits on failed reassembly attempts
**Status:** READY — root causes identified

---

## Background

Rollback + Force-Advance shipped in `eac1073` for 3 stages. Three gaps remain that caused a real credit burn today: `scriptJobId` lost on restore, rollback overshooting, and no audit trail.

**Claude Code already shipped Fix 1 (frontend scriptJobId fallback) directly in `cwn_production.html`:**
- Line 1443: `job.id` added as final fallback for `jobId` in assemble payload
- Line 2958-2961: `job.id === resp.metricsJobId` used to find correct job card for scriptJobId save
- Duplicate scriptJobId block at lines 2965-2970 removed

---

## Gap 1 — `scriptJobId` not persisted to server job card

**Root cause:** `saveJobCard()` at `server.js:8504` saves the job card without `scriptJobId`. When the job is restored via `GET /jobs` → `restoreJobsFromServer()`, the restored card has no `scriptJobId`. After any page reload, `CURRENT_META` is cleared and the fallback chain fails.

**Fix — `server.js:8482` job card object:**

Add `scriptJobId` to the job card when it's first saved:

```javascript
const jobCard = {
  jobId,
  scriptJobId: jobId,   // ← ADD THIS LINE — same value, explicit field for restore path
  contentType: type,
  // ... rest of existing fields
};
```

**Also fix `restoreJobsFromServer()` in `cwn_production.html`** (~line 2096 area) — when building the restored job object from `serverJob`, ensure `scriptJobId` is mapped:

```javascript
// CURRENT (line ~2096):
id: serverJob.jobId,

// ADD after it:
scriptJobId: serverJob.scriptJobId || serverJob.jobId,
```

**Verification:** Start a fresh News job, complete Gate 1, reload the page, click RESTORE JOBS. The restored job card should have `scriptJobId` populated. Then click ASSEMBLE — `[assemble]` log should show `jobId: script_news_xxx` not `jobId: ""`.

---

## Gap 2 — Rollback overshoots: two clicks goes `assembled → script_ready` skipping `all_sent`

**Root cause:** The rollback endpoint steps back one stage per call, but `detectStage()` infers stage from card fields. After the first rollback (`assembled → all_sent`), the card still has `heygen.videoJobs` populated, so the second rollback correctly goes `all_sent → script_ready`. This is technically correct behavior — but operationally wrong because the operator just wanted to re-assemble, not re-send to HeyGen.

**Fix 1 — Add `card.stage` explicit write on every rollback/advance:**

The rollback endpoint should write `card.stage` explicitly after every transition so `detectStage()` is never consulted again for that card:

```javascript
// In POST /job/:id/rollback — after each transition block, add:
card.stage = 'all_sent';  // or 'script_ready' etc — whatever the target stage is
saveJobCard(jobId, card);
```

This is already partially done for `advance` (writes `gate1_forced` etc) but not consistently for `rollback`.

**Fix 2 — Dashboard confirmation copy must show both stages:**

In `rollbackJob()` in `cwn_production.html`, the `confirm()` dialog should show:

```
"Roll back from [assembled] → [all_sent]?
 This clears the assembly. You'll need to REFRESH IDs then ASSEMBLE again.
 (Click again to go back further to [script_ready])"
```

This makes it clear each click = one step, not a full reset.

**Verification:** Assemble a job. Click ROLLBACK once — confirm stage is `all_sent`, ASSEMBLE button reappears. Click ROLLBACK again — confirm stage is `script_ready`, SEND TO HEYGEN button reappears.

---

## Gap 3 — No audit trail for rollback/advance events

**Root cause:** `ROLLBACK_FORCE_ADVANCE_SPEC.md` specified audit logging to `logs/errors.jsonl` but it was never implemented.

**Fix — `server.js` rollback + advance endpoints:**

After each successful rollback, add:

```javascript
logError('PIPELINE_ROLLBACK', `Job rolled back: ${before} → ${after}`, {
  jobId, before, after, at: new Date().toISOString()
});
```

After each successful advance:

```javascript
logError('PIPELINE_ADVANCE', `Job force-advanced: ${before} → ${after}`, {
  jobId, before, after, at: new Date().toISOString()
});
```

`logError` is already imported from `lib/error_logger.js` — no new imports needed. The label `PIPELINE_ROLLBACK` / `PIPELINE_ADVANCE` is enough to filter in the logs.

**Verification:** Roll back a job. Check `logs/errors.jsonl` — should have a new entry with label `PIPELINE_ROLLBACK`.

---

## Gap 4 — Assembly dedup lock not cleared on rollback

**Root cause:** `_assemblyFiredForJob` in `cwn_production.html` is a frontend dedup lock that prevents double-assembly. It's set when ASSEMBLE is clicked and clears after 5 minutes. If assembly fails quickly (e.g. no segments) and the operator rolls back and tries again within 5 minutes, the lock blocks the second attempt silently.

**Fix — `cwn_production.html` rollback handler:**

After a successful rollback response, clear the dedup lock for that job:

```javascript
function rollbackJob(jobId) {
  // ... existing confirm + fetch ...
  .then(function(d) {
    if (d.ok) {
      delete _assemblyFiredForJob[jobId];  // ← ADD THIS
      // ... existing re-render logic
    }
  });
}
```

**Verification:** Trigger a failed assembly (no segments). Roll back. Immediately click ASSEMBLE again — should fire without the "duplicate call blocked" warning.

---

## Priority Order

1. **Gap 1** (scriptJobId persist) — directly prevents the credit burn
2. **Gap 4** (dedup lock clear) — unblocks immediate retry after failed assembly  
3. **Gap 2** (explicit stage write + confirm copy) — prevents overshoot confusion
4. **Gap 3** (audit trail) — visibility only, no operational impact

---

## Test After All Fixes

1. Start fresh News job → Gate 1 pass → HeyGen renders
2. Reload page → RESTORE JOBS → confirm `scriptJobId` present on restored card
3. Click ASSEMBLE → confirm `[assemble]` log shows correct `jobId` (not empty)
4. If assembly fails → ROLLBACK once → confirm stage = `all_sent` (not `script_ready`)
5. ASSEMBLE again immediately → confirm dedup lock doesn't block
6. Check `logs/errors.jsonl` for `PIPELINE_ROLLBACK` entry
