# CLINE_HANDOFF_JOB_DISMISS_RESTORE.md
→ Agent: Cline-B

**Author:** Claude Code, 2026-04-16
**Size:** S — `server.js` (1 endpoint + 1 filter) + `cwn_production.html` (1 function edit + 1 filter)
**Files:** `server.js`, `cwn_production.html`
**Depends on:** nothing — standalone
**Supersedes:** `CLINE_HANDOFF_JOB_DISMISS.md` (2026-04-14) — dismiss endpoint + dashboard function already shipped. `CLINE_HANDOFF_RESTORE_JOB_FILTER.md` (2026-04-14) — failed/published skip logic already shipped.

---

## Current State (what is already implemented)

Before touching anything, verify these are in place:

| Feature | Status | Location |
|---------|--------|----------|
| `POST /job/:id/dismiss` endpoint | **DONE** | `server.js:1088-1094` |
| `GET /jobs` excludes `status: 'dismissed'` | **DONE** | `server.js:936` |
| `dismissJob()` in dashboard calls endpoint | **DONE** | `cwn_production.html:2615-2641` |
| `restoreJobsFromServer()` skips `stage: 'failed'` | **DONE** | `cwn_production.html:2117-2123` |
| `restoreJobsFromServer()` skips `stage: 'published'` | **DONE** | `cwn_production.html:2127-2130` |

---

## Remaining Problem

On page refresh, `restoreJobsFromServer()` still restores **assembled** jobs as actionable cards with a re-publish button visible. An assembled job that was dismissed and then restored bypasses the dismiss because `GET /jobs` filters `status: 'dismissed'` — but if the job was assembled before being dismissed, its `stage` field is `'assembled'` not `'dismissed'`, and the status flag might be set correctly. However there is a second gap:

**The `assembling` stage is also not explicitly allowlisted.** The current code only checks `isFailed` and `isPublished` — any job at `assembled` stage (pipeline done, awaiting publish) comes back as `status: 'completed'` with a re-publish button, which may confuse operators into re-publishing already-published content.

**What the fix adds:** An explicit allowlist of in-flight stages in `restoreJobsFromServer()`. Only jobs in stages `script_ready`, `all_sent`, or `assembling` should auto-restore. `assembled` jobs should only restore if not dismissed and the operator explicitly clicks `↩ RESTORE JOBS`. Dismissed jobs at any stage must not restore at all.

---

## Fix 1: Server — `POST /job/:id/dismiss` sets `dismissed: true` field (server.js)

**Current (server.js:1088-1094):**
```javascript
app.post('/job/:id/dismiss', (req, res) => {
  const { id } = req.params;
  const card = persistedJobs[id];
  if (!card) return res.status(404).json({ error: 'Job not found', id });
  saveJobCard(id, { ...card, status: 'dismissed' });
  res.json({ ok: true, id, status: 'dismissed' });
});
```

The current endpoint sets `status: 'dismissed'`, which the `GET /jobs` filter already excludes at line 936. This is correct. **No change needed to the endpoint.**

---

## Fix 2: Server — `GET /jobs` stage allowlist (server.js)

The `GET /jobs` filter at `server.js:927-937` currently excludes failed, published, and dismissed jobs. Add one more exclusion: `stage === 'assembled'` jobs should NOT auto-restore on page load — they are already done (assembled, awaiting operator publish decision). If the operator wants them back they use `↩ RESTORE JOBS` manually, which already calls `restoreJobsFromServer(true)`.

**Current (server.js:927-937):**
```javascript
const actionableJobs = Object.values(persistedJobs).filter(job => {
  const stage = job.stage || '';
  const qaOutcome = job.qaOutcome || '';
  const status = job.status || '';
  return stage !== 'failed' &&
         stage !== 'published' &&
         qaOutcome !== 'fail' &&
         qaOutcome !== 'pre_flight_fail' &&
         status !== 'failed' &&
         status !== 'dismissed';
}).sort((a, b) => new Date(b.savedAt || 0) - new Date(a.savedAt || 0));
```

**Replace the filter with an allowlist approach:**
```javascript
// Only return in-flight jobs. Completed (assembled, published) and
// failed/dismissed jobs are excluded — they do not need to restore on page load.
// Operators can still manually retrieve any job with ↩ RESTORE JOBS if needed.
const IN_FLIGHT_STAGES = new Set(['script_ready', 'all_sent', 'assembling']);

const actionableJobs = Object.values(persistedJobs).filter(job => {
  const stage = job.stage || '';
  const status = job.status || '';
  // Never return dismissed jobs regardless of stage
  if (status === 'dismissed') return false;
  // Only return in-flight stages (script ready, sent to HeyGen, currently assembling)
  return IN_FLIGHT_STAGES.has(stage);
}).sort((a, b) => new Date(b.savedAt || 0) - new Date(a.savedAt || 0));
```

**Important:** `IN_FLIGHT_STAGES` must be defined inside the route handler (not module-level) since it is a small constant used only here. Or define it as `const` above the route block — either is fine.

---

## Fix 3: Dashboard — `restoreJobsFromServer()` stage filter (cwn_production.html)

The existing `isFailed` / `isPublished` checks in `restoreJobsFromServer()` at lines 2117-2130 should be extended to also skip `assembled` jobs on auto-restore (the silent 1.5s startup restore). When the operator clicks `↩ RESTORE JOBS` manually, assembled jobs should still be shown so they can re-publish if needed.

`restoreJobsFromServer(showAlert)` is called two ways:
- Auto on page load: `restoreJobsFromServer(false)` — `showAlert = false`
- Manual button click: `restoreJobsFromServer(true)` — `showAlert = true`

Use `showAlert` as the "manual restore" flag to conditionally allow assembled jobs.

**Find the block at cwn_production.html:2115-2131 (after segment building, before `var isAssembled`):**

```javascript
// Skip failed jobs — do not restore as actionable
// A failed job restored as 'all_sent' will show the Assemble button and re-run the broken assembly
var isFailed = serverStage === 'failed' ||
               qaOutcome === 'fail' ||
               qaOutcome === 'pre_flight_fail' ||
               serverJob.status === 'failed';
if (isFailed) {
  cwn_log('[restore] Skipping failed job ' + serverJob.jobId + ' (stage: ' + serverStage + ', qaOutcome: ' + qaOutcome + ')', false);
  return;
}

// Skip already-published jobs — nothing to restore
var isPublished = serverStage === 'published' || !!serverJob.publishedAt;
if (isPublished) {
  cwn_log('[restore] Skipping published job ' + serverJob.jobId + ' — already complete', false);
  return;
}
```

**Replace with (add assembled skip for auto-restore):**
```javascript
// Skip failed jobs — do not restore as actionable
// A failed job restored as 'all_sent' will show the Assemble button and re-run the broken assembly
var isFailed = serverStage === 'failed' ||
               qaOutcome === 'fail' ||
               qaOutcome === 'pre_flight_fail' ||
               serverJob.status === 'failed';
if (isFailed) {
  cwn_log('[restore] Skipping failed job ' + serverJob.jobId + ' (stage: ' + serverStage + ', qaOutcome: ' + qaOutcome + ')', false);
  return;
}

// Skip dismissed jobs — operator explicitly closed these
if (serverJob.status === 'dismissed') {
  cwn_log('[restore] Skipping dismissed job ' + serverJob.jobId, false);
  return;
}

// Skip already-published jobs — nothing to restore
var isPublished = serverStage === 'published' || !!serverJob.publishedAt;
if (isPublished) {
  cwn_log('[restore] Skipping published job ' + serverJob.jobId + ' — already complete', false);
  return;
}

// On AUTO-restore (page load), skip assembled jobs too — they are done and awaiting manual publish.
// On MANUAL restore (operator clicked ↩ RESTORE JOBS), allow assembled jobs to come back
// so the operator can re-trigger publish if needed.
var isAssembledDone = !!(serverJob.assembledAt || serverStage === 'assembled');
if (isAssembledDone && !showAlert) {
  cwn_log('[restore] Skipping assembled job ' + serverJob.jobId + ' on auto-restore — use ↩ RESTORE JOBS to bring it back', false);
  return;
}
```

**Note:** The `var isAssembled` declaration that follows this block (line 2133) references `serverStage === 'assembled'` — it will still work correctly after this change because the assembled job only reaches that line in the manual-restore path (`showAlert = true`).

---

## Files to Modify

| File | Tier | Edit |
|------|------|------|
| `server.js` | 1 — API endpoint only | Replace `GET /jobs` filter body with IN_FLIGHT_STAGES allowlist |
| `cwn_production.html` | 1 — Frontend only | Add dismissed skip + assembled auto-restore skip in `restoreJobsFromServer()` |

**Do NOT touch:** `POST /job/:id/dismiss` endpoint (already correct), `dismissJob()` function (already correct).

---

## Verification

1. Start a Twitch job, let it reach `all_sent` stage (HeyGen submitted)
2. Hard refresh (`Cmd+Shift+R`) → job card restores with `🔄 REFRESH IDs` button visible (correct)
3. Dismiss the job (click `× DISMISS`) → card disappears
4. Hard refresh again → card does NOT reappear (dismiss persisted)
5. Run a job to completion (assembled, not published) → hard refresh → card does NOT auto-restore (assembled job not in auto-restore set)
6. Click `↩ RESTORE JOBS` manually → assembled job DOES appear with publish button (manual restore allows it)
7. Check `data/jobs.json` — dismissed record still present with `status: "dismissed"` (audit trail preserved)
8. Verify `GET /jobs` response: only returns `script_ready` / `all_sent` / `assembling` jobs

---

## STATUS.md Update Required

Update `🤖 Last Agent Action` table:

```
| Cline-B | **fix(jobs): dismiss + restore stage filter** — GET /jobs now uses IN_FLIGHT_STAGES allowlist (script_ready/all_sent/assembling only). restoreJobsFromServer() adds dismissed skip + assembled auto-restore skip (assembled jobs only restore on manual ↩ RESTORE JOBS click). | server.js, cwn_production.html, STATUS.md | [commit] | 2026-04-16 ET |
```

---

## Commit Message

```
fix(jobs): stage allowlist for GET /jobs + assembled skip in auto-restore

GET /jobs now uses an IN_FLIGHT_STAGES allowlist (script_ready,
all_sent, assembling) instead of a denylist — assembled and published
jobs no longer auto-restore on page load.

restoreJobsFromServer() adds two new skip checks:
- dismissed jobs (status === 'dismissed') skipped explicitly
- assembled jobs skipped on auto-restore (showAlert=false); still
  restoreable via manual ↩ RESTORE JOBS click (showAlert=true)

Dismiss endpoint and dismissJob() function were already implemented
(CLINE_HANDOFF_JOB_DISMISS.md). This completes the restore filtering
side of the same feature.
```
