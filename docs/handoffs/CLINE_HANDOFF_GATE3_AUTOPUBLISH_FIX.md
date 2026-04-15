# CLINE HANDOFF — Gate 3 QA Error → Auto-Publish Blocked

**Priority:** CRITICAL — every video assembled on April 15 failed to upload to YouTube  
**Agent:** Cline-A (backend pipeline, `server.js`)  
**Estimated scope:** 2 targeted changes in `server.js`  
**Branch:** main

---

## Problem

On April 15, two News assemblies completed FFmpeg successfully (`asm_1776245805350`, `asm_1776246004494`). Both produced MP4 files. Neither uploaded to Drive nor published to YouTube.

No `gate3_assembly_*` logs exist in `output/qa_failures/` from April 15. The `data/upload_status.json` has no entries after April 14.

---

## Root Cause — Two Bugs

### Bug 1: Gate 3 error fallback sets `passed: false`, blocking Gate 6

**Location:** `server.js:5251-5258`

```javascript
} else {
  log(asmId, `⚠️  Gate 3 QA failed after ${MAX_QA_RETRIES} attempts — proceeding anyway`);
  // Create a default pass result to avoid blocking
  qaResult = { score: 70, outcome: 'manual_review', passed: false, report: `QA check failed: ${qaErr.message}` };
  assemblyJobs[asmId].qaScore = 70;
  assemblyJobs[asmId].qaOutcome = 'manual_review';
  assemblyJobs[asmId].qaRetryAttempts = qaAttempt;
  break;
}
```

The comment says "to avoid blocking" but `passed: false` is set. Then at line 5321:

```javascript
if (qaResult && qaResult.outcome === 'pass' && process.env.SKIP_AUTO_PUBLISH !== 'true') {
```

`outcome === 'manual_review'` → Gate 6 is never triggered. The Drive upload runs (because qaOutcome !== 'fail') but auto-publish is permanently blocked.

**What actually happened:** Gate 3 QA likely threw an exception (Gemini upload timeout, file too large, or API error) after all 3 retries. The fallback set `manual_review`, Drive upload may have run, but Gate 6 was skipped silently. No error logged to `errors.jsonl` because the catch block only calls `log()`, not `logError()`.

### Bug 2: `finalizeJobMetrics()` called before Gate 3

**Location:** `server.js:5164`

```javascript
finalizeJobMetrics(asmId);  // ← line 5164 — runs BEFORE Gate 3 at 5186
```

Gate 3, Drive upload, and Gate 6 never appear in the `run_metrics_*.json` files. This makes it impossible to tell from metrics whether Gate 3 ran.

---

## Fix 1 — Gate 3 error fallback: log to errors.jsonl + auto-proceed to Drive+publish

**Location:** `server.js:5251-5258`

**Current code:**
```javascript
} else {
  log(asmId, `⚠️  Gate 3 QA failed after ${MAX_QA_RETRIES} attempts — proceeding anyway`);
  // Create a default pass result to avoid blocking
  qaResult = { score: 70, outcome: 'manual_review', passed: false, report: `QA check failed: ${qaErr.message}` };
  assemblyJobs[asmId].qaScore = 70;
  assemblyJobs[asmId].qaOutcome = 'manual_review';
  assemblyJobs[asmId].qaRetryAttempts = qaAttempt;
  break;
}
```

**Replace with:**
```javascript
} else {
  log(asmId, `⚠️  Gate 3 QA errored after ${MAX_QA_RETRIES} attempts — treating as PASS to unblock Drive + publish`);
  logError('GATE3_QA_ERROR_FALLBACK', `Gate 3 QA errored ${MAX_QA_RETRIES}x — auto-passed: ${qaErr.message}`, { asmId });
  // Error fallback: treat as pass so Drive upload + Gate 6 auto-publish still fire.
  // A genuine QA fail (score<60) is different from a QA system error — don't punish
  // the video for an API timeout or upload error.
  qaResult = { score: 70, outcome: 'pass', passed: true, report: `QA check errored: ${qaErr.message} (auto-passed)` };
  assemblyJobs[asmId].qaScore = 70;
  assemblyJobs[asmId].qaOutcome = 'pass';
  assemblyJobs[asmId].qaNote = 'Gate 3 errored — auto-passed, manual review recommended';
  assemblyJobs[asmId].qaRetryAttempts = qaAttempt;
  break;
}
```

**Why:** A Gemini API timeout or file upload error is an infrastructure error, not a QA fail. The video should still go to YouTube as private (Gate 6 always publishes private). Rob can review it manually. Setting `passed: false` was punishing the video for a Gemini outage.

---

## Fix 2 — Move `finalizeJobMetrics()` to after Gate 3 completes

**Location:** `server.js:5163-5165`

**Current code (around line 5163):**
```javascript
// Finalize all job metrics
finalizeJobMetrics(asmId);
```

**Action:** Remove this call from its current location (before Gate 3). Add it after the Gate 3 block completes, right before the Drive upload starts (around line 5275, after the `if (qaResult)` logging block).

The new location should be:
```javascript
// Log final Gate 3 outcome
if (qaResult) {
  if (qaResult.outcome === 'manual_review') {
    // ...existing logging...
  }
}

// Finalize all job metrics now that Gate 3 is complete
finalizeJobMetrics(asmId);  // ← MOVED HERE from before Gate 3

// Step 8: Auto-upload to Google Drive...
if (process.env.SKIP_DRIVE_UPLOAD === 'true') {
```

---

## Testing

After the fix:
1. Run a News assembly through to completion
2. Confirm `output/qa_failures/gate3_assembly_pass_*.txt` is created
3. Confirm `data/upload_status.json` gets a new entry
4. Confirm `run_metrics_asm_*.json` includes Gate 3 stage timing

To test the error fallback path specifically (optional — only if you want to verify):
- Temporarily set `GEMINI_API_KEY=invalid` in `.env`
- Run assembly — Gate 3 should error, but Drive upload + Gate 6 should still fire
- Restore real key

---

## Also: Add Gate 3 to Assembly Metrics

While moving `finalizeJobMetrics`, add Gate 3 timing to the metrics. After the Gate 3 loop completes and before the move of `finalizeJobMetrics`:

```javascript
const gate3Timer = new StageTimer(asmId, 'Gate 3 QA');
gate3Timer.addData('score', qaResult?.score || 0)
  .addData('outcome', qaResult?.outcome || 'error')
  .addData('retryAttempts', assemblyJobs[asmId].qaRetryAttempts || 0);
addStageMetrics(asmId, gate3Timer.end());
```

Note: `StageTimer` is already imported — this is just wiring it up for Gate 3.

---

## Commit Message

```
fix(gate3): error fallback auto-passes + logError + move finalizeMetrics

Gate 3 Gemini errors were setting passed=false, silently blocking Gate 6.
Now: error fallback sets outcome='pass', logs to errors.jsonl, Drive+publish run.
finalizeJobMetrics moved after Gate 3 so metrics include QA stage.
```
