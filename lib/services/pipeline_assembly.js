'use strict';
/**
 * lib/services/pipeline_assembly.js — CPD-485
 *
 * Shared assembly + post-processing + chrome logic extracted from developer_api.js
 * so that jobs_c1 (dashboard/BullMQ path) and developer_api (v1 API path) both
 * produce identical output for the same job spec.
 *
 * Called from:
 *   - lib/routes/developer_api.js   onPortalPass(portal1)
 *   - lib/routes/jobs_c1.js         onPortalPass(portal1)  ← previously missing
 *   - lib/queue/worker.js           onPortalPass(portal1)  ← previously missing
 */

const { logError } = require('../error_logger');

/**
 * Returns true when the job spec has source clips that require assembly.
 */
function hasSourceClips(spec) {
  return !!(
    (spec.sourceConfig?.urls?.length > 0) ||
    (spec.orderedClipUrls?.length > 0) ||
    (spec.order?.inputs?.url) ||
    (spec.order?.inputs?.items?.some((it) => it.url || it.videoUrl || it.clipUrl || it.localPath))
  );
}

/**
 * Run assembly → post-processing → chrome overlay for a job after portal1 passes.
 *
 * @param {object} spec      — jobSpec (mutated in-place with assembledPath, assembledVideoUrl, etc.)
 * @param {string} jobId     — for logging
 * @param {object} opts
 * @param {Function} [opts.persist]   — async fn({ status, currentPortal, updatedAt }) — persists state mid-run
 * @param {string}  [opts.logPrefix]  — e.g. '[jobs/c1]' or '[pipeline-worker]'
 */
async function runAssemblyAndPostProcess(spec, jobId, opts = {}) {
  const { persist, logPrefix = '[assembly]' } = opts;
  const db = require('../db');

  const _log    = (msg)       => console.log(`${logPrefix} ${jobId}: ${msg}`);
  const _warn   = (msg)       => console.warn(`${logPrefix} ${jobId}: ${msg}`);
  const _persist = persist || (async () => {});

  if (!hasSourceClips(spec)) {
    _log('no source clips — skipping assembly');
    return;
  }
  if (spec.assembledPath) {
    _log('assembledPath already set — skipping assembly');
    return;
  }

  // ── Assembly ────────────────────────────────────────────────────────────────
  await _persist({ status: 'running', currentPortal: 'assembly', updatedAt: new Date().toISOString() });

  // CPD-195: heartbeat every 30s so rescueInterruptedJobs (STALE_SECS=600) doesn't flag as abandoned.
  const _heartbeat = setInterval(async () => {
    try {
      Object.assign(spec, { updatedAt: new Date().toISOString() });
      await db.updateJobSpec(jobId, spec);
    } catch (_e) { /* non-fatal */ }
  }, 30_000);

  try {
    const { assembleForJob } = require('../assembly_service');
    try {
      await assembleForJob(spec);
    } finally {
      clearInterval(_heartbeat);
    }
  } catch (asmErr) {
    clearInterval(_heartbeat);
    logError('CPD126_ASSEMBLY_FAILED', asmErr, { jobId });
    spec.assemblyFailReason = asmErr.message.slice(0, 300);
    spec.status = 'failed';
    await _persist({
      status: 'failed',
      failedPortal: 'assembly',
      assemblyFailReason: asmErr.message.slice(0, 300),
      updatedAt: new Date().toISOString(),
    }).catch(() => {});
    throw asmErr;
  }

  if (!spec.assembledPath) {
    _log('assembleForJob completed but assembledPath is not set — skipping post-processing');
    return;
  }

  // ── Post-processing effects ─────────────────────────────────────────────────
  // CPD-431: loudnorm, LUT, square crop, etc. — AFTER assembly, BEFORE chrome.
  try {
    const { applyPostProcessingEffects } = require('../assembly_postprocess');
    await applyPostProcessingEffects(spec, spec.assembledPath, (msg) => _log(msg));

    const _ppModified = spec.state?.savedOutputs?.loudnormApplied ||
      spec.state?.savedOutputs?.layoutSquareApplied ||
      (spec.state?.savedOutputs?.postProcessEffects?.length > 0);

    if (_ppModified) {
      try {
        const { uploadToR2 } = require('../storage');
        const ppFileName = `${Date.now()}_assembled_${jobId}_fx.mp4`;
        const ppUrl = await uploadToR2(spec.assembledPath, ppFileName, { folder: `outputs/${jobId}` });
        spec.assembledVideoUrl = ppUrl;
        if (!spec.state) spec.state = {};
        if (!spec.state.savedOutputs) spec.state.savedOutputs = {};
        spec.state.savedOutputs.r2VideoUrl = ppUrl;
        _log('post-processing applied and re-uploaded to R2');
      } catch (ppR2Err) {
        _warn(`postprocess R2 re-upload failed (non-fatal) — ${ppR2Err.message}`);
      }
    }
  } catch (ppErr) {
    _warn(`postprocess effects failed (non-fatal) — ${ppErr.message}`);
  }

  // ── Highlight trim (ENHANCE jobs) ───────────────────────────────────────────
  // CPD-217: trim dead time to the Gemini-identified highlight window.
  if (spec.contentFlow === 'enhance' || spec.order?.contentFlow === 'enhance') {
    try {
      const trimExt = require('../portals/portal_highlight_trim_ext');
      const trimResult = await trimExt.runWorker(spec, jobId);
      if (trimResult.outcome === 'trimmed') {
        _log(`highlight trim applied — saved ${trimResult.savedSeconds?.toFixed(1)}s`);
      }
    } catch (trimErr) {
      _warn(`highlight trim failed (non-fatal) — ${trimErr.message}`);
    }
  }

  // ── Chrome overlay (non-TTS path) ───────────────────────────────────────────
  // CPD-173: branding overlay applied here when TTS is OFF.
  // For TTS jobs, chrome is applied after TTS mixing (tts_ext pass).
  if (spec.addOns?.branding?.active === true && !spec.addOns?.tts?.active && spec.assembledPath) {
    try {
      const { applyChrome } = require('../assembly_service');
      const chromedPath  = spec.assembledPath.replace('.mp4', '_chrome.mp4');
      const showName     = spec.designSpec?.chrome?.name || spec.designSpec?.chrome?.showName || spec.order?.showName || 'AuraFlux';
      const streamerName = spec.designSpec?.chrome?.streamer || spec.order?.inputs?.streamer || spec.brandName || '';
      const isVert       = spec.productionProfile === 'vertical_reel' ||
        (spec.format === 'short' && (spec.order?.publish?.platforms || [])
          .some((p) => ['tiktok', 'instagram'].includes(String(p).toLowerCase())));
      const portraitDone = spec.state?.savedOutputs?.layoutPortraitApplied;
      const durationSecs = (spec.clipDurations || []).reduce((s, d) => s + (d || 0), 0) || (spec.durationMins || 0) * 60;

      await applyChrome(spec.assembledPath, chromedPath, {
        showName,
        isVertical:            isVert,
        streamerName,
        needsPortraitReframe:  isVert && !portraitDone,
        durationSecs,
      });
      require('fs').renameSync(chromedPath, spec.assembledPath);
      if (!spec.state) spec.state = {};
      spec.state.chromeApplied = true;
      if (isVert && !portraitDone) {
        if (!spec.state.savedOutputs) spec.state.savedOutputs = {};
        spec.state.savedOutputs.layoutPortraitApplied = true;
      }

      try {
        const { uploadToR2 } = require('../storage');
        const chromeUrl = await uploadToR2(
          spec.assembledPath,
          `${Date.now()}_assembled_${jobId}_final.mp4`,
          { folder: `outputs/${jobId}` }
        );
        if (!spec.state.savedOutputs) spec.state.savedOutputs = {};
        spec.state.savedOutputs.r2VideoUrl = chromeUrl;
        spec.assembledVideoUrl = chromeUrl;
        _log('chrome overlay applied (non-TTS path) and uploaded');
      } catch (r2Err) {
        _warn(`chrome R2 re-upload failed (non-fatal) — ${r2Err.message}`);
      }
    } catch (chrErr) {
      _warn(`chrome overlay failed (non-fatal) — ${chrErr.message}`);
    }
  }

  await db.updateJobSpec(jobId, spec).catch(() => {});
  _log(`assembly complete → ${spec.assembledPath}`);
}

module.exports = { runAssemblyAndPostProcess, hasSourceClips };
