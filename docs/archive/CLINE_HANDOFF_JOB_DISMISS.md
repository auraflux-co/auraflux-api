# CLINE_HANDOFF_JOB_DISMISS.md
→ Agent: Cline-B

**Author:** Claude Code, 2026-04-14
**Size:** S — server.js (1 endpoint, ~10 lines) + cwn_production.html (1 function edit)
**Files:** `server.js` (API endpoint only — no pipeline functions), `cwn_production.html`
**Depends on:** nothing — standalone

---

## Problem

When an operator closes/dismisses a job card on the dashboard, it only removes the card from `localStorage`. The job record stays in `data/jobs.json` and in the server's in-memory `persistedJobs` map. On the next hard refresh, `restoreJobsFromServer()` pulls it back from `GET /jobs` and the card reappears.

Workaround today: manually clear `data/jobs.json` and restart the server. That wipes ALL jobs, including ones that are legitimately in-flight.

---

## The Fix

### 1. New endpoint — `POST /job/:id/dismiss` (server.js)

Add this endpoint in the API routes section (near the existing `/job/:id/rollback` and `/job/:id/advance` routes):

```javascript
// POST /job/:id/dismiss — operator closed the job card on the dashboard.
// Marks the job dismissed so restoreJobsFromServer() skips it on next page load.
// Does NOT delete the record — preserves audit trail in data/jobs.json.
app.post('/job/:id/dismiss', (req, res) => {
  const { id } = req.params;
  const card = persistedJobs[id];
  if (!card) return res.status(404).json({ error: 'Job not found', id });
  saveJobCard(id, { ...card, status: 'dismissed' });
  res.json({ ok: true, id, status: 'dismissed' });
});
```

That's it. `saveJobCard` writes to both `persistedJobs` and `data/jobs.json` atomically.

### 2. Update restore filter — `GET /jobs` or `restoreJobsFromServer()` (server.js)

Find the `GET /jobs` endpoint (around `server.js:894`). It already filters out `failed` and `published` jobs before returning the list. Add `dismissed` to that filter:

```javascript
// Before (find the filter line that looks like this):
.filter(card => card.status !== 'failed' && card.status !== 'published')

// After:
.filter(card => !['failed', 'published', 'dismissed'].includes(card.status))
```

### 3. Wire the dashboard close button (cwn_production.html)

Find the existing job card close/remove function — it's the `×` button or `removeJob(jobId)` / `closeJob(jobId)` function that currently only does localStorage cleanup.

Add a fire-and-forget call to the new endpoint:

```javascript
function removeJob(jobId) {
  // Dismiss on server so it doesn't restore on next page load
  fetch(`/job/${jobId}/dismiss`, { method: 'POST' }).catch(() => {});

  // existing localStorage cleanup — keep as-is
  const jobs = loadJobs();
  delete jobs[jobId];
  saveJobs(jobs);
  renderJobs();
}
```

The `fetch` is fire-and-forget (`.catch(() => {})`) — if the server is down, the card still closes locally. On next refresh the server would restore it, but that's acceptable degraded behavior.

---

## Files to change

| File | Tier | Edit |
|------|------|------|
| `server.js` | 1 — API endpoint only | Add `POST /job/:id/dismiss` route; update `GET /jobs` filter |
| `cwn_production.html` | 1 | Add `fetch('/job/:id/dismiss')` call in `removeJob()` |

## Verification

1. Start a job, let it reach any stage
2. Close the card on the dashboard (click ×)
3. Hard refresh (`Cmd+Shift+R`)
4. Card does NOT reappear
5. Check `data/jobs.json` — record still exists with `status: "dismissed"` (audit trail preserved)

## Commit message

```
feat(jobs): add dismiss endpoint so closed job cards don't restore on refresh

POST /job/:id/dismiss marks a job card dismissed in persistedJobs +
data/jobs.json. GET /jobs filter updated to exclude dismissed alongside
failed/published. Dashboard removeJob() fires dismiss before local
localStorage cleanup — fire-and-forget so card still closes if server
is unreachable.

Previously, closing a card only cleared localStorage. Hard refresh
triggered restoreJobsFromServer() which pulled the card back from
data/jobs.json. Fix: dismiss persists server-side so the restore
filter skips it.
```
