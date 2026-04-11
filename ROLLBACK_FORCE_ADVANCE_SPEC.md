# Rollback + Force-Advance Spec

**Status:** ✅ Shipped in `eac1073` (2026-04-10) — both backend endpoints AND dashboard UI landed together. This doc is now the authoritative reference for how the feature works and what to verify.

**Owner:** Cline (implementation) | Claude Code (spec author)
**Depends on:** Job persistence (`33a8800`) + dashboard restore (`cfe2200`)

**Commit:** `eac1073` — `feat: pipeline rollback + force-advance for every stage`
- `server.js` — `POST /job/:id/rollback`, `POST /job/:id/advance`, `detectStage()` helper (+125 lines)
- `cwn_production.html` — `↩ ROLLBACK` + `⏭ FORCE ADVANCE` buttons on every job card, `rollbackJob()` + `advanceJob()` JS handlers (+80 lines)

---

## Problem Statement

Production pipeline is a 4-stage state machine:

```
script_ready → all_sent → assembled → published
```

When a stage gets stuck (HeyGen timeout, Gate 5 server error, Upload-Post hiccup) or a run needs to be redone (wrong script landed, bad assembly), the operator has no programmatic escape hatch. Today they have to:

- Delete the job card from localStorage and re-send — loses all context
- Edit `data/jobs.json` by hand — error-prone
- Wait for a gate that will never return — blocks the pipeline

**Required:**
1. **Rollback** — move a job from its current stage back one stage, clearing data from the current stage so the previous stage's action button re-appears.
2. **Force-advance** — skip a stuck gate by marking it `force_pass`, so the next action button appears. Quality checks are **not re-run**; this is a deliberate override.

Both operate on the persisted job card in `data/jobs.json` (loaded into `persistedJobs` at server startup — `server.js:115-120`).

---

## Stage Machine

```
         ┌─────────────┐  SEND TO HEYGEN   ┌──────────┐  ASSEMBLE  ┌───────────┐  APPROVE  ┌───────────┐
  (new)─▶│script_ready │──────────────────▶│ all_sent │──────────▶│ assembled │──────────▶│ published │
         └─────────────┘                   └──────────┘            └───────────┘           └───────────┘
               ▲                                 ▲                       ▲                       │
               │       ← rollback ─              │   ← rollback ─        │   ← rollback ─        │
               └─────────────────────────────────┴───────────────────────┴───────────────────────┘
```

**Stage detection** — `detectStage(card)` helper (`server.js`, uncommitted) derives stage from card fields, used when `card.stage` is missing (older jobs):

```js
function detectStage(card) {
  if (card.publishRecord && card.publishRecord.publishedAt) return 'published';
  if (card.assembledAt || card.finalUrl)                    return 'assembled';
  if (card.heygen?.videoJobs?.length)                       return 'all_sent';
  if (card.script && card.script.length > 10)               return 'script_ready';
  return 'unknown';
}
```

**Force-advance adds transitional stages:** `gate1_forced`, `gate2_forced`, `gate5_forced`. These are terminal-for-that-gate markers — the dashboard should treat them like a passed gate and show the next action button.

---

## Backend Endpoints (Cline, in progress)

### `POST /job/:id/rollback`

Rolls the job back one stage.

**Request:** `POST /job/abc123/rollback`
**Response:**
```json
{ "ok": true, "jobId": "abc123", "before": "assembled", "after": "all_sent",
  "message": "Assembly cleared — click REFRESH IDs then ASSEMBLE again." }
```

**Per-stage cleanup rules:**

| From → To | Fields cleared on card |
|-----------|------------------------|
| `published` → `assembled` | `publishRecord`, `_gate3Approved` (keeps `finalUrl` — no re-assemble needed) |
| `assembled` → `all_sent` | `assembledAt`, `finalUrl`, `outputPath`, `gate5`, `_gate5Done`, `_gate5Running`, `_gate3Approved`, `_gate3Rejected`; resets every `heygen.videoJobs[*]._url = null` so REFRESH IDs re-appears |
| `all_sent` → `script_ready` | Deletes `heygen.videoJobs[*].video_id`; clears `gate2` |
| `script_ready` → (none) | Returns error: "nothing to roll back to" |

**After every rollback:** `saveJobCard(jobId, card)` persists the update. Dashboard should refetch `/jobs` (or the specific card) to re-render.

### `POST /job/:id/advance`

Force-passes the current gate so the next action button appears.

**Request:** `POST /job/abc123/advance`
**Response:**
```json
{ "ok": true, "jobId": "abc123", "before": "all_sent", "after": "gate2_forced",
  "message": "Gate 2 force-passed — 5 segment(s) marked. Click REFRESH IDs to get real URLs, then ASSEMBLE." }
```

**Per-stage advance rules:**

| From → To | Side effects |
|-----------|-------------|
| `script_ready` → `gate1_forced` | Sets `card.gate1 = { outcome: 'force_pass', score, forcedAt }`. SEND TO HEYGEN becomes available. |
| `all_sent` → `gate2_forced` | For each `videoJobs[*]` without `_url` but with `video_id`, marks `_forcedComplete: true`. Sets `gate2.outcome = 'force_pass'`. Returns count of segments forced. Operator must still click REFRESH IDs for real URLs before ASSEMBLE. |
| `assembled` → `gate5_forced` | Sets `gate5 = { outcome: 'force_pass', score, forcedAt }` and `_gate5Done = true`. APPROVE & UPLOAD becomes available. |
| `published` | Returns error: "cannot advance further" |

**Key rule:** Force-advance never fabricates URLs, never skips file downloads, never replaces real QA scores. It only unlocks the next button by marking the current gate `force_pass`. If the underlying data (e.g. HeyGen segments) isn't actually ready, the NEXT stage will still fail — this is by design.

---

## Dashboard Integration (✅ shipped in `eac1073`)

Implemented in `cwn_production.html`:

### Per-job-card controls

Add two buttons to every job card, always visible:

```
[↩ ROLLBACK STAGE]  [⏭ FORCE ADVANCE]
```

**Placement:** Bottom of the card, same row as existing REFRESH IDs / ASSEMBLE buttons, but styled as secondary (outlined, not filled) to indicate they're escape hatches not primary actions.

**Behavior:**
- `ROLLBACK STAGE` — `confirm()` prompt with current stage + target stage, then `POST /job/:id/rollback`, then re-fetch card and re-render.
- `FORCE ADVANCE` — `confirm()` prompt warning that QA is being skipped, then `POST /job/:id/advance`, then re-fetch card and re-render.

**Confirmation copy:**
```
ROLLBACK:
  "Roll this job back from [assembled] to [all_sent]?
   This will clear the assembled MP4 and Gate 5 results.
   You'll need to click REFRESH IDs then ASSEMBLE again."

FORCE ADVANCE:
  "⚠ Force-advance past Gate 2 (HeyGen segment QA)?
   This SKIPS quality checks. Use only if the gate is stuck.
   The next stage (ASSEMBLE) may still fail if segments aren't ready."
```

### Audit trail

Every rollback/advance action should append to the card's log (dashboard side) so the operator can see who did what:

```
[9:45 PM] ↩ Rolled back: assembled → all_sent
[9:47 PM] ⏭ Force-advanced Gate 2 (3 segments marked)
```

Recommend also writing to `logs/errors.jsonl` server-side with `{level: 'warn', kind: 'rollback'|'advance', jobId, before, after, at}` so we have a persistent audit.

---

## Edge Cases & Risks

1. **Rollback from `published` keeps `finalUrl`** — intentional. The MP4 is still on disk and uploaded to Drive. Rolling back only clears the publish record so the operator can re-review and re-publish with different copy/platforms. If the user wants a full re-assemble, they rollback twice.

2. **Force-advance from `all_sent` without real segment URLs** — the backend marks segments `_forcedComplete` but does NOT fabricate `_url`. The dashboard message tells the operator to click REFRESH IDs to get real URLs. If they click ASSEMBLE without real URLs, FFmpeg will fail loudly (file not found). **This is correct** — we don't want silent bad assemblies.

3. **Stage drift between card field and `card.stage`** — `detectStage()` is the source of truth when `card.stage` is missing, but rollback/advance write to `card.stage` going forward. Older persisted cards (pre-rollback feature) will use detect; newer ones use the explicit field. Both paths need to work forever.

4. **Concurrent operations** — no locking. If the operator clicks ROLLBACK twice rapidly, the second call may see the already-rolled-back state and return a different result. Low risk for a single-operator tool; revisit if we add multi-user.

5. **No `gate1_forced` → `all_sent` path** — force-advancing Gate 1 only unlocks SEND TO HEYGEN. The actual HeyGen send is still a separate user action. Intentional: force-advance never sends network requests on behalf of the user.

6. **`persistedJobs` in-memory copy** — `saveJobCard()` updates both memory and disk. Rollback/advance mutate the in-memory object and then persist, so subsequent `GET /jobs` reads reflect the change immediately without a file re-read.

7. **No rollback from `script_ready`** — by design. If you want to kill a job before HeyGen, delete the card (separate endpoint not yet specified).

---

## Testing Checklist

Once dashboard integration lands, verify in this order:

- [ ] **Happy-path rollback `published → assembled`:** publish a short test job, click ROLLBACK, confirm APPROVE button reappears, click APPROVE again, verify new publish succeeds with different `request_id`.
- [ ] **Rollback `assembled → all_sent`:** assemble a job, click ROLLBACK, confirm segments return to `rendering` state and REFRESH IDs button reappears.
- [ ] **Rollback `all_sent → script_ready`:** send to HeyGen, click ROLLBACK, confirm script is preserved and SEND TO HEYGEN button reappears, confirm `video_id` is gone from all segments.
- [ ] **Rollback from `script_ready`:** should return error "nothing to roll back to".
- [ ] **Force-advance Gate 1:** on a brand-new script with no Gate 1 run, click FORCE ADVANCE, confirm SEND TO HEYGEN unlocks.
- [ ] **Force-advance Gate 2 with stuck HeyGen:** simulate by editing a segment's `video_id` but leaving `_url` null, click FORCE ADVANCE, confirm message shows N forced segments, then verify REFRESH IDs can still populate real URLs.
- [ ] **Force-advance Gate 5:** assemble a job, delete the `gate5` field to simulate a stuck Gate 5, click FORCE ADVANCE, confirm APPROVE button unlocks.
- [ ] **Force-advance from `published`:** should return "cannot advance further".
- [ ] **Persistence across restart:** roll back a job, restart the Node server, verify the rolled-back state is preserved in `data/jobs.json` and restored on page reload.
- [ ] **Audit trail:** verify both dashboard log AND `logs/errors.jsonl` capture rollback/advance events.

---

## Open Questions for Rob

1. **Per-stage permissions?** Should rollback from `published` require a stronger confirmation (e.g., type the job ID) since it affects already-published state? Currently just a single `confirm()`.
2. **Drive cleanup on rollback from assembled?** Currently `finalUrl` stays; the Drive file stays. Should rollback also delete the Drive file? (Recommend: no, keep as safety net, operator can delete manually.)
3. **Should rollback from `published` also attempt to unpublish on YouTube/TikTok/Instagram?** Upload-Post may not support post-publish deletion. (Recommend: out of scope, leave as manual operator task.)

---

## Related Files

- `server.js:115-135` — `persistedJobs`, `saveJobCard`, `JOBS_FILE` constant
- `server.js:894-920` — `GET /jobs` endpoint
- `server.js:~899-1030` — **new uncommitted** rollback + advance endpoints + `detectStage()` helper
- `data/jobs.json` — persisted job cards (runtime state, should be gitignored — see audit)
- `cwn_production.html` — `restoreJobsFromServer()` (added in `cfe2200`), needs rollback/advance button wiring
- `CLAUDE.md` — needs update to document the stage machine + escape hatches
- `STATUS.md` — track implementation progress

---

*Spec written 2026-04-10 by Claude Code to document Cline's in-flight implementation. Update as the dashboard integration lands.*
