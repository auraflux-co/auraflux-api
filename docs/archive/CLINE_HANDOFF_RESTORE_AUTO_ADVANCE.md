# CLINE_HANDOFF_RESTORE_AUTO_ADVANCE.md

**Author:** Claude Code, 2026-04-14
**For:** Cline
**Scope:** Restore three missing auto-advance links in `cwn_production.html` so the pipeline runs Stage 1 → Stage 6 hands-off, per `GATED_PIPELINE_ARCHITECTURE.md`. Only Gate 7 (Rob reviews private drafts on the platform itself) is a human checkpoint — nothing in the dashboard should require a button click on the happy path.
**Ship as:** ONE commit (all three fixes are tightly coupled — a partial restore would leave the pipeline broken in a different place).
**Do NOT touch:** `server.js` (all fixes are dashboard-side), Gate 1 auto-advance at line ~5406 (already restored in hotfix 8), the `approveAndUpload` function body at line 5083 (wire it differently — see Fix 2).
**Before the commit:** Re-read `COMMIT_CHECKLIST.md`. Update `STATUS.md` → 🤖 Last Agent Action table. Hard refresh the dashboard to bust cache before smoke testing.

---

## Spec authority

`GATED_PIPELINE_ARCHITECTURE.md` lines 260-334 define the pipeline:

```
Stage 1: Script Gen → Gate 1 (Claude Script QA) → PASS → auto
Stage 2: Segment parsing → Gate 2 (pure code structure) → PASS → auto
Stage 3: HeyGen render → Gate 3 (Gemini segment QA on samples) → PASS → auto
Stage 4: FFmpeg assembly → Gate 4 (pure code structure) → PASS → auto
Stage 5: Full video QA → Gate 5 (Gemini full playback) → PASS → status='publishable' → auto
Stage 6: Drive upload + Upload-Post → Gate 6 (API confirmation) → PASS → status='platform_review_pending'
Stage 7: Rob reviews drafts on YouTube / TikTok / IG (HUMAN, NOT IN DASHBOARD)
```

Definition of Done (`QA_GATES.md` line 56): **"Full automation runs without manual intervention."** Any dashboard button that Rob has to click on the happy path is a regression against this spec.

---

## Current state audit (completed by Claude Code 2026-04-14)

**Wired correctly:**
- Line ~5406 `displayScriptQA` Gate 1 PASS → `setTimeout(sendToHeyGen, 500)` (hotfix 8, commit `522ea7d`)
- Line 1636 `setTimeout(function(){ triggerGate5(job); }, 2000)` fires after assembly download completes
- `assembleJob()` at line 1378 — function itself is correct, just not auto-called

**Broken (this handoff fixes all three):**
1. HeyGen all-segments-complete → no auto-call to `triggerGate2()` + `assembleJob()`. `triggerGate2` defined at line 4325 but has ZERO call sites anywhere in the file. Dead code since commit `599f602` (April 5).
2. Gate 5 PASS (≥85) → renders a "✅ APPROVE & UPLOAD" button at line 1703 instead of auto-firing `approveAndUpload(job.id)`. Architecturally wrong — the architecture doc puts the human checkpoint at Stage 7 (on the platform), not at Stage 6.
3. publishPrep (title/desc/hashtags) is only generated via manual `navToPublishPrep` navigation. Upload-Post at line 5101 reads `job.publishPrep || {}` and will send empty metadata if publishPrep was never generated.

---

## Fix 1 — HeyGen all-segments-complete → auto Gate 2 + assembleJob

**File:** `cwn_production.html`
**Location:** Inside `sendToHeyGen()`, inside the `pollVideo` completion callback at line ~4214-4218.

### Before

```javascript
      pollVideo(videoId,
        function(status,pct){ segJob.status=status; batchJob.pct=Math.round((avatarIdx/avatarOnly.length)*50+pct*0.5); saveJobs(); renderQueue(); },
        function(pollErr,data){
          if(pollErr){ segJob.status='failed'; }
          else { segJob.status='completed'; segJob.url=data.video_url; }
          saveJobs(); renderQueue();
        }
      );
```

### After

```javascript
      pollVideo(videoId,
        function(status,pct){ segJob.status=status; batchJob.pct=Math.round((avatarIdx/avatarOnly.length)*50+pct*0.5); saveJobs(); renderQueue(); },
        function(pollErr,data){
          if(pollErr){ segJob.status='failed'; }
          else { segJob.status='completed'; segJob.url=data.video_url; }
          saveJobs(); renderQueue();

          // ── Auto-advance: HeyGen done → Gate 2 segment QA → assembleJob ──
          // Per GATED_PIPELINE_ARCHITECTURE.md Stage 3 → Stage 4: no human
          // checkpoint between HeyGen render completion and FFmpeg assembly.
          // Only fires once per batchJob (guarded by _autoAssembleFired).
          // A segment in 'failed' state is considered "done" for the purpose
          // of advancing — assembleJob will skip/retry failed segments.
          var avatarSegs = (batchJob.segments || []).filter(function(s){ return s.type === 'avatar'; });
          var allDone = avatarSegs.length > 0 && avatarSegs.every(function(s){
            return s.status === 'completed' || s.status === 'failed';
          });
          if (allDone && !batchJob._autoAssembleFired) {
            batchJob._autoAssembleFired = true;
            batchJob.status = 'all_sent';
            batchJob.pct = 50;
            saveJobs(); renderQueue();
            cwn_log('[auto-advance] All HeyGen segments done — firing Gate 2 + assembleJob for ' + batchJob.id, false);
            console.log('[auto-advance] HeyGen complete → triggerGate2 + assembleJob');
            try { triggerGate2(batchJob); } catch(e) { console.error('[auto-advance] triggerGate2 threw:', e); }
            // 3-second gap lets Gate 2 request start before FFmpeg kicks in —
            // assembleJob runs server-side anyway, so they don't compete for
            // browser resources. The delay is cosmetic, for log readability.
            setTimeout(function(){
              try { assembleJob(batchJob.id); } catch(e) { console.error('[auto-advance] assembleJob threw:', e); }
            }, 3000);
          }
        }
      );
```

### Why it's safe

- Guard flag `_autoAssembleFired` ensures the callback only fires once even if multiple `pollVideo` completions land simultaneously (JS is single-threaded so this is belt+braces, not strictly necessary, but cheap insurance).
- `failed` segments are treated as "done" — assembly will report the failure and rollback works from there. Better than hanging forever waiting on a segment that will never complete.
- Manual ⚙ ASSEMBLE button at line 2229 is preserved as a fallback for the `restoreJobsFromServer` recovery path (where `_autoAssembleFired` is never set, so a manual click still works).

---

## Fix 2 — Gate 5 PASS (≥85) → auto-publish

**File:** `cwn_production.html`
**Location:** Inside `triggerGate5()` completion handler at line ~1687-1709.

### Before

```javascript
      if (result.score >= 85) {
        html += '<div style="font-size:10px;color:#2ecc71;margin-top:4px;">✅ Video quality confirmed — proceed to Publish Prep.</div>';
      }
      html += '</div>';

      if (qaEl) qaEl.innerHTML = html;

      // ── Gate 3: Show human approval checkpoint when Gate 5 passes ──
      if (result.score >= 85) {
        var approvalEl = document.getElementById('gate3-approval-' + job.id);
        if (approvalEl) {
          approvalEl.style.display = '';
          approvalEl.innerHTML = '<div style="margin-top:8px;padding:10px 12px;background:rgba(46,204,113,0.08);border:1px solid rgba(46,204,113,0.4);border-radius:4px;">'
            + '<div style="font-size:9px;letter-spacing:2px;color:#2ecc71;font-weight:900;margin-bottom:6px;">✅ GATE 3 — READY FOR UPLOAD</div>'
            + '<div style="font-size:11px;color:rgba(255,255,255,0.7);margin-bottom:8px;">Gate 5 passed (' + result.score + '/100). Approve to publish to all platforms, or reject to keep in review.</div>'
            + '<div style="display:flex;gap:8px;flex-wrap:wrap;">'
            + '<button onclick="approveAndUpload(\'' + job.id + '\')" class="btn btn-gold btn-sm">✅ APPROVE &amp; UPLOAD →</button>'
            + '<button onclick="rejectJob(\'' + job.id + '\')" class="btn btn-outline btn-sm" style="border-color:rgba(231,76,60,0.5);color:#e74c3c;">❌ REJECT — BACK TO EDIT</button>'
            + '</div>'
            + '<div id="gate3-upload-status-' + job.id + '" style="margin-top:6px;font-size:11px;font-family:monospace;color:rgba(255,255,255,0.4);"></div>'
            + '</div>';
        }
      }

      renderQueue();
```

### After

```javascript
      if (result.score >= 85) {
        html += '<div style="font-size:10px;color:#2ecc71;margin-top:4px;">✅ Video quality confirmed — auto-publishing to platforms.</div>';
      }
      html += '</div>';

      if (qaEl) qaEl.innerHTML = html;

      // ── Auto-advance: Gate 5 PASS → generate publish copy → approveAndUpload ──
      // Per GATED_PIPELINE_ARCHITECTURE.md Stage 5 → Stage 6 → Stage 7:
      // Stage 5 PASS sets status='publishable' and Stage 6 (Drive + Upload-Post)
      // is pure-code automation. The only human checkpoint is Stage 7 (Rob
      // reviewing drafts on YouTube/TikTok/IG themselves — NOT in the dashboard).
      // Any button here is a regression against the spec's "full automation
      // runs without manual intervention" definition of done.
      if (result.score >= 85 && !job._autoPublishFired) {
        job._autoPublishFired = true;
        // Render a status banner so Rob can see the auto-publish in progress
        // (and still has a manual REJECT escape hatch if Gemini's Gate 5 score
        // was wrong about broadcast readiness).
        var approvalEl = document.getElementById('gate3-approval-' + job.id);
        if (approvalEl) {
          approvalEl.style.display = '';
          approvalEl.innerHTML = '<div style="margin-top:8px;padding:10px 12px;background:rgba(46,204,113,0.08);border:1px solid rgba(46,204,113,0.4);border-radius:4px;">'
            + '<div style="font-size:9px;letter-spacing:2px;color:#2ecc71;font-weight:900;margin-bottom:6px;">✅ GATE 5 PASS — AUTO-PUBLISHING</div>'
            + '<div style="font-size:11px;color:rgba(255,255,255,0.7);margin-bottom:8px;">Gate 5 passed (' + result.score + '/100). Generating publish copy → Upload-Post → YouTube/TikTok/IG as private draft.</div>'
            + '<div id="gate3-upload-status-' + job.id + '" style="margin-top:6px;font-size:11px;font-family:monospace;color:rgba(255,255,255,0.4);">⏳ Generating title, description, and hashtags...</div>'
            + '<button onclick="rejectJob(\'' + job.id + '\')" class="btn btn-outline btn-sm" style="margin-top:6px;border-color:rgba(231,76,60,0.5);color:#e74c3c;">❌ REJECT — STOP AUTO-PUBLISH</button>'
            + '</div>';
        }
        cwn_log('[auto-advance] Gate 5 PASS (' + result.score + '/100) — auto-generating publish copy then firing Upload-Post', false);
        console.log('[auto-advance] Gate 5 → autoGeneratePublishPrep → approveAndUpload');
        // Fix 3 wires autoGeneratePublishPrep. It generates publish copy and
        // then calls approveAndUpload when done. Defined below.
        setTimeout(function(){
          try { autoGeneratePublishPrep(job.id); } catch(e) { console.error('[auto-advance] autoGeneratePublishPrep threw:', e); }
        }, 1500);
      }

      renderQueue();
```

### Why it's safe

- `_autoPublishFired` guard prevents double-firing if `triggerGate5` ever runs twice on the same job.
- REJECT button is preserved so Rob can interrupt an auto-publish that Gemini mis-scored.
- `approveAndUpload` at line 5083 is untouched — only the caller changes. Gate 7 (Rob on the platform) remains the final human checkpoint, which the architecture doc explicitly designates as "the top of the chain."

---

## Fix 3 — Auto-generate publishPrep before Upload-Post fires

**File:** `cwn_production.html`
**Location:** Add new helper function near `approveAndUpload` (line 5083). Suggested insert point: immediately before `function approveAndUpload` at line ~5082.

### What it does

The existing `generatePublishCopy()` function at ~line 6060 is tightly coupled to the Publish Prep DOM (`g('pub-tt-caption')`, `pubDisplay(...)`, etc) — it can't be reused headlessly because it assumes Rob is viewing the prep screen. We need a parallel headless version that:

1. Hits `/generate-publish-copy` with job context
2. Stores result directly on `job.publishPrep` without touching the prep UI
3. Calls `approveAndUpload(jobId)` when done
4. Updates the `gate3-upload-status-{jobId}` inline status div on the job card so Rob can watch it

### Implementation

```javascript
// ── Auto-fire publish copy generation (headless) ──────────────────
// Called by Fix 2's Gate 5 auto-advance. Generates title/description/
// hashtags without opening the Publish Prep screen, stores on
// job.publishPrep, then fires approveAndUpload(jobId) to trigger
// Upload-Post → YouTube/TikTok/IG private drafts. Per
// GATED_PIPELINE_ARCHITECTURE.md Stage 5 → Stage 6, this entire step
// is pure automation — Gate 7 (Rob reviewing drafts on the platforms
// themselves) is the first human checkpoint.
function autoGeneratePublishPrep(jobId) {
  var job = JOBS.find(function(j){ return j.id === jobId; });
  if (!job) { console.error('[autoGeneratePublishPrep] Job not found:', jobId); return; }

  var statusEl = document.getElementById('gate3-upload-status-' + jobId);
  var setStatus = function(txt, isErr) {
    if (statusEl) {
      statusEl.textContent = txt;
      statusEl.style.color = isErr ? '#e74c3c' : 'rgba(255,255,255,0.6)';
    }
  };

  // If publishPrep was already generated (e.g. Rob pre-ran the prep screen
  // before the pipeline finished), skip straight to approveAndUpload.
  if (job.publishPrep && job.publishPrep.title) {
    cwn_log('[autoGeneratePublishPrep] publishPrep already exists — skipping generation, firing approveAndUpload', false);
    setStatus('⏳ Publish copy ready — firing Upload-Post...');
    setTimeout(function(){ approveAndUpload(jobId); }, 500);
    return;
  }

  setStatus('⏳ Generating title, description, and hashtags...');

  var type = (job.type || 'twitch').toLowerCase();
  var contentTypeKey = type.indexOf('nba') > -1 ? 'nba'
    : type.indexOf('twitch') > -1 ? 'twitch'
    : 'news';
  var isShort = (job.format === 'portrait') || (type.indexOf('short') > -1);
  var scriptContext = job.script || '';
  var streamersList = (contentTypeKey === 'twitch' && Array.isArray(job.streamers)) ? job.streamers : [];
  var today = new Date().toLocaleDateString([], {weekday:'long', month:'long', day:'numeric', year:'numeric'});

  var xhr = new XMLHttpRequest();
  xhr.open('POST', CFG.ffmpegUrl + '/generate-publish-copy', true);
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.timeout = 60000;
  xhr.onload = function() {
    try {
      var resp = JSON.parse(xhr.responseText);
      if (resp.error) throw new Error(resp.error);

      var yt = (resp.platforms && resp.platforms.youtube) || resp;
      var tt = (resp.platforms && resp.platforms.tiktok) || {};
      var ig = (resp.platforms && resp.platforms.instagram) || {};

      job.publishPrep = {
        title:         yt.title || resp.title || job.title || 'ClipzWorld News',
        description:   yt.description || resp.description || '',
        pinnedComment: yt.pinnedComment || resp.pinnedComment || '',
        endscreen:     yt.endscreen || '',
        cards:         yt.cards || '',
        twitchTitle:   yt.twitchTitle || '',
        tiktokCaption: tt.caption || '',
        igCaption:     ig.caption || '',
        igAlt:         ig.altText || ig.alt_text || '',
        generatedAt:   new Date().toISOString(),
        autoGenerated: true
      };
      saveJobs();
      cwn_log('[autoGeneratePublishPrep] Publish copy generated for ' + jobId + ' — firing approveAndUpload', false);
      setStatus('⏳ Publish copy ready — firing Upload-Post...');
      renderQueue();
      setTimeout(function(){ approveAndUpload(jobId); }, 500);
    } catch(e) {
      console.error('[autoGeneratePublishPrep] Parse error:', e);
      setStatus('❌ Publish copy generation failed: ' + e.message + '. Click 📋 PUBLISH COPY to run manually.', true);
      cwn_log('[autoGeneratePublishPrep] Failed: ' + e.message, true);
    }
  };
  xhr.onerror = xhr.ontimeout = function() {
    var msg = xhr.ontimeout ? 'Request timed out' : 'Server unreachable';
    setStatus('❌ ' + msg + '. Click 📋 PUBLISH COPY to run manually.', true);
    cwn_log('[autoGeneratePublishPrep] ' + msg, true);
  };

  xhr.send(JSON.stringify({
    contentType: contentTypeKey,
    formType:    isShort ? 'short' : 'long',
    script:      scriptContext,
    date:        today,
    streamers:   streamersList,
    platforms:   ['youtube', 'tiktok', 'instagram']
  }));
}
```

### Why it's safe

- Never touches the Publish Prep DOM — won't conflict with Rob using the manual prep screen for other jobs.
- Respects existing publishPrep if Rob pre-ran it (the ChatGPT workaround path still works).
- Failure mode is graceful: if `/generate-publish-copy` fails, the status div prompts Rob to run it manually, and the pipeline halts there rather than shipping empty metadata to YouTube.
- The `autoGenerated: true` marker on publishPrep lets us track (in future metrics) how often the auto-path runs vs manual.

---

## Verification

After shipping the commit, hard-refresh the dashboard and run one News smoke test end-to-end. Expected console sequence:

```
[gate1] Auto-firing sendToHeyGen() after clean Gate 1 pass
[parseSegments_v2_json] Produced 27 segments (22 avatar + 5 source_clip)
... (HeyGen renders finish over ~6 minutes) ...
[auto-advance] HeyGen complete → triggerGate2 + assembleJob
... (FFmpeg assembly ~5 minutes) ...
(Gate 5 review via triggerGate5)
[auto-advance] Gate 5 → autoGeneratePublishPrep → approveAndUpload
[autoGeneratePublishPrep] Publish copy generated for <jobId> — firing approveAndUpload
(Upload-Post fires)
(Gate 6 confirms job_id for YouTube/TikTok/IG)
```

Rob's only job during a smoke test: select stories, click Generate. Then wait and watch. The pipeline should land on YouTube as private draft without any other dashboard click.

**Manual override buttons preserved (for recovery/rollback scenarios):**
- ⚙ ASSEMBLE on job card — still works for restored jobs
- ↩ ROLLBACK / ⏭ FORCE ADVANCE — unchanged
- ❌ REJECT — STOP AUTO-PUBLISH — new, interrupts Fix 2 auto-publish
- 📋 PUBLISH COPY nav button — still works for manual prep

---

## Commit message

```
fix(dashboard): restore three auto-advance links for hands-off pipeline

Per GATED_PIPELINE_ARCHITECTURE.md Stages 3→4, 5→6, and the Definition
of Done in QA_GATES.md ("full automation runs without manual
intervention"), the pipeline should flow from Gate 1 PASS all the way
through Upload-Post private drafts without any dashboard button click.
Gate 7 — Rob reviewing drafts on YouTube/TikTok/IG themselves — is the
only human checkpoint.

Three auto-advances were missing (likely regressed during the
parseSegments_v2 rewrite on 2026-04-11 and the rollback/force-advance
commit the same day):

1. HeyGen all-segments-complete → triggerGate2 + assembleJob
   - triggerGate2 was defined in commit 599f602 (2026-04-05) but the
     call site was never committed. Dead code since.
   - New: pollVideo completion callback now checks if every avatar
     segment is done (completed OR failed), guards with
     _autoAssembleFired, and fires triggerGate2 + assembleJob.

2. Gate 5 PASS (≥85) → approveAndUpload
   - triggerGate5 was rendering an ✅ APPROVE & UPLOAD button at
     line 1703, treating this as a human checkpoint. Architecturally
     wrong — the architecture doc puts Rob's checkpoint at Stage 7
     (private drafts on the platforms themselves), not in the
     dashboard.
   - New: Gate 5 pass now renders a status banner + REJECT escape
     hatch and fires autoGeneratePublishPrep → approveAndUpload
     automatically.

3. publishPrep auto-generation
   - Existing generatePublishCopy() at line 6060 is tightly coupled
     to the Publish Prep DOM and can't be reused headlessly.
   - New: autoGeneratePublishPrep(jobId) — headless parallel function
     that hits /generate-publish-copy, stores result on
     job.publishPrep, then fires approveAndUpload. Respects
     pre-existing publishPrep (e.g. Rob's ChatGPT workaround).
     Graceful failure: prompts manual run if /generate-publish-copy
     errors.

Preserved manual escape hatches: ⚙ ASSEMBLE button (for restored jobs),
REJECT button during auto-publish, 📋 PUBLISH COPY nav, ↩ ROLLBACK,
⏭ FORCE ADVANCE.

Verification: hard-refresh dashboard, run News smoke test end-to-end.
Expected: zero clicks between "select stories + Generate" and YouTube
private draft.

References: GATED_PIPELINE_ARCHITECTURE.md lines 260-334, QA_GATES.md
Definition of Done line 56, 2026-04-14 Claude Code audit of dashboard
auto-advance regressions.
```

---

## Not covered by this handoff (explicitly deferred)

- **Quality of /generate-publish-copy output** — Rob's memory flags that he uses ChatGPT instead because the endpoint's output is mediocre. This handoff wires up the auto-call but doesn't improve the prompt. Improving the title/desc prompt is a separate task for a later handoff.
- **Gate 6 retry logic** — architecture doc line 304 lists "Retry Drive upload (transient network)" and "Retry Upload-Post with exponential backoff" as fix strategies. Not currently implemented. Out of scope.
- **Gate 2 auto-fix loop for segment structure failures** — `proceedToHeyGenWithSegments` at line 3977 handles the Gate 2 auto-fix → HeyGen re-send flow; this handoff doesn't touch it.
- **Dashboard audit log for auto-advance events** — nice-to-have, not blocking. Follow-up.

---

## Priority

**Ship this full commit before the next smoke test.** Partial is worse than none: if only Fix 1 ships, the pipeline stalls at Gate 5 instead of stalling at HeyGen done. If only Fix 2 ships without Fix 1, Gate 5 never fires because assembly never runs. All three go together or none.

Expected time: 20-30 minutes including the smoke test verification.
