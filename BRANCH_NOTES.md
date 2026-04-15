# Branch Notes — cline-b/gate3-autopublish-fix

**Agent:** Cline-B (Claude Sonnet — switched for this task)
**Branch:** `cline-b/gate3-autopublish-fix`
**Date opened:** 2026-04-15
**Status:** 🟡 READY — 2 targeted server.js fixes

---

## CRITICAL — Shell rule

**Every grep/find/rg/ls must end with `|| true`. No exceptions.**

---

## Context

Every video assembled April 15 completed FFmpeg but never uploaded to Drive or published.
Gate 3 QA was throwing errors (Gemini timeout/upload error). The error fallback set
`passed: false` which silently blocked Gate 6 auto-publish. Also `finalizeJobMetrics()`
was called before Gate 3, so QA stage never appeared in run_metrics files.

---

## TASK 1 — Fix Gate 3 error fallback

**File:** `server.js`

**Find it:**
```bash
grep -n "manual_review\|passed: false\|MAX_QA_RETRIES" server.js || true
```
Look for the `else` block after `MAX_QA_RETRIES` attempts (~line 5251).

**Current (WRONG):**
```javascript
qaResult = { score: 70, outcome: 'manual_review', passed: false, report: `QA check failed: ${qaErr.message}` };
assemblyJobs[asmId].qaOutcome = 'manual_review';
```

**Fix:**
```javascript
log(asmId, `⚠️  Gate 3 QA errored after ${MAX_QA_RETRIES} attempts — treating as PASS to unblock Drive + publish`);
logError('GATE3_QA_ERROR_FALLBACK', `Gate 3 QA errored ${MAX_QA_RETRIES}x — auto-passed: ${qaErr.message}`, { asmId });
qaResult = { score: 70, outcome: 'pass', passed: true, report: `QA check errored: ${qaErr.message} (auto-passed)` };
assemblyJobs[asmId].qaScore = 70;
assemblyJobs[asmId].qaOutcome = 'pass';
assemblyJobs[asmId].qaNote = 'Gate 3 errored — auto-passed, manual review recommended';
assemblyJobs[asmId].qaRetryAttempts = qaAttempt;
```

**Commit:** `fix(gate3): error fallback sets passed=true + logError (unblocks Gate 6)`

---

## TASK 2 — Move finalizeJobMetrics() after Gate 3

**File:** `server.js`

**Find current location:**
```bash
grep -n "finalizeJobMetrics" server.js || true
```

**Step 1:** Remove the call at ~line 5164 (before Gate 3).

**Step 2:** Add Gate 3 timer AFTER the Gate 3 loop completes, before the Drive upload:
```javascript
const gate3Timer = new StageTimer(asmId, 'Gate 3 QA');
gate3Timer.addData('score', qaResult?.score || 0)
  .addData('outcome', qaResult?.outcome || 'error')
  .addData('retryAttempts', assemblyJobs[asmId].qaRetryAttempts || 0);
addStageMetrics(asmId, gate3Timer.end());

finalizeJobMetrics(asmId);  // MOVED here from before Gate 3
```

Find the right insertion point (~line 5275):
```bash
grep -n "SKIP_DRIVE_UPLOAD\|Auto-upload to Google Drive\|Step 8" server.js || true
```
Place the timer + finalizeJobMetrics right before that block.

**Commit:** `fix(metrics): move finalizeJobMetrics after Gate 3 so QA stage appears in run_metrics`

---

## Log

| Time | Entry |
|------|-------|
| 2026-04-15 EOD | Branch opened. 2 targeted server.js fixes. |
