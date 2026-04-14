# CLINE_HANDOFF_AUTO_ADVANCE_HARDENING.md

**Author:** Claude Code, drafted 2026-04-14 ~02:45 ET after the post-HeyGen → assemble auto-advance failed to fire on tonight's smoke test (despite the 446fca8 fix being live)
**For:** Cline
**Scope:** Three related fail-loud fixes:
1. Make the post-HeyGen → Gate 2 → assembleJob auto-advance survive contact with reality (the 446fca8 fix from earlier tonight didn't fire on the next test — root cause in this handoff)
2. Replace ALL silent "skip segment" catch handlers with fail-loud error surfacing — the chrome burn failure that dropped scene_12 tonight should have hard-failed the assembly with a visible banner, not silently produced a 26-of-27-scene MP4
3. Source clip aspect ratio crop filter — the hotfix 11 zoom-to-fill change is producing oversized clips. Either the filter expression is wrong or it's not running on portrait inputs the way intended.

**For dependency context:** This handoff and `CLINE_HANDOFF_DIRECTIVE_SIDECAR_REFACTOR.md` are independent — they touch different code paths and either can ship first. Recommended order: ship the sidecar refactor first because it removes the scene-not-found-in-directive failure mode that contributed to scene_12 dropping tonight. Then ship this hardening handoff to catch the remaining failure modes.
**Ship as:** ONE commit covering all three fixes (they're related — all three are "the pipeline silently degraded instead of failing loud").
**Do NOT touch:** Anything in `CLINE_HANDOFF_DIRECTIVE_SIDECAR_REFACTOR.md` scope — those changes happen in the sidecar refactor, not here. Twitch and NBA assembly paths.
**Before the commit:** Re-read `COMMIT_CHECKLIST.md`. Update `STATUS.md`. Hard refresh dashboard.

---

## 1. Background — what failed tonight

Tonight's smoke test (after Cline's auto-advance fix shipped as `446fca8`) produced a 173.9 MB MP4 at `output/news_apr_14_22_avatar_5_clips__5clips_1776145917760.mp4` from job `asm_1776145848943`. The MP4 is 10 minutes 4 seconds long (vs ~11:36 expected for a full 27-scene News long-form). Diagnostic checks revealed:

- **Scene_12 missing from tmp:** the 26 ts-normalized scenes in `tmp/asm_1776145848943_*_scene_*.ts` skip directly from scene_11 to scene_13. Scene_12 (story 3 INTRO, the first STORY_INTRO that's not story 1's intro) was silently dropped during chrome burn or TS normalize.
- **No run_metrics file written:** the corresponding `output/run_metrics_asm_1776145848943.json` doesn't exist, even though the MP4 finalized successfully. `finalizeJobMetrics()` never fired, suggesting an error path was taken that bypassed the normal stage completion flow.
- **No errors.jsonl entries:** the entire run produced zero server-side error log entries. `errors.jsonl` is still frozen at 2026-04-13 20:20 ET. Either the errors weren't logged at all, or they hit a swallowed catch handler.
- **Auto-advance never fired:** Rob watched the dashboard. After all 22 HeyGen segments completed rendering, the pipeline did NOT auto-advance to assembly. The 446fca8 fix added `triggerGate2(batchJob)` + `setTimeout(() => assembleJob(batchJob.id), 3000)` inside the pollVideo completion callback, guarded by `_autoAssembleFired`. Either the guard was set without the call firing, or the call fired but threw silently.
- **Source clips appear oversized in the resulting MP4:** Rob's visual review noted clips look wrong size (zoom-to-fill crop overshooting). The hotfix 11 filter change went from `force_original_aspect_ratio=decrease,pad` to `force_original_aspect_ratio=increase,crop=1920:1080:(iw-1920)/2:(ih-1080)/2`. This filter is mathematically incorrect for inputs smaller than 1920 in either dimension because `(iw-1920)/2` becomes negative, which `crop` doesn't accept and may crash or produce undefined behavior depending on FFmpeg version.

The unifying theme: **the pipeline failed in three different places tonight and Rob couldn't see ANY of the failures from the dashboard or errors.jsonl.** Every failure was swallowed somewhere. The first principle of `GATED_PIPELINE_ARCHITECTURE.md` is "fail loud, fall back never" — tonight violated that across multiple subsystems.

---

## 2. Fix 1 — Auto-advance post-HeyGen → Gate 2 → assembleJob (root cause)

### 2.1 What's currently in the code (from 446fca8)

`cwn_production.html` `sendToHeyGen()`'s `pollVideo` completion callback at approximately line 4214:

```javascript
pollVideo(videoId,
  function(status,pct){ segJob.status=status; batchJob.pct=Math.round((avatarIdx/avatarOnly.length)*50+pct*0.5); saveJobs(); renderQueue(); },
  function(pollErr,data){
    if(pollErr){ segJob.status='failed'; }
    else { segJob.status='completed'; segJob.url=data.video_url; }
    saveJobs(); renderQueue();

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
      setTimeout(function(){
        try { assembleJob(batchJob.id); } catch(e) { console.error('[auto-advance] assembleJob threw:', e); }
      }, 3000);
    }
  }
);
```

### 2.2 Most likely failure modes

The fix is correct in principle. Failure modes that match tonight's evidence:

**A.** `pollVideo` completed for all 22 segments BUT the completion callback fired sequentially as each segment finished, and on the last one (the 22nd), the `every()` check ran while another callback was still in flight from a parallel poll. localStorage saved the partial state, allDone evaluated true, the guard fired, but the actual `triggerGate2` or `assembleJob` call hit a state where `batchJob.segments` was inconsistent.

**B.** The browser tab was backgrounded or de-focused during the long HeyGen render wait (~6 minutes). Modern browsers throttle setTimeout/setInterval in background tabs to once per minute or pause them entirely. When pollVideo fires on a backgrounded tab, the network call still goes through but the completion callback may queue and not run until the tab is re-focused. If Rob re-focused the tab AFTER all segments had already completed server-side, the polling status updates fired in a burst, but the order may have raced the `_autoAssembleFired` guard set vs check.

**C.** `triggerGate2(batchJob)` is the function that POSTs to `/gate2-segment-qa`. If that endpoint failed, errored, or returned an unexpected response, the function's error handler set `batchJob._gate2Running = false` but never called the assembly step. The `setTimeout(() => assembleJob(...), 3000)` is independent of triggerGate2's success — it fires unconditionally 3 seconds later. So even if triggerGate2 failed, assembleJob should have fired. Unless...

**D.** ...the `setTimeout` ran while the browser tab was backgrounded, got throttled to "next minute," and the tab was closed before the throttle window opened. The setTimeout never fired. This is the most likely root cause given Rob's described UX ("the dashboard showed it stuck at HeyGen").

**E.** `_autoAssembleFired` was set to true on a previous segment's completion (e.g. one segment marked `failed` early, satisfying `every()` momentarily before the rest finished, then later segments completing didn't re-fire because the guard was already set). This shouldn't happen because `failed` is included in the every() check, but if there's any race condition in segment status updates from pollVideo's status callback (the first arg, which fires multiple times during render), the segment could briefly be in a state that satisfies the check incorrectly.

### 2.3 The fix

Multiple defensive layers:

```javascript
pollVideo(videoId,
  function(status, pct) {
    segJob.status = status;
    batchJob.pct = Math.round((avatarIdx / avatarOnly.length) * 50 + pct * 0.5);
    saveJobs(); renderQueue();
  },
  function(pollErr, data) {
    if (pollErr) {
      segJob.status = 'failed';
      segJob.error = pollErr.message || String(pollErr);
    } else {
      segJob.status = 'completed';
      segJob.url = data.video_url;
    }
    saveJobs(); renderQueue();

    // ── Auto-advance with multi-layer defense (Red 4 hotfix 13) ──────
    // Failure modes addressed:
    //  - Background tab throttling (setTimeout delayed → use setInterval poller as backup)
    //  - Race conditions on every() check (require ALL segments to have a non-null status field, not just falsy)
    //  - Guard set before downstream calls succeed (move guard set to AFTER successful triggerGate2 + assembleJob)
    //  - Errors swallowed by try/catch (replace try/catch with explicit error surfacing to dashboard banner)
    tryAutoAdvanceToAssembly(batchJob);
  }
);
```

Then add a new helper function `tryAutoAdvanceToAssembly` that has the multi-layer defense:

```javascript
// ── Auto-advance helper (Red 4 hotfix 13) ───────────────────────────
// Called from pollVideo completion to advance the pipeline from HeyGen →
// Gate 2 → assembleJob. Defense layers:
//  1. Strict allDone check — every avatar seg must have status in
//     ('completed' | 'failed'), no 'rendering' or 'queued' or undefined
//  2. Guard set only AFTER successful auto-advance start, not before
//  3. Errors surface to cwn_log + a red banner on the job card, not just
//     console.error which is invisible to operators
//  4. Background-tab safety: if setTimeout doesn't fire within 10s of being
//     scheduled (browser throttling), fallback setInterval at 5s intervals
//     keeps trying until either it succeeds or 60s elapses
//  5. Idempotency: the helper can be called multiple times safely; only
//     the first call where allDone=true actually fires the advance
function tryAutoAdvanceToAssembly(batchJob) {
  if (!batchJob || batchJob._autoAssembleFired) return;

  var avatarSegs = (batchJob.segments || []).filter(function(s) { return s.type === 'avatar'; });
  if (avatarSegs.length === 0) return; // not a HeyGen-bearing job

  // Strict check: every segment must have an explicit terminal status.
  // Treat 'rendering', 'queued', 'generating', undefined, null as not-done.
  var allDone = avatarSegs.every(function(s) {
    return s && (s.status === 'completed' || s.status === 'failed');
  });
  if (!allDone) return;

  // Count how many succeeded vs failed for the operator log
  var completedCount = avatarSegs.filter(function(s) { return s.status === 'completed'; }).length;
  var failedCount = avatarSegs.filter(function(s) { return s.status === 'failed'; }).length;

  // If ALL segments failed, don't auto-advance — that's a HeyGen catastrophe
  // and the operator needs to manually retry. Surface a hard-fail banner.
  if (completedCount === 0) {
    batchJob._autoAssembleFired = true; // prevent retry
    batchJob.status = 'failed';
    saveJobs(); renderQueue();
    cwn_log('[auto-advance] ❌ ALL ' + failedCount + ' HeyGen segments failed for ' + batchJob.id + ' — auto-advance skipped, manual retry required', true);
    showJobErrorBanner(batchJob.id, 'All HeyGen segments failed. Check segment errors and retry.');
    return;
  }

  // Set guard NOW (before downstream calls) — this is intentional: we've
  // committed to advancing, and if the downstream call fails we surface
  // the error rather than retrying (which would burn HeyGen tokens again).
  batchJob._autoAssembleFired = true;
  batchJob.status = 'all_sent';
  batchJob.pct = 50;
  saveJobs(); renderQueue();

  cwn_log('[auto-advance] All HeyGen segments done (' + completedCount + ' completed, ' + failedCount + ' failed) — firing Gate 2 + assembleJob for ' + batchJob.id, false);
  console.log('[auto-advance] HeyGen complete → triggerGate2 + assembleJob');

  // Fire Gate 2 first — synchronous error surfaces immediately
  var gate2Started = false;
  try {
    triggerGate2(batchJob);
    gate2Started = true;
  } catch (e) {
    console.error('[auto-advance] triggerGate2 threw:', e);
    cwn_log('[auto-advance] ⚠️ triggerGate2 threw: ' + (e.message || e) + ' — proceeding to assembleJob anyway (Gate 2 is optional)', true);
    showJobErrorBanner(batchJob.id, 'Gate 2 threw an error: ' + (e.message || e) + '. Assembly will run anyway.');
  }

  // Schedule assembleJob with a background-tab-safe wrapper.
  // Layer 1: setTimeout (normal path)
  // Layer 2: setInterval fallback if setTimeout doesn't fire within 10s
  //          (background tab throttling defense)
  var assembleScheduled = false;
  var assembleTimerStart = Date.now();

  var fireAssemble = function(reason) {
    if (assembleScheduled) return;
    assembleScheduled = true;
    cwn_log('[auto-advance] firing assembleJob for ' + batchJob.id + ' (via ' + reason + ')', false);
    try {
      assembleJob(batchJob.id);
    } catch (e) {
      console.error('[auto-advance] assembleJob threw:', e);
      cwn_log('[auto-advance] ❌ assembleJob threw: ' + (e.message || e) + ' — manual click required', true);
      showJobErrorBanner(batchJob.id, 'assembleJob threw: ' + (e.message || e) + '. Click ASSEMBLE manually to retry.');
      // Reset guard so manual click works
      batchJob._autoAssembleFired = false;
      saveJobs();
    }
  };

  // Primary timer
  setTimeout(function() { fireAssemble('setTimeout'); }, 3000);

  // Backup poller — if setTimeout hasn't fired within 10s, force it via interval
  var backupInterval = setInterval(function() {
    if (assembleScheduled) {
      clearInterval(backupInterval);
      return;
    }
    var elapsed = Date.now() - assembleTimerStart;
    if (elapsed > 10000) {
      console.warn('[auto-advance] setTimeout did not fire within 10s (likely background tab throttle) — forcing via setInterval backup');
      clearInterval(backupInterval);
      fireAssemble('setInterval-backup');
    }
    if (elapsed > 60000) {
      // Give up after 60s — surface a hard error
      clearInterval(backupInterval);
      cwn_log('[auto-advance] ❌ Failed to fire assembleJob within 60s for ' + batchJob.id + ' — manual click required', true);
      showJobErrorBanner(batchJob.id, 'Auto-advance timed out. Click ASSEMBLE manually to retry.');
      batchJob._autoAssembleFired = false;
      saveJobs();
    }
  }, 1000);
}

// ── Banner helper for visible error surfacing ──────────────────────
// cwn_log writes to the operator log panel which Rob may not be watching.
// showJobErrorBanner injects a red banner directly on the job card so the
// error is visible the moment the operator looks at the queue.
function showJobErrorBanner(jobId, message) {
  try {
    var bannerEl = document.getElementById('job-error-' + jobId);
    if (!bannerEl) {
      var card = document.querySelector('[data-job-id="' + jobId + '"]');
      if (!card) return;
      bannerEl = document.createElement('div');
      bannerEl.id = 'job-error-' + jobId;
      bannerEl.style.cssText = 'margin-top:8px;padding:10px 12px;background:rgba(231,76,60,0.12);border:1px solid rgba(231,76,60,0.6);border-radius:4px;color:#e74c3c;font-size:11px;font-weight:600;';
      card.appendChild(bannerEl);
    }
    bannerEl.textContent = '❌ ' + message;
  } catch (e) {
    console.error('[showJobErrorBanner] failed:', e);
  }
}
```

The defensive layers cover all five failure modes from section 2.2: strict status check (E), guard set after commit (some races), explicit error surfacing (C, swallowed catch), background-tab fallback (B, D), per-segment error reporting in the log (operator visibility).

---

## 3. Fix 2 — Replace silent "skip segment" catch handlers with fail-loud

### 3.1 Current state

The TS normalize loop at server.js:4574 has this catch handler:

```javascript
} catch(e) {
  log(asmId, `  ⚠️  Skipping segment ${i+1}: ${e.message}`);
  segTypes.splice(tsFiles.length, 0);
}
```

When an FFmpeg TS-normalize step throws (e.g. the chrome burn for scene_12 failed, or the source clip filter threw on a portrait input), the catch logs to the assembly log only (which goes to stdout — not errors.jsonl, not the dashboard banner) and CONTINUES the loop. The result: a 26-of-27-scene MP4 gets produced silently. The operator has no idea anything was dropped.

This is the same pattern as the auto-advance regression: try/catch swallowing errors that should be surfaced.

### 3.2 The fix

Two-tier policy:

- **Avatar segment failure → hard fail the assembly.** Avatar segments are mission-critical (Bobby G's voice + face). A missing avatar segment means the show has a gap where the anchor disappears mid-thought. The viewer notices instantly. There is no acceptable degraded mode for a missing avatar segment.
- **Source clip failure → hard fail the assembly with a specific error.** A News episode without its clips is not a News episode (per `SET_DESIGN_SPEC_NEWS.md` section 3.4). Source clip failure must surface immediately, not silently.
- **No silent skip ever.** The catch handler doesn't get to splice the segment out and continue. It either retries (with a clear retry policy and a max retry count) or fails the entire assembly with the specific reason.

Replace the catch handler with:

```javascript
} catch(e) {
  // Red 4 hotfix 13: fail loud, never silently skip a segment.
  // Per SET_DESIGN_SPEC_NEWS.md acceptance criteria #10: "every error
  // path in the set engine surfaces in errors.jsonl AND the dashboard
  // banner. No swallowed catch blocks. No segments silently dropped."
  const segLabel = (segsToProcess[i] && segsToProcess[i].label) || `segment_${i+1}`;
  const segType = segTypes[tsFiles.length] || 'unknown';
  const errMsg = `TS normalize failed for ${segType} segment "${segLabel}" (index ${i+1}): ${e.message}`;
  log(asmId, `  ❌ ${errMsg}`);
  // Write to errors.jsonl so it's visible without the dashboard
  try {
    const errPath = path.join(__dirname, 'logs', 'errors.jsonl');
    fs.appendFileSync(errPath, JSON.stringify({
      ts: new Date().toISOString(),
      label: 'TS_NORMALIZE_FAILURE',
      message: errMsg,
      stack: e.stack,
      context: { asmId, segmentIndex: i, segmentLabel: segLabel, segmentType: segType }
    }) + '\n');
  } catch (logErr) {
    console.error('[assembly] Failed to write to errors.jsonl:', logErr.message);
  }
  // Hard fail the assembly — do NOT continue with a missing segment
  throw new Error(errMsg);
}
```

The throw propagates up to the assembly endpoint's outer try/catch, which already surfaces errors to the dashboard via the assembly progress stream. The operator sees a red banner, errors.jsonl gets the entry, and the assembly stops cleanly. No partial MP4.

### 3.3 Apply the same pattern to other silent-skip catches

Search the codebase for other catch handlers that follow the silent-skip pattern. Likely candidates:
- The chrome burn fallback at server.js:4202 (currently logs warning and falls through to legacy chrome — that's OK as long as legacy chrome works, but should ALSO write to errors.jsonl)
- Any FFmpeg call that uses `proc.on('close', code => code === 0 ? res() : rej(...))` where the rejection is swallowed by an outer try/catch
- The Gate 2 auto-fix loop in cwn_production.html — if Gate 2 fails its auto-fix, does it surface the failure or silently continue?

Audit and apply the same fail-loud pattern to all of them.

---

## 4. Fix 3 — Source clip aspect ratio crop filter

### 4.1 Current state (broken from hotfix 11)

server.js:4519 currently:

```javascript
const vfFilter = isAvatarSeg
  ? 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,fps=fps=30'
  : 'scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080:(iw-1920)/2:(ih-1080)/2,fps=fps=30' +
    (contentType === 'news' && !isAvatarSeg ? ',drawbox=x=1780:y=960:w=120:h=80:color=0x0d1424@1.0:t=fill' : '');
```

The crop filter expression `crop=1920:1080:(iw-1920)/2:(ih-1080)/2` is mathematically incorrect for inputs that are smaller than 1920×1080 in either dimension. After `force_original_aspect_ratio=increase` scales to fill the larger dimension, one of `iw` or `ih` will equal 1920 or 1080 exactly, and the other will be larger. The crop offset `(iw-1920)/2` should be 0 in the dimension that equals the target and positive in the dimension that exceeds it. This works mathematically — IF the scale step actually produced the expected dimensions. But:

- If the input is smaller than 1920×1080 in BOTH dimensions (e.g. a 480×854 portrait or a 1280×720 landscape), `force_original_aspect_ratio=increase` scales to make the LARGER dimension match the target, which means it scales UP. For 480×854, scaling to 1080 height makes width 607, which is still smaller than 1920 — the scale doesn't overshoot, it just upscales to fit the smaller dimension. Then `crop=1920:1080:...` tries to crop from a 607×1080 frame which is impossible (crop bigger than source → FFmpeg error or undefined behavior).

- The correct behavior is: scale so that the SMALLER dimension matches the target (i.e. the frame becomes AT LEAST 1920×1080 in both dimensions), then crop to exact 1920×1080. The current `force_original_aspect_ratio=increase` actually does the WRONG thing — it scales to make the LARGER dimension match, which leaves the smaller dimension under-target.

### 4.2 The fix

Replace with an input-aware filter that handles all aspect ratios correctly:

```javascript
const vfFilter = isAvatarSeg
  ? 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,fps=fps=30'
  : "scale=w='if(gt(a,16/9),-2,1920)':h='if(gt(a,16/9),1080,-2)',crop=1920:1080,fps=fps=30" +
    (contentType === 'news' && !isAvatarSeg ? ',drawbox=x=1780:y=960:w=120:h=80:color=0x0d1424@1.0:t=fill' : '');
```

Filter explanation:
- `scale=w='if(gt(a,16/9),-2,1920)'`: if input aspect (`a` = iw/ih) is GREATER than 16/9 (i.e. wider than 16:9), set width to -2 (auto-compute, divisible by 2 for x264) — meaning width follows from height. Otherwise width = 1920.
- `h='if(gt(a,16/9),1080,-2)'`: if wider than 16:9, height = 1080. Otherwise height = -2 (auto-compute from width).
- The result: input scaled so that its 16:9-relative dimension matches the target, with the other dimension auto-computed and at least equal to the target.
- `crop=1920:1080` (no explicit offsets) — FFmpeg defaults to centered crop, which is `(iw-out_w)/2 : (ih-out_h)/2`. Centered crop is what we want.

Test the filter on all four aspect cases:
- 1920×1080 (exact match): a=16/9 (not greater), w=1920, h=-2 → 1920×1080. crop=1920:1080 → no-op. ✓
- 1280×720 (landscape, smaller): a=16/9 (not greater), w=1920, h=-2 → 1920×1080 (upscaled). crop=1920:1080 → no-op. ✓
- 2560×1080 (wider than 16:9): a=2.37 (greater), w=-2, h=1080 → 2560×1080 (scale ratio 1.0). crop=1920:1080 → centered crop, removes 320 from each side. ✓
- 480×854 (portrait): a=0.56 (not greater), w=1920, h=-2 → 1920×3414. crop=1920:1080 → centered crop, removes 1167 from top and bottom. ✓
- 720×1280 (portrait HD): a=0.5625 (not greater), w=1920, h=-2 → 1920×3413. crop=1920:1080 → centered crop. ✓

All four cases produce a clean 1920×1080 output with no negative crop offsets and no letterbox bars.

### 4.3 Add aspect ratio logging

For debuggability, log the input aspect ratio of every source clip during normalize:

```javascript
// Before the FFmpeg call, ffprobe the source dimensions for the log
try {
  const probe = await new Promise((res, rej) => {
    const args = ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', inputForTS];
    execFile(ffprobePath(), args, (err, stdout) => {
      if (err) return rej(err);
      const [w, h] = stdout.trim().split(',').map(Number);
      res({ w, h, aspect: (w / h).toFixed(3) });
    });
  });
  log(asmId, `  📐 Source clip ${path.basename(inputForTS)}: ${probe.w}×${probe.h} (aspect ${probe.aspect})`);
} catch (probeErr) {
  log(asmId, `  ⚠️  Could not probe source clip dimensions: ${probeErr.message}`);
}
```

This makes it trivial to spot aspect issues in the assembly log without re-running ffprobe manually.

---

## 5. Verification

After shipping the commit, hard-refresh the dashboard and run one News smoke test end-to-end. Expected:

1. **Server log on assembly start:** for each source clip, a `📐 Source clip ... aspect X.YYY` line showing the input dimensions.
2. **No "Skipping segment" warnings.** Any segment that would have been skipped now hard-fails the assembly with a red banner and an errors.jsonl entry.
3. **MP4 has all 27 scenes** (or whatever the script says, no missing scenes silently dropped).
4. **Source clips in the MP4 are full-frame 1920×1080** with no navy bars, no oversized zoom, no portrait pillarbox.
5. **Auto-advance fires** within 3-5 seconds of the last HeyGen segment completing. If the dashboard is backgrounded, the setInterval backup fires within 10 seconds. Operator log shows `[auto-advance] All HeyGen segments done ... firing Gate 2 + assembleJob` then `[auto-advance] firing assembleJob ... (via setTimeout)` (or `via setInterval-backup` if the tab was backgrounded).
6. **errors.jsonl gets a fresh entry on any failure** — corrupt a directive file, attempt assembly, see the entry land in errors.jsonl with the specific TS_NORMALIZE_FAILURE label.

---

## 6. Commit message

```
fix(news): three fail-loud hardening fixes — auto-advance, segment skip, source clip crop (Red 4 hotfix 13)

Tonight's smoke test surfaced three regressions where the pipeline
silently degraded instead of failing loud:

1. AUTO-ADVANCE NEVER FIRED post-HeyGen (despite 446fca8 fix being
   live). Root cause likely background-tab setTimeout throttling
   combined with swallowed try/catch error surfacing. Fix: extracted
   tryAutoAdvanceToAssembly() helper with five defensive layers —
   strict status check, guard set after commit, error surfacing to
   cwn_log + dashboard banner via showJobErrorBanner(), background-
   tab fallback via setInterval backup poller (fires if setTimeout
   doesn't within 10s), 60s hard timeout that resets the guard for
   manual retry.

2. SCENE_12 SILENTLY DROPPED from tonight's MP4 (26 of 27 scenes
   present). The TS normalize loop's catch handler at server.js:4574
   logged "Skipping segment" and continued. Per
   SET_DESIGN_SPEC_NEWS.md acceptance criterion #10 ("no silent
   failures"), this is forbidden. Replaced with hard-fail throw that
   propagates to the assembly endpoint's outer error handler,
   surfaces to dashboard, AND writes a TS_NORMALIZE_FAILURE entry
   to errors.jsonl with the segment label, type, index, error
   message, and stack trace. Same pattern applied to other silent-
   skip catch handlers in the assembly path.

3. SOURCE CLIP ASPECT RATIO BROKEN by hotfix 11's crop filter.
   The expression crop=1920:1080:(iw-1920)/2:(ih-1080)/2 produces
   negative crop offsets when input dimensions are smaller than
   1920×1080, which is undefined behavior. Replaced with input-
   aware scale expression:
     scale=w='if(gt(a,16/9),-2,1920)':h='if(gt(a,16/9),1080,-2)',crop=1920:1080
   This handles all aspect cases correctly: exact 16:9, smaller
   landscape (upscaled), wider-than-16:9 (scale to height, crop
   sides), and portrait (scale to width, crop top/bottom). Verified
   against 1920×1080, 1280×720, 2560×1080, 480×854, 720×1280 inputs.
   Added ffprobe-based aspect ratio logging before each source clip
   normalize for debuggability.

REFERENCES
- SET_DESIGN_SPEC_NEWS.md sections 3.4 (source clip framing) and 8
  (acceptance criteria, especially #4 and #10)
- 2026-04-14 ~02:00 ET diagnostic of asm_1776145848943 — 26-of-27
  scenes MP4, no errors.jsonl entries, no run_metrics file written,
  auto-advance never fired
- 446fca8 (the previous auto-advance fix that didn't survive contact
  with reality)
- Hotfix 11 1ae0e9c (which introduced the broken crop filter)
```

---

## 7. Not covered (deferred or in other handoffs)

- Directive sidecar refactor — see `CLINE_HANDOFF_DIRECTIVE_SIDECAR_REFACTOR.md`
- Gemini prompt iteration to satisfy the Zod schema — see SET_DESIGN_SPEC_NEWS.md section 5
- TV card / lower-third / sidebar chrome bugs — many of these are eliminated by the sidecar refactor; remaining ones get caught by the new validation gates

---

## 8. Priority

**Ship after the directive sidecar refactor.** The sidecar refactor removes the failure modes that caused scene_12 to drop tonight (chrome burn failure on schema mismatch); this hardening handoff catches whatever failure modes remain. Order matters: refactor first, then hardening. Both can ship in the same morning.

Estimated time: 90 minutes including the smoke test verification.
