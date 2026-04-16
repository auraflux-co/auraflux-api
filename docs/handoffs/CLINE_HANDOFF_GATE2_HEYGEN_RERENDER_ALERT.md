# CLINE_HANDOFF_GATE2_HEYGEN_RERENDER_ALERT.md
→ Agent: Cline-A

**Author:** Claude Code, 2026-04-17
**Size:** M — `lib/assembly.js` + `server.js` (saveJobCard) + `cwn_production.html` (dashboard alert)
**Priority:** HIGH — blocks Gate 2 from ever auto-fixing without burning credits silently
**Branch:** `cline-a/gate2-rerender-alert`
**Depends on:** Nothing — standalone

---

## Why This Exists

Gate 2 fails → Topaz enhancement is tried → if Topaz fails, the code logs
`"HeyGen re-rendering available but not implemented yet"` and silently proceeds
to assembly with known-bad segments.

Two problems:
1. **No operator alert** — the job silently degrades. Rob has no idea Gate 2 failed.
2. **Re-render costs real money** — HeyGen charges per segment rendered. Re-rendering
   must NEVER happen without explicit operator approval. Right now the path is stubbed
   but unguarded.

Additionally there are **time-sensitive CDN expiry** windows that need alerts:
- Twitch CDN URLs expire ~60 minutes after GQL resolution
- HeyGen segments stuck in queue for >90 minutes need an alert

---

## What To Build — 4 changes

---

### Change 1: Gate 2 STUCK alarm when max retries exhausted (lib/assembly.js)

**Find** (line ~1069):
```javascript
log(asmId, `❌ Gate 2 FAIL — Max retries (${MAX_G2_RETRIES}) reached. Proceeding to assembly.`);
break;
```

**Replace with:**
```javascript
log(asmId, `❌ Gate 2 FAIL — Max retries (${MAX_G2_RETRIES}) reached.`);
// Post stuck alarm — operator must decide: approve HeyGen re-render or kill job
try {
  await axios.post(`http://localhost:${process.env.PORT || 3000}/job/${asmId}/stuck`, {
    gate: 'gate2_segment_qa',
    reason: `Gate 2 failed after ${MAX_G2_RETRIES} retries. Segments have quality issues Topaz could not fix.`,
    detail: {
      score: g2Result?.score || 0,
      failedSegments: g2FailedSegments.map(s => s.label),
      heygenReRenderAvailable: !!(assemblyJobs[asmId]?.sceneTextMap),
      estimatedReRenderCost: `$${((g2FailedSegments.length || 3) * 0.038).toFixed(2)} (~${g2FailedSegments.length || 3} segments × $0.038)`
    }
  });
} catch(e) {
  console.error(`[gate2] Failed to post stuck alarm: ${e.message}`);
}
break;
```

---

### Change 2: HeyGen re-render requires operator approval — CRITICAL alert (lib/assembly.js)

**Find** (line ~1049):
```javascript
assemblyJobs[asmId].heygenReRenderAvailable = true;
// Note: Actual HeyGen re-rendering implementation would:
...
log(asmId, `💡 HeyGen re-rendering available but not implemented yet — retrying with existing segments`);
```

**Replace with:**
```javascript
assemblyJobs[asmId].heygenReRenderAvailable = true;

// CRITICAL: HeyGen re-render costs real money — requires operator approval
// Post a high-priority alert to the dashboard. Do NOT re-render automatically.
const failedSceneLabels = avatarSegsForQA.map(s => s.label);
const estimatedCost = (failedSceneLabels.length * 0.038).toFixed(2);

logError('GATE2_RERENDER_REQUIRED', {
  asmId,
  failedSegments: failedSceneLabels,
  estimatedCost: `$${estimatedCost}`,
  message: `Gate 2 failed. HeyGen re-render required for ${failedSceneLabels.length} segments (~$${estimatedCost}). Operator must approve.`
});

try {
  await axios.post(`http://localhost:${process.env.PORT || 3000}/job/${asmId}/stuck`, {
    gate: 'gate2_rerender_required',
    reason: `🚨 CRITICAL: HeyGen re-render required — ${failedSceneLabels.length} segments (~$${estimatedCost}). Approve or Kill Job.`,
    detail: {
      failedSegments: failedSceneLabels,
      estimatedCost: `$${estimatedCost}`,
      action: 'Operator must click APPROVE RE-RENDER or KILL JOB on the dashboard card'
    }
  });
} catch(e) {
  console.error(`[gate2] Failed to post re-render alert: ${e.message}`);
}

log(asmId, `🚨 CRITICAL: HeyGen re-render required — ${failedSceneLabels.length} segments (~$${estimatedCost}). Waiting for operator approval.`);
// Halt — do not continue retry loop. Job stays STUCK until operator acts.
break;
```

---

### Change 3: Twitch CDN expiry alert (lib/assembly.js)

**Find** the Twitch re-resolve block — search for:
```javascript
// For Twitch source_clips, re-resolve fresh GQL tokens
```

**Add this check BEFORE the re-resolve loop:**
```javascript
// ── Twitch CDN expiry warning ──────────────────────────────────────────────
// Twitch GQL tokens expire ~60 minutes after initial resolution.
// If job has been running for more than 50 minutes, alert operator.
if (contentType === 'twitch' || contentType === 'twitch-short') {
  const jobStartTime = assemblyJobs[asmId]?.startedAt
    ? new Date(assemblyJobs[asmId].startedAt).getTime()
    : Date.now();
  const elapsedMinutes = (Date.now() - jobStartTime) / 60000;
  if (elapsedMinutes > 50) {
    log(asmId, `⚠️  TWITCH CDN WARNING: Job has been running ${elapsedMinutes.toFixed(0)} min. Twitch CDN URLs expire at ~60 min. Re-resolving now — if this fails, clips will 403.`);
    logError('TWITCH_CDN_EXPIRY_RISK', { asmId, elapsedMinutes: elapsedMinutes.toFixed(0) });
  }
}
```

---

### Change 4: HeyGen queue timeout alert (server.js — inside startHeyGenPoller)

**Find** `startHeyGenPoller` in `server.js`. Inside the polling loop, find where it checks elapsed time or add a new check. Add this near the top of the polling interval callback:

```javascript
// ── HeyGen queue timeout alert ─────────────────────────────────────────────
// If any segment hasn't completed in 90 minutes, alert operator.
const pollerStart = pollerStartTime || Date.now(); // add: const pollerStartTime = Date.now(); before the interval
const elapsedMin = (Date.now() - pollerStart) / 60000;
if (elapsedMin > 90 && !heygenTimeoutAlerted) {
  heygenTimeoutAlerted = true; // add this flag before the interval
  console.warn(`[heygen-poller:${jobId}] ⚠️  90 minutes elapsed — segments still pending. HeyGen queue may be stuck.`);
  logError('HEYGEN_QUEUE_TIMEOUT', {
    jobId,
    elapsedMinutes: elapsedMin.toFixed(0),
    pendingSegments: videoJobs.filter(j => j.status !== 'completed').length
  });
  saveJobCard(jobId, {
    ...persistedJobs[jobId],
    heygenQueueAlert: true,
    heygenQueueAlertAt: new Date().toISOString(),
    heygenQueueAlertMinutes: elapsedMin.toFixed(0)
  });
}
```

**Variables to add before the `setInterval` call:**
```javascript
const pollerStartTime = Date.now();
let heygenTimeoutAlerted = false;
```

---

## Dashboard — stuck card already handles this

The stuck card UI (🚨 badge, reason panel, Kill Job button) shipped in `d237a3e`.
The `detail.action` field from the stuck POST will show in the stuck panel.
No dashboard changes needed — the existing stuck UI is sufficient.

---

## Files to Modify

| File | Change |
|------|--------|
| `lib/assembly.js` | Changes 1, 2, 3 — Gate 2 stuck alarm, re-render critical alert, Twitch CDN warning |
| `server.js` | Change 4 — HeyGen 90-minute queue timeout alert in startHeyGenPoller |

---

## Verification

```bash
node -c lib/assembly.js
node -c server.js
touch server.js  # restart nodemon
```

Check that:
1. Gate 2 max-retries path now calls `/job/:id/stuck`
2. HeyGen re-render path posts CRITICAL alert and breaks instead of logging "not implemented"
3. `logError` is imported in `lib/assembly.js` (it already is — line 9)
4. `axios` is available in `lib/assembly.js` (it already is — line 6)

---

## Commit Message

```
feat(gate2): STUCK alarm + CRITICAL re-render alert + CDN expiry + HeyGen timeout

Gate 2 now escalates correctly instead of silently degrading:
- Max retries exhausted → POST /job/:id/stuck with cost estimate
- HeyGen re-render needed → CRITICAL alert with $ cost, halts job, awaits operator
- Twitch CDN: warns if job has run >50 min (tokens expire at ~60 min)
- HeyGen poller: STUCK alarm if any segment pending >90 min

Re-rendering NEVER happens automatically — always requires operator approval.

lib/assembly.js: Changes 1-3
server.js: Change 4 (startHeyGenPoller timeout alert)
```

---

## STATUS.md Update

```
| Cline-A | feat(gate2): STUCK alarm + CRITICAL re-render alert + CDN/HeyGen timeout alerts | lib/assembly.js, server.js, STATUS.md | [commit] | 2026-04-17 |
```
