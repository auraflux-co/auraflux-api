# CLINE HANDOFF: Gate 3 Poller Race Condition Fix

**Agent:** Cline-A  
**Priority:** SHIP NEXT — blocks Gate 3, Drive upload, and Upload-Post from ever completing  
**Status:** READY — code already applied to server.js by Claude Code. Commit only.

---

## What Was Broken

Assembly jobs complete FFmpeg but Gate 3 / Drive / Upload-Post never run. Job card stays at `all_sent` forever. No errors in logs.

**Root cause:** Race condition between `assemblyJobs[asmId].status = 'done'` (set at FFmpeg completion, line 5094) and the heygen-poller's `pollAssemblyCompletion` interval (fires every 15s). If the poller fires in the window between FFmpeg completing and Gate 3 starting, it sees `status === 'done'`, collects the card with no `qaScore`/`driveUrl`, and stops polling. Gate 3 and Drive upload complete in memory but are never written to the persisted job card.

**Evidence:**
- `run_metrics_asm_*.json` always ends at FFmpeg (Gate 3 never logged — `finalizeJobMetrics` called before Gate 3)
- `output/qa_failures/gate3_*.txt` files never created for affected runs
- Job card stage stays at `all_sent` (never updates to `assembled`)
- 206MB News assembly (Apr 15, 1:45am) fully assembled, thumbnail extracted — Gate 3 never fired

---

## Fix Applied (Claude Code — commit this)

**File:** `server.js`

**Change 1** (line ~5094): Changed intermediate status from `'done'` to `'ffmpeg_done'` so poller doesn't fire early:
```javascript
// BEFORE:
assemblyJobs[asmId].status = 'done';

// AFTER:
assemblyJobs[asmId].status = 'ffmpeg_done'; // Gate 3 + Drive still pending — poller must not fire yet
```

**Change 2** (after `} // end SKIP_DRIVE_UPLOAD else`, before `// Clean up tmp files`): Set final terminal status only after Gate 3 + Drive complete:
```javascript
// Set final terminal status — poller fires only after this point
if (assemblyJobs[asmId].status === 'ffmpeg_done') {
  const qaOutcome = assemblyJobs[asmId].qaOutcome;
  if (qaOutcome === 'fail') {
    assemblyJobs[asmId].status = 'failed'; // Gate 3 hard fail — poller will record this
  } else {
    assemblyJobs[asmId].status = 'done'; // Gate 3 pass or no QA result
  }
}
```

**Why this works:**
- `'ffmpeg_done'` is NOT in the poller's `isDone` check (`'done' || 'manual_review' || 'failed'`) — poller keeps sleeping until real terminal status is set
- `'manual_review'` is set by Gate 3 at line 5212 (unchanged) — poller catches it correctly
- `'failed'` is set by catch block at line 5438 (unchanged) — crash path unaffected
- Gate 3 `fail` now sets `'failed'` instead of leaving `'ffmpeg_done'` — poller records the failure

---

## What to Commit

The two changes above are already in `server.js`. Verify them by searching for `'ffmpeg_done'` — should appear twice (one set, one check).

```bash
grep -n "ffmpeg_done" server.js
# Should show:
# ~5094: assemblyJobs[asmId].status = 'ffmpeg_done';
# ~5427: if (assemblyJobs[asmId].status === 'ffmpeg_done') {
```

**Commit message:**
```
fix: Gate 3 poller race condition — status 'done' set before QA/Drive completed

assemblyJobs status was set to 'done' immediately after FFmpeg completed,
before Gate 3 QA and Drive upload ran. The heygen-poller fired in this window,
persisted the card with no qaScore/driveUrl, and stopped polling. Changed
intermediate status to 'ffmpeg_done' (not in isDone set) so poller waits for
real terminal status set after Gate 3 + Drive complete.
```

---

## Test After Commit

Trigger a fresh News assembly (or use auto-advance to re-fire). Confirm:
1. `logs/` shows Gate 3 running (Gemini QA check line)
2. `output/qa_failures/gate3_*.txt` file created
3. Job card stage updates from `all_sent` → `assembled`
4. `driveUrl` appears in job card (check `data/jobs.json`)
5. Upload-Post fires if Gate 3 passes
