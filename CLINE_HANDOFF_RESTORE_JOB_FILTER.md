# CLINE_HANDOFF_RESTORE_JOB_FILTER.md
→ Agent: Cline-A

**Author:** Claude Code, 2026-04-14
**Size:** S — cwn_production.html only, Tier 2
**Problem:** `restoreJobsFromServer()` restores jobs at ANY stage including failed/completed ones. A failed job (0 clips, Gate 3 fail) was restored as `all_sent`, the Assemble button appeared, and clicking Generate triggered it to re-run the broken assembly.
**1 commit.**

---

## Root Cause

`restoreJobsFromServer()` at `cwn_production.html:1941` has two restore states:

```javascript
var isAssembled = !!(serverJob.assembledAt || serverStage === 'assembled' || serverStage === 'published');
var restoredStatus = isAssembled ? 'completed' : 'all_sent';
```

No handling for:
- `stage: 'failed'` — assembly failed (Gate 3 fail, pre-flight fail, FFmpeg crash)
- `qaOutcome: 'fail'` or `qaOutcome: 'pre_flight_fail'`
- `stage: 'published'` — already done, no need to restore as actionable

Result: every job that isn't `assembled` comes back as `all_sent` with the Assemble button active — including jobs that failed and should never be re-run automatically.

---

## Fix

### 1. Add failed/published skip logic at `cwn_production.html:2033`

This is inside the `resp.jobs.forEach` loop, right before `var serverStage = serverJob.stage || '';`

**Current:**
```javascript
        var contentType = serverJob.contentType || 'twitch';
        var dateLabel = serverJob.date || new Date(serverJob.savedAt || Date.now()).toLocaleDateString([],{month:'short',day:'numeric'});
        var avatarCount = segments.filter(function(s){ return s.type==='avatar'; }).length;
        var clipCount   = segments.filter(function(s){ return s.type==='source_clip'; }).length;

        // Determine correct status based on server-side pipeline stage
        var serverStage = serverJob.stage || '';
        var isAssembled = !!(serverJob.assembledAt || serverStage === 'assembled' || serverStage === 'published');
        var restoredStatus = isAssembled ? 'completed' : 'all_sent';
```

**Target:**
```javascript
        var contentType = serverJob.contentType || 'twitch';
        var dateLabel = serverJob.date || new Date(serverJob.savedAt || Date.now()).toLocaleDateString([],{month:'short',day:'numeric'});
        var avatarCount = segments.filter(function(s){ return s.type==='avatar'; }).length;
        var clipCount   = segments.filter(function(s){ return s.type==='source_clip'; }).length;

        // Determine correct status based on server-side pipeline stage
        var serverStage = serverJob.stage || '';
        var qaOutcome   = serverJob.qaOutcome || '';

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

        var isAssembled = !!(serverJob.assembledAt || serverStage === 'assembled');
        var restoredStatus = isAssembled ? 'completed' : 'all_sent';
```

---

## Also: Clear jobs.json of stale entries on server startup

The real fix is also server-side — `data/jobs.json` should not persist failed jobs forever. They keep coming back on every page load.

### Add to `server.js` — in the `GET /jobs` endpoint at `server.js:894`

Find the `GET /jobs` endpoint. Before returning `resp.jobs`, filter out failed jobs:

**Current (find this pattern):**
```javascript
app.get('/jobs', (req, res) => {
```

**Add filter before the res.json call:**
```javascript
  // Filter: only return jobs that are actionable (not failed, not published)
  // Failed jobs restore as 'all_sent' which shows Assemble button on broken jobs
  const actionableJobs = Object.values(persistedJobs).filter(job => {
    const stage = job.stage || '';
    const qaOutcome = job.qaOutcome || '';
    const status = job.status || '';
    return stage !== 'failed' &&
           stage !== 'published' &&
           qaOutcome !== 'fail' &&
           qaOutcome !== 'pre_flight_fail' &&
           status !== 'failed';
  });
```

Then return `actionableJobs` instead of `Object.values(persistedJobs)`.

Find the exact line with `res.json` in the `/jobs` endpoint and update accordingly.

---

## Verification

1. Run a News job that fails Gate 3 (or pre-flight)
2. Reload the page
3. Dashboard log should show: `[restore] Skipping failed job script_news_XXXX (stage: failed, qaOutcome: pre_flight_fail)`
4. The failed job should NOT appear in the queue
5. No Assemble button for failed jobs on restore

Also verify: a job that is `all_sent` (HeyGen done, not yet assembled) still restores correctly with the Assemble button.

---

## Commit Message

```
fix(dashboard): skip failed and published jobs in restoreJobsFromServer

Failed jobs (stage=failed, qaOutcome=fail/pre_flight_fail) were being
restored as 'all_sent' — Assemble button appeared and re-ran broken
assembly on page load or when Generate was clicked.

Changes:
- cwn_production.html: restoreJobsFromServer() skips jobs where
  isFailed=true or isPublished=true before building restoredJob card
- server.js GET /jobs: filters out failed + published jobs before
  returning — stops them from appearing in restore payload at all

Two-layer fix: server filters first, dashboard skips anything that
slips through (e.g. older job cards without stage field).

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

---

## Ship Order

```
node -c server.js (verify clean start)
→ make changes to cwn_production.html + server.js
→ node -c server.js
→ git add cwn_production.html server.js STATUS.md && git commit
→ push
```
