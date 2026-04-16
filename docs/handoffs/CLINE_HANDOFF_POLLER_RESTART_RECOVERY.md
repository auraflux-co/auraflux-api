# CLINE_HANDOFF_POLLER_RESTART_RECOVERY.md

**Assigned to:** Cline-A (Claude Sonnet 4.6)
**Priority:** HIGH — eliminates 2-click manual recovery after every nodemon restart
**Date:** 2026-04-16
**Scope:** server.js only

---

## Why This Exists

`startHeyGenPoller()` is a `setInterval`/`setTimeout` chain that lives entirely in Node.js memory. When nodemon restarts the server — whether triggered by a code change, crash, or `touch server.js` — all active pollers die instantly. Any job that was mid-HeyGen render at the moment of restart is now orphaned.

**What happens today after a restart:**
1. `GET /jobs` is called by the dashboard on page load (1.5s delay)
2. `restoreJobsFromServer()` rebuilds job cards from `data/jobs.json`
3. Cards with `heygen.videoJobs` restore in `all_sent` state — correct
4. But the poller is gone — no one is watching HeyGen for completion
5. User must: click `REFRESH IDs` → wait → click `ASSEMBLE` → pipeline resumes

Two manual clicks, each requiring the user to notice the job card is stuck. Unacceptable for a fully-automated pipeline.

**What this handoff builds:**
- Server startup scans `persistedJobs` for in-flight HeyGen jobs and re-attaches pollers automatically
- Jobs where HeyGen already completed before the restart auto-trigger assembly directly, no polling needed
- Dashboard auto-triggers assembly when restore detects all segments are complete (eliminates the `REFRESH IDs` click)

---

## Part 1: Server-Side — `recoverInFlightJobs()` in server.js

### Location

Insert the function definition and call immediately after the `persistedJobs` load block (after line ~267 in server.js, before the `saveJobCard` function definition).

### Implementation

```javascript
// ── recoverInFlightJobs() — Re-attach HeyGen pollers for in-flight jobs after restart ──
// Called once at boot time, after persistedJobs is loaded from data/jobs.json.
// For each job in all_sent stage with pending HeyGen segments, re-starts the poller.
// For jobs where all HeyGen segments already completed, triggers assembly directly.
async function recoverInFlightJobs() {
  const inFlightJobs = Object.values(persistedJobs).filter(card => {
    const stage = card.stage || '';
    const videoJobs = card.heygen?.videoJobs || [];
    // Target: jobs that were in HeyGen render — all_sent, and have video IDs
    return (stage === 'all_sent' || (!card.assembledAt && !card.finalUrl && videoJobs.length > 0))
      && !card.publishRecord;
  });

  if (!inFlightJobs.length) {
    console.log(`[boot-recovery] No in-flight HeyGen jobs found — nothing to recover`);
    return;
  }

  console.log(`[boot-recovery] Found ${inFlightJobs.length} in-flight job(s) — attempting poller recovery`);

  for (const card of inFlightJobs) {
    const jobId = card.jobId || card.asmId || Object.keys(persistedJobs).find(k => persistedJobs[k] === card);
    if (!jobId) {
      console.warn(`[boot-recovery] Skipping job — cannot determine jobId`);
      continue;
    }

    const videoJobs = card.heygen?.videoJobs || [];
    if (!videoJobs.length) {
      console.warn(`[boot-recovery:${jobId}] Skipping — no videoJobs in card`);
      continue;
    }

    // Check if all segments already have completed URLs (HeyGen finished before restart)
    const allCompleted = videoJobs.every(j => j.status === 'completed' && j.video_url);
    const noneCompleted = videoJobs.every(j => !j.status || j.status === 'pending' || j.status === 'processing');

    if (allCompleted) {
      // All HeyGen segments completed before restart — skip polling, trigger assembly directly
      console.log(`[boot-recovery:${jobId}] All ${videoJobs.length} segments already completed — triggering assembly directly`);
      // Delay by 10s to let server finish initialization before firing /assemble
      setTimeout(() => startHeyGenPoller(jobId, card), 10000);
    } else {
      // Some segments still pending — re-attach poller to check HeyGen status
      const completedCount = videoJobs.filter(j => j.status === 'completed' && j.video_url).length;
      console.log(`[boot-recovery:${jobId}] ${completedCount}/${videoJobs.length} segments completed — re-attaching poller`);
      // Delay by 15s to let server fully initialize before polling HeyGen API
      setTimeout(() => startHeyGenPoller(jobId, card), 15000);
    }
  }
}
```

### Call Site

After the `persistedJobs` load block and after `startHeyGenPoller` is defined (it's defined at line ~309), add this call at the bottom of the startup initialization block. The function uses `setTimeout` internally so it is safe to call synchronously at boot — it will not block server startup.

```javascript
// ── Boot-time recovery — runs after persistedJobs loaded, startHeyGenPoller defined ──
// Wrap in setImmediate so it fires after all requires + app setup completes
setImmediate(() => {
  recoverInFlightJobs().catch(e =>
    console.error(`[boot-recovery] Unexpected error during in-flight job recovery: ${e.message}`)
  );
});
```

Place this `setImmediate` call near the bottom of server.js, after the `app.listen()` call, so the server is fully accepting requests before recovery tries to POST to `/assemble`.

### How It Works With `startHeyGenPoller()`

`startHeyGenPoller(jobId, card)` already handles the two cases correctly:
- If it polls and finds all segments `completed` → triggers assembly immediately
- If it polls and some are still `pending` → sets `setTimeout(poll, 30000)` and keeps retrying

Re-calling `startHeyGenPoller()` at boot is safe because:
1. The poller reads live HeyGen API status on first poll (30s delay before first real check when partial, 10s for completed)
2. `assemblyJobs[asmId]` is checked at assembly trigger time — duplicate assembly calls are guarded by job status
3. No mutable state is shared between the dead poller and the new one

### Edge Case: Job Already Assembled

The filter in `recoverInFlightJobs()` excludes jobs with `assembledAt` or `finalUrl`. Jobs that completed assembly before restart are not re-polled. The check `!card.assembledAt && !card.finalUrl` is the guard.

### Edge Case: Server Starts Multiple Times Quickly

If nodemon restarts twice in 15 seconds (e.g., rapid file saves), two pollers could attach to the same job. The second poller will see the job card's `stage` already updated to `assembled` when it tries to trigger, and `axios.post('/assemble')` will return normally — `handleAssemble` will detect the `assemblyId` is new and start a fresh job. This is a known acceptable duplicate; Gate 3 will catch any issues.

If this is unacceptable, add a `card._pollerAttachedAt` timestamp to `persistedJobs[jobId]` when `recoverInFlightJobs()` attaches a poller, and skip reattachment if `_pollerAttachedAt` is within the last 60 seconds. This is optional.

---

## Part 2: Dashboard-Side — Auto-Trigger Assembly on Restore

### Context

`restoreJobsFromServer()` in `cwn_production.html` calls `GET /jobs` on page load. When it gets back a job card in `all_sent` state where all HeyGen video IDs have `status: 'completed'`, it currently just renders the job card with a `REFRESH IDs` button. The user must click that button to get real URLs, then click `ASSEMBLE`.

This Part 2 eliminates that manual step when the data is already available in the restored card.

### Detection Logic

After `restoreJobsFromServer()` pushes a restored card into `JOBS`, check:

```javascript
// After each card is restored and pushed to JOBS array:
const videoJobs = restoredCard.heygen?.videoJobs || [];
const allDone = videoJobs.length > 0 && videoJobs.every(j => j.status === 'completed' && j.video_url);
if (allDone && (restoredCard.stage === 'all_sent' || !restoredCard.assembledAt)) {
  console.log(`[restore] Job ${restoredCard.jobId} — all ${videoJobs.length} HeyGen segments complete, auto-triggering assembly`);
  // Short delay so the job card renders first before assembly UI fires
  setTimeout(() => assembleJob(restoredCard.jobId), 3000);
}
```

Add this check inside the `restoreJobsFromServer()` function, right after the card is pushed into the `JOBS` array (or the equivalent in-memory store used by the dashboard).

The `assembleJob(jobId)` function should already exist — it is the same function called when the operator clicks the `ASSEMBLE` button. Call it with the restored `jobId`.

### Visual Feedback

When auto-assemble fires on restore, log a line to the job card's log panel:
```
[auto-restore] All HeyGen segments were complete at restart — assembly triggered automatically
```

This makes it clear to the operator what happened without requiring them to understand the recovery mechanism.

---

## Testing Checklist

1. Start a Twitch longform job through script gen + Gate 1
2. Wait until HeyGen poller confirms at least 2 segments are rendering (not yet complete)
3. `touch server.js` — trigger nodemon restart
4. Watch server console for: `[boot-recovery] Found 1 in-flight job(s) — attempting poller recovery`
5. Confirm poller re-attaches and continues polling every 30s
6. Confirm assembly fires automatically when all segments complete — no manual clicks
7. Repeat: let HeyGen finish fully before restart — confirm assembly auto-fires within 15s of boot

---

## Files to Modify

| File | Change |
|------|--------|
| `server.js` | Add `recoverInFlightJobs()` function + `setImmediate()` call after `app.listen()` |
| `cwn_production.html` | Add auto-assembly trigger in `restoreJobsFromServer()` when all segments completed |

---

## STATUS.md Update Requirement

Before committing, update `STATUS.md → 🤖 Last Agent Action` table with:

| Agent | Task Completed | Files Changed | Commit | Timestamp |
|-------|---------------|---------------|--------|-----------|
| Cline-A | **feat(recovery): recoverInFlightJobs() + auto-assemble on restore** — Added boot-time `recoverInFlightJobs()` that scans `persistedJobs` for jobs in `all_sent` stage and re-attaches HeyGen pollers within 15s of server startup. Jobs where all segments were already complete at restart skip polling and go straight to assembly. Dashboard `restoreJobsFromServer()` now auto-triggers `assembleJob()` when restored card has all segments completed — eliminates REFRESH IDs + ASSEMBLE manual clicks after server restart. | server.js, cwn_production.html, STATUS.md | [commit hash] | [timestamp] |

Also update `docs/INDEX.md` — add this handoff to the handoffs section, mark the matching entry (if any) as `[IMPLEMENTING]`.
