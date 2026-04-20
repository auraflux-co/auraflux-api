# CLINE_HANDOFF_STUCK_JOB_ESCALATION.md
→ Agent: Cline-A

**Author:** Claude Code, 2026-04-16
**Size:** M — `lib/qa.js`, `lib/script_gen.js`, `lib/assembly.js`, `server.js` (job card + publish flow), `cwn_production.html` (stuck card UI)
**Priority:** High — without this, failed jobs are silent black boxes. Operators can't tell if a job needs attention or if the system is retrying.
**Blocked by:** Nothing — check STATUS.md before starting.

---

## Design

Every gate follows the same escalation ladder. This replaces ad-hoc retry logic with a unified pattern across all gates.

```
Gate N fails
  ↓
Attempt 1: Gemini/Claude retry with structured FIX_DIRECTIVE
  ↓ pass → continue
  ↓ fail
Attempt 2: Harder directive (specific line-by-line corrections)
  ↓ pass → continue
  ↓ fail
STUCK_JOB: mark card status='stuck', surface reason, notify dashboard
  ↓
Operator sees stuck card: reason + [Kill Job] button
  ↓ kill → job purged, credits stopped
  ↓ wait → system holds, no more retries, no more spend
```

**Key rules:**
- Max 2 auto-retries per gate (already in place for Gate 1 — enforce for all gates)
- After 2 failures: no more Gemini/Claude spend. Hold and alarm.
- Stuck reason must be human-readable: what failed, what was tried, what the system cannot fix on its own.
- If the same content type produces stuck jobs repeatedly (≥3 in 24h): auto-disable that type with a dashboard notice.

---

## Gate Coverage

| Gate | Who retries | Max retries | Stuck trigger | Alarm |
|------|-------------|-------------|---------------|-------|
| Gate 0 (clips) | Server: re-runs scraper with broader keywords | 1 | 0 confirmed clips after retry | `STUCK: No source clips found for [type]. Scraper returned 0 confirmed videos. Check AJ/ESPN source.` |
| Gate 1 (script) | Gemini reruns with FIX_DIRECTIVE from Claude QA | 2 | Score <70 after 2 retries | `STUCK: Script failed Gate 1 after 2 retries. Last score: XX/100. Issues: [FIX_DIRECTIVE summary]` |
| Gate 2 (HeyGen) | HeyGen re-renders flagged segments | 1 | Score <65 after retry | `STUCK: HeyGen render quality below threshold after retry. Segments: [list]. Manual review needed.` |
| Gate 3 (assembly) | Surgical fix (freeze removal, audio re-normalize) | 1 | Score <60 after surgical fix | `STUCK: Assembly failed Gate 3 after surgical fix. Reason: [Gate 3 report summary]` |
| Gate 4 (publish) | Upload-Post retry with fresh Drive URL | 1 | No job_id after retry | `STUCK: Publish failed after retry. Upload-Post error: [error]. Check Drive URL + API key.` |

---

## Implementation

### 1 — Shared `markJobStuck()` helper in `server.js`

Add near `saveJobCard()` (server.js, wherever saveJobCard is defined):

```javascript
/**
 * Mark a job as stuck and trigger dashboard alarm.
 * Call after all auto-retries are exhausted.
 *
 * @param {string} jobId
 * @param {string} gate - 'gate0' | 'gate1' | 'gate2' | 'gate3' | 'gate4'
 * @param {string} reason - human-readable explanation of what failed and what was tried
 * @param {object} [detail] - optional structured data (scores, error messages, etc.)
 */
function markJobStuck(jobId, gate, reason, detail = {}) {
  const card = persistedJobs[jobId];
  if (!card) {
    logger.warn({ jobId, gate }, '[stuck] markJobStuck called for unknown jobId');
    return;
  }

  card.status  = 'stuck';
  card.stuckAt = gate;
  card.stuckReason = reason;
  card.stuckDetail = detail;
  card.stuckAt_ts  = new Date().toISOString();

  saveJobCard(jobId, card);

  // Log to errors.jsonl for ops review
  logError(jobId, `STUCK_JOB [${gate}]: ${reason}`, detail);

  logger.warn({ jobId, gate, reason }, '[stuck] Job marked stuck — operator intervention required');

  // Check for repeated failures on this content type → auto-disable
  checkContentTypeStuckPattern(card.contentType || 'unknown');
}
```

### 2 — `checkContentTypeStuckPattern()` — auto-disable on repeated failures

Add immediately after `markJobStuck()`:

```javascript
// In-memory counter: { 'news': [timestamp, timestamp, ...], 'nba': [...] }
const stuckPatternLog = {};

function checkContentTypeStuckPattern(contentType) {
  if (!contentType) return;
  const now = Date.now();
  const window24h = 24 * 60 * 60 * 1000;

  if (!stuckPatternLog[contentType]) stuckPatternLog[contentType] = [];

  // Prune entries older than 24h
  stuckPatternLog[contentType] = stuckPatternLog[contentType].filter(t => now - t < window24h);
  stuckPatternLog[contentType].push(now);

  const count = stuckPatternLog[contentType].length;
  logger.info({ contentType, stuckCount24h: count }, '[stuck-pattern] Stuck job count for content type');

  if (count >= 3) {
    // Auto-disable this content type with a notice
    if (!disabledContentTypes) global.disabledContentTypes = {};
    global.disabledContentTypes[contentType] = {
      disabledAt: new Date().toISOString(),
      reason: `Auto-disabled: ${count} stuck jobs in 24h for content type '${contentType}'. Manual investigation required before re-enabling.`,
      stuckCount: count
    };
    logger.error({ contentType, count }, '[stuck-pattern] Content type AUTO-DISABLED — too many stuck jobs');
  }
}
```

### 3 — Wire Gate 0 stuck alarm

In `lib/script_gen.js`, the Gate 0 hard fail for news is at line ~1491. After the existing hard fail `return res.status(400).json(...)`, call `markJobStuck` if a jobId is available:

```javascript
// Gate 0: no clips found after Puppeteer scrape
if (actualClipCount < expectedClipCount) {
  const missingStories = items.filter(i => !i.videoUrl).map(i => i.title || '(unknown)');
  const reason = `Gate 0: ${actualClipCount}/${expectedClipCount} stories have confirmed video clips. Missing: ${missingStories.join(' | ')}`;

  // Mark stuck if jobId is known (it may not be at script-gen time — non-fatal)
  if (jobId) markJobStuck(jobId, 'gate0', reason, { actualClipCount, expectedClipCount, missingStories });

  return res.status(400).json({
    ok: false,
    error: reason,
    errorCode: 'NEWS_CLIP_GATE_FAIL',
    expectedClipCount,
    actualClipCount,
    missingStories
  });
}
```

### 4 — Wire Gate 1 stuck alarm

In `lib/script_gen.js`, the retry loop exits after `MAX_RETRIES` (currently 2). After the loop, if score is still <70 and retries exhausted:

```javascript
// After retry loop — if still failing, mark stuck
if (scriptQA.score < 70) {
  const reason = `Gate 1: Script failed after ${MAX_RETRIES} retries. Final score: ${scriptQA.score}/100. Last FIX_DIRECTIVE: ${JSON.stringify(scriptQA.fixDirective || {}).slice(0, 300)}`;
  if (jobId) markJobStuck(jobId, 'gate1', reason, { score: scriptQA.score, retries: MAX_RETRIES, fixDirective: scriptQA.fixDirective });

  return res.status(400).json({
    ok: false,
    error: reason,
    errorCode: 'GATE1_EXHAUSTED',
    score: scriptQA.score
  });
}
```

### 5 — Wire Gate 3 stuck alarm

In `lib/assembly.js`, Gate 3 retry is the surgical fix (freeze removal + re-normalize). After the surgical retry, if Gate 3 still fails:

```javascript
// After Gate 3 surgical retry — still failing
if (qaResult.outcome === 'fail') {
  const reason = `Gate 3: Assembly failed after surgical fix. Score: ${qaResult.score}/100. Report: ${(qaResult.report || '').slice(0, 400)}`;
  // markJobStuck is a server.js function — pass it in via assemblyOptions or call via an HTTP endpoint
  // Option: POST /job/:id/stuck from assembly.js (avoids circular dep)
  try {
    await axios.post(`http://localhost:${process.env.PORT || 3000}/job/${asmId}/stuck`, {
      gate: 'gate3',
      reason,
      detail: { score: qaResult.score, report: qaResult.report }
    });
  } catch (e) {
    logger.warn({ asmId }, `[stuck] Failed to POST /job/stuck: ${e.message}`);
  }

  assemblyJobs[asmId].status = 'stuck';
  assemblyJobs[asmId].stuckReason = reason;
  log(asmId, `🚨 STUCK: Gate 3 exhausted. ${reason}`);
  return;
}
```

### 6 — Add `POST /job/:id/stuck` endpoint in `server.js`

```javascript
// POST /job/:id/stuck — called by assembly.js (lib/) to mark a job stuck
// without creating a circular dependency on server.js helpers.
app.post('/job/:id/stuck', async (req, res) => {
  const { id } = req.params;
  const { gate, reason, detail } = req.body;
  if (!id || !gate || !reason) return res.status(400).json({ ok: false, error: 'id, gate, reason required' });
  markJobStuck(id, gate, reason, detail || {});
  return res.json({ ok: true });
});
```

### 7 — Dashboard stuck card UI (`cwn_production.html`)

In the job card render function, add a stuck state visual alongside the existing `failed` state:

```javascript
// In renderJobCard() or equivalent — after failed state handling:
if (card.status === 'stuck') {
  statusBadge = `<span class="badge badge-stuck">🚨 STUCK</span>`;
  stuckPanel = `
    <div class="stuck-panel">
      <div class="stuck-gate">Stuck at: ${card.stuckAt || 'unknown gate'}</div>
      <div class="stuck-reason">${escapeHtml(card.stuckReason || 'No reason provided')}</div>
      <div class="stuck-actions">
        <button onclick="killJob('${card.jobId}')" class="btn btn-danger">⛔ Kill Job</button>
      </div>
    </div>
  `;
}
```

Add CSS for `.badge-stuck` and `.stuck-panel`:

```css
.badge-stuck { background: #b71c1c; color: #fff; padding: 2px 8px; border-radius: 4px; font-weight: bold; }
.stuck-panel { background: #1a0000; border: 1px solid #b71c1c; border-radius: 6px; padding: 12px; margin-top: 8px; }
.stuck-panel .stuck-gate { color: #ff5252; font-weight: bold; margin-bottom: 4px; }
.stuck-panel .stuck-reason { color: #ffcdd2; font-size: 13px; margin-bottom: 10px; white-space: pre-wrap; }
```

Add `killJob()` function if not present:

```javascript
async function killJob(jobId) {
  if (!confirm(`Kill job ${jobId}? This stops all retries and removes the job card.`)) return;
  try {
    const r = await fetch(`/job/${jobId}`, { method: 'DELETE' });
    const data = await r.json();
    if (data.ok) removeJobCard(jobId);
    else alert('Kill failed: ' + (data.error || 'unknown error'));
  } catch (e) {
    alert('Kill request failed: ' + e.message);
  }
}
```

### 8 — `GET /content-type-status` endpoint (dashboard notice for auto-disabled types)

```javascript
// Returns which content types are auto-disabled and why
app.get('/content-type-status', (req, res) => {
  res.json({
    disabled: global.disabledContentTypes || {},
    stuckCounts: Object.fromEntries(
      Object.entries(stuckPatternLog).map(([type, times]) => [type, times.length])
    )
  });
});
```

Dashboard polls this on init and shows a banner if any content type is disabled:

```javascript
// In dashboard init (after restoreJobsFromServer):
async function checkContentTypeStatus() {
  try {
    const r = await fetch('/content-type-status');
    const data = await r.json();
    for (const [type, info] of Object.entries(data.disabled || {})) {
      showSystemNotice(`⚠️ ${type.toUpperCase()} auto-disabled: ${info.reason}`, 'error');
    }
  } catch (_) {}
}
checkContentTypeStatus();
```

---

## Files to Modify

| File | Change |
|------|--------|
| `server.js` | Add `markJobStuck()`, `checkContentTypeStuckPattern()`, `stuckPatternLog`, `POST /job/:id/stuck`, `GET /content-type-status`; wire Gate 0/1 stuck calls in `/generate-full-script` path |
| `lib/script_gen.js` | Wire Gate 0 stuck call after clip gate fail; wire Gate 1 stuck call after retry loop exhaustion |
| `lib/assembly.js` | Wire Gate 3 stuck call via `POST /job/:id/stuck` after surgical retry fails |
| `cwn_production.html` | Stuck card UI: badge, panel, reason, Kill Job button; `killJob()` function; `checkContentTypeStatus()` on init |

---

## Do Not Break

1. `saveJobCard()` must remain the only writer to `persistedJobs` — `markJobStuck()` calls it, doesn't bypass it
2. `logError()` call in `markJobStuck()` — confirm `logError` is importable in server.js scope before using it
3. `DELETE /job/:id` endpoint — `killJob()` in dashboard calls this. Confirm it exists (or add it). It should remove from `persistedJobs` and call `saveJobCard` with a tombstone or just delete the key.
4. `disabledContentTypes` is in-memory only — resets on server restart. This is intentional (temporary disable, not permanent). Don't persist to disk.
5. Gate 2 (HeyGen) stuck wiring is **not** in scope for this handoff — HeyGen polling lives in `server.js` `startHeyGenPoller()`. Add Gate 2 stuck in a follow-up once Gates 0/1/3 are wired.

---

## Testing

```bash
# 1. Trigger Gate 1 stuck manually
# Edit MAX_RETRIES = 0 in lib/script_gen.js temporarily, run a news script gen
# Expected: STUCK_JOB log entry + card.status === 'stuck' in GET /jobs

# 2. Check stuck card appears in dashboard
# Open http://localhost:8765/cwn_production.html
# Restore jobs — stuck card should show 🚨 STUCK badge + reason + Kill Job button

# 3. Test auto-disable pattern
# Trigger 3 stuck jobs for same content type in quick succession (lower threshold to 2 for test)
# Expected: GET /content-type-status returns { disabled: { news: { reason: '...' } } }
# Dashboard shows: ⚠️ NEWS auto-disabled banner
```

---

## STATUS.md Update (Required)

Before committing, update STATUS.md → `🤖 Last Agent Action`:

```
| Cline-A | feat(qa): unified STUCK_JOB escalation across all gates — markJobStuck() + checkContentTypeStuckPattern() in server.js; Gate 0/1/3 wiring; stuck card UI in dashboard | server.js, lib/script_gen.js, lib/assembly.js, cwn_production.html, STATUS.md | [hash] | [ts] |
```
