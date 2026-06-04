'use strict';
/**
 * lib/services/pipeline_assembly.js — CPD-485
 *
 * Shared post-portal hooks that must fire identically on every dispatch path:
 *   - dashboard (jobs_c1 inline setImmediate)
 *   - BullMQ worker (queue/worker.js)
 *   - v1 API (developer_api.js)
 *
 * Exports:
 *   hasSourceClips(spec)                    — true when clips exist
 *   isPortal1Active(spec)                   — false when script stage is off
 *   runAssemblyAndPostProcess(spec, jobId)  — after portal0/portal1 pass
 *   runTtsMixAndChrome(spec, jobId, audio)  — after tts_ext pass
 *   ensureChromeApplied(spec, jobId)        — portal3a safety net
 *   runJobComplete(spec, jobId, opts)       — onJobComplete: grade + persist + notify
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
 * Returns true when portal1 (script QA) is active for this job.
 * Clip-only wizard jobs disable script stage via stageMap or portals map.
 */
function isPortal1Active(spec) {
  if (spec.stageMap?.script?.active === false) return false;
  if (spec.portals?.portal1 === false) return false;
  return true;
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
    // CPD-487: assembleForJob returned without setting assembledPath — this is a hard failure,
    // not a soft warning. Portal3a requires assembledPath; without it every downstream portal
    // will fail with a misleading error. Throw immediately so the failure is attributed to
    // assembly (not portal3a) and triggers a Sentry ASSEMBLY_NO_PATH alert.
    const noPathErr = new Error(
      `[CPD126_ASSEMBLY_NO_PATH] assembleForJob completed but assembledPath is not set. ` +
      `Job ${jobId} cannot proceed to portal3a without a video file. ` +
      `Check assembly_service logs for the root cause.`
    );
    logError('CPD126_ASSEMBLY_NO_PATH', noPathErr, {
      jobId,
      contentType: spec.contentType,
      templateId:  spec.templateId,
      sourceType:  spec.sourceType,
    });
    try {
      const Sentry = require('@sentry/node');
      Sentry.captureException(noPathErr, {
        level: 'fatal',
        tags: { portal: 'assembly', jobId, templateId: spec.templateId },
        extra: { contentType: spec.contentType, sourceType: spec.sourceType, customerId: spec.customerId },
      });
    } catch (_se) { /* Sentry not loaded */ }
    spec.status = 'failed';
    spec.assemblyFailReason = 'assembleForJob returned without setting assembledPath';
    await _persist({
      status: 'failed',
      failedPortal: 'assembly',
      assemblyFailReason: spec.assemblyFailReason,
      updatedAt: new Date().toISOString(),
    }).catch(() => {});
    throw noPathErr;
  }

  // CPD-487: log successful assembly as a structured Sentry breadcrumb so future regressions
  // show up as missing ASSEMBLY_COMPLETE events before they surface as portal3a failures.
  try {
    const Sentry = require('@sentry/node');
    Sentry.addBreadcrumb({
      category: 'assembly',
      message:  `ASSEMBLY_COMPLETE job=${jobId} path=${spec.assembledPath}`,
      level:    'info',
      data:     { jobId, assembledPath: spec.assembledPath, contentType: spec.contentType },
    });
  } catch (_se) { /* Sentry not loaded */ }

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

      // CPD-509: resolve customer brand logo — download from R2 if brand.image_url is set
      let _brandLogoPath = null;
      if (spec.brandId && spec.customerId) {
        try {
          const { getBrand } = require('../db/postgres');
          const _brand = await getBrand(spec.brandId, spec.customerId);
          if (_brand?.image_url) {
            const _tmpLogo = require('path').join(require('os').tmpdir(), `brand_logo_${spec.brandId}_${Date.now()}.png`);
            const _axios = require('axios');
            const _logoResp = await _axios.get(_brand.image_url, { responseType: 'arraybuffer', timeout: 15000 });
            require('fs').writeFileSync(_tmpLogo, _logoResp.data);
            _brandLogoPath = _tmpLogo;
            _log('brand logo downloaded for chrome overlay (CPD-509)');
          }
        } catch (_logoErr) {
          _warn(`brand logo download failed (using default) — ${_logoErr.message}`);
        }
      }

      await applyChrome(spec.assembledPath, chromedPath, {
        showName,
        isVertical:            isVert,
        streamerName,
        needsPortraitReframe:  isVert && !portraitDone,
        durationSecs,
        brandLogoPath:         _brandLogoPath || undefined,
      });

      // Clean up temp brand logo file
      if (_brandLogoPath) try { require('fs').unlinkSync(_brandLogoPath); } catch (_) {}

      require('fs').renameSync(chromedPath, spec.assembledPath);
      if (!spec.state) spec.state = {};
      spec.state.chromeApplied = true;
      if (isVert && !portraitDone) {
        if (!spec.state.savedOutputs) spec.state.savedOutputs = {};
        spec.state.savedOutputs.layoutPortraitApplied = true;
      }

      // Record branding as applied in the processingManifest now that chrome succeeded.
      try {
        const { initManifest, recordTransformation } = require('./processing_manifest');
        if (spec.addOns?.branding?.active) {
          recordTransformation(spec, { type: 'branding', params: { showName, streamerName }, outputTimestamp: 'full_video' });
        }
      } catch (_mErr) { /* never let manifest writes break delivery */ }

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

  // ── Brand intro/outro cards (CPD-508) ────────────────────────────────────────
  // After chrome, splice brand intro/outro cards if configured in brand settings.
  if (spec.assembledPath && spec.brandId && spec.customerId) {
    try {
      const { getBrand } = require('../db/postgres');
      const _brand = await getBrand(spec.brandId, spec.customerId);
      if (_brand?.intro_card_url || _brand?.outro_card_url) {
        const _fs    = require('fs');
        const _path  = require('path');
        const _os    = require('os');
        const _axios = require('axios');
        const { execFile: _execFile } = require('child_process');
        const { ffmpegPath: _ffmpegPath } = require('../ffmpeg_utils');
        const { uploadToR2: _uploadToR2 } = require('../storage');

        // Download intro/outro to temp files
        const _downloadCard = async (url, suffix) => {
          const _tmp = _path.join(_os.tmpdir(), `brand_card_${suffix}_${Date.now()}.mp4`);
          const _resp = await _axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
          _fs.writeFileSync(_tmp, _resp.data);
          return _tmp;
        };

        const _clips = [];
        let _introPath = null;
        let _outroPath = null;

        if (_brand.intro_card_url) {
          _introPath = await _downloadCard(_brand.intro_card_url, 'intro');
          _clips.push(_introPath);
        }
        _clips.push(spec.assembledPath);
        if (_brand.outro_card_url) {
          _outroPath = await _downloadCard(_brand.outro_card_url, 'outro');
          _clips.push(_outroPath);
        }

        if (_clips.length > 1) {
          const _splicedPath = spec.assembledPath.replace('.mp4', '_spliced.mp4');
          const _inputs = _clips.flatMap((p) => ['-i', p]);
          const _n = _clips.length;
          // Normalize each card to same resolution + audio layout then concat
          const _vFilters = _clips.map((_, i) =>
            `[${i}:v]fps=30,setpts=PTS-STARTPTS,scale=1280:720:force_original_aspect_ratio=decrease,` +
            `pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[sv${i}]`
          );
          const _aFilters = _clips.map((_, i) =>
            `[${i}:a?]aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[sa${i}]`
          );
          const _concatRefs = _clips.map((_, i) => `[sv${i}][sa${i}]`).join('');
          const _fc = [..._vFilters, ..._aFilters, `${_concatRefs}concat=n=${_n}:v=1:a=1[vout][aout]`].join(';');

          await new Promise((res, rej) => _execFile(
            _ffmpegPath(),
            [..._inputs, '-filter_complex', _fc, '-map', '[vout]', '-map', '[aout]',
              '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p',
              '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '128k',
              '-movflags', '+faststart', '-y', _splicedPath],
            { timeout: 600000 },
            (err) => err ? rej(err) : res()
          ));

          _fs.renameSync(_splicedPath, spec.assembledPath);

          // Re-upload to R2
          const _splicedUrl = await _uploadToR2(
            spec.assembledPath,
            `${Date.now()}_assembled_${jobId}_branded.mp4`,
            { folder: `outputs/${jobId}` }
          );
          if (!spec.state) spec.state = {};
          if (!spec.state.savedOutputs) spec.state.savedOutputs = {};
          spec.state.savedOutputs.r2VideoUrl = _splicedUrl;
          spec.assembledVideoUrl = _splicedUrl;

          try {
            const { initManifest, recordTransformation } = require('./processing_manifest');
            recordTransformation(spec, { type: 'branding.intro_outro', params: {
              hasIntro: !!_brand.intro_card_url, hasOutro: !!_brand.outro_card_url,
            }, outputTimestamp: 'full_video' });
          } catch (_) {}

          _log(`brand intro/outro spliced (CPD-508) — ${_clips.length} segment(s)`);
        }

        // Clean up temp card files
        if (_introPath) try { _fs.unlinkSync(_introPath); } catch (_) {}
        if (_outroPath) try { _fs.unlinkSync(_outroPath); } catch (_) {}
      }
    } catch (_cardErr) {
      _warn(`brand intro/outro splice failed (non-fatal) — ${_cardErr.message}`);
    }
  }

  await db.updateJobSpec(jobId, spec).catch(() => {});
  _log(`assembly complete → ${spec.assembledPath}`);
}

/**
 * Mix ElevenLabs TTS audio into the assembled video, then apply chrome overlay.
 * Called from onPortalPass('tts_ext') on all dispatch paths.
 *
 * @param {object} spec            — jobSpec (mutated in-place)
 * @param {string} jobId
 * @param {string} ttsAudioPath    — local path to TTS audio file
 * @param {object} opts
 * @param {Function} [opts.persist]
 * @param {string}  [opts.logPrefix]
 */
async function runTtsMixAndChrome(spec, jobId, ttsAudioPath, opts = {}) {
  const { persist, logPrefix = '[assembly]' } = opts;
  const db = require('../db');
  const _log  = (msg) => console.log(`${logPrefix} ${jobId}: ${msg}`);
  const _warn = (msg) => console.warn(`${logPrefix} ${jobId}: ${msg}`);
  const _persist = persist || (async () => {});

  if (!ttsAudioPath || !spec.assembledPath) return;

  const { mixTtsIntoVideo, mixAlignedMultiClipTts } = require('../assembly_service');

  let mixed = null;
  // CPD-270: per-section alignment for multi-clip COMPACT jobs
  if (spec.clipDurations?.length > 1 && spec.filledScript) {
    try {
      mixed = await mixAlignedMultiClipTts(spec.assembledPath, ttsAudioPath, spec.filledScript, spec.clipDurations, jobId);
      if (mixed) _log(`per-section aligned TTS mixed (${spec.clipDurations.length} clips)`);
    } catch (alignErr) {
      _warn(`aligned TTS mix failed (${alignErr.message}) — using single-track fallback`);
    }
  }
  if (!mixed) {
    try {
      mixed = await mixTtsIntoVideo(spec.assembledPath, ttsAudioPath, jobId);
    } catch (ttsErr) {
      _warn(`TTS mix failed (non-fatal) — ${ttsErr.message}`);
    }
  }

  if (!mixed) return;

  spec.assembledPath = mixed;
  spec.outputPath    = mixed;

  // CPD-184: Re-upload TTS-mixed video to R2
  try {
    const { uploadToR2 } = require('../storage');
    const ttsUrl = await uploadToR2(mixed, `assembled_${jobId}_tts.mp4`, { folder: `outputs/${jobId}` });
    if (!spec.state) spec.state = {};
    if (!spec.state.savedOutputs) spec.state.savedOutputs = {};
    spec.state.savedOutputs.r2VideoUrl = ttsUrl;
    spec.assembledVideoUrl = ttsUrl;
    _log('TTS video re-uploaded to R2');
    // CPD-218: interim persist — protect against crash between TTS upload and chrome
    await db.updateJobSpec(jobId, spec).catch((e) =>
      _warn(`TTS URL interim DB persist failed (non-fatal): ${e.message}`)
    );
  } catch (uploadErr) {
    _warn(`TTS R2 re-upload failed (non-fatal) — ${uploadErr.message}`);
  }

  // Chrome overlay after TTS (CPD-185)
  if (spec.addOns?.branding?.active === false) {
    if (!spec.state) spec.state = {};
    spec.state.chromeApplied = false;
    spec.state.chromeSkipped = true;
    _log('branding disabled — skipping chrome overlay (TTS path)');
    await db.updateJobSpec(jobId, spec).catch(() => {});
    return;
  }

  try {
    const { applyChrome } = require('../assembly_service');
    const chromedPath  = mixed.replace('.mp4', '_chrome.mp4');
    const showName     = spec.designSpec?.chrome?.name || spec.designSpec?.chrome?.showName || spec.order?.showName || 'AuraFlux';
    const streamerName = spec.designSpec?.chrome?.streamer || spec.order?.inputs?.streamer || spec.brandName || '';
    const isVert       = spec.productionProfile === 'vertical_reel' ||
      (spec.format === 'short' && (spec.order?.publish?.platforms || [])
        .some((p) => ['tiktok', 'instagram'].includes(String(p).toLowerCase())));
    const portraitDone = spec.state?.savedOutputs?.layoutPortraitApplied;
    const durationSecs = (spec.clipDurations || []).reduce((s, d) => s + (d || 0), 0) || (spec.durationMins || 0) * 60;

    await applyChrome(mixed, chromedPath, { showName, isVertical: isVert, streamerName, needsPortraitReframe: isVert && !portraitDone, durationSecs });
    require('fs').renameSync(chromedPath, mixed);
    if (!spec.state) spec.state = {};
    spec.state.chromeApplied = true;
    spec.assembledPath = mixed;
    spec.outputPath    = mixed;
    if (isVert && !portraitDone) {
      if (!spec.state.savedOutputs) spec.state.savedOutputs = {};
      spec.state.savedOutputs.layoutPortraitApplied = true;
    }

    // burn_images stat card overlays (CPD-208)
    if (spec.addOns?.imageBurn?.active) {
      try {
        const burnExt = require('../portals/portal_burn_image_ext');
        await burnExt.runWorker(spec, jobId);
      } catch (burnErr) {
        _warn(`burn_image overlay failed (non-fatal) — ${burnErr.message}`);
      }
    }

    const { uploadToR2 } = require('../storage');
    const chromeUrl = await uploadToR2(mixed, `assembled_${jobId}_final.mp4`, { folder: `outputs/${jobId}` });
    if (!spec.state.savedOutputs) spec.state.savedOutputs = {};
    spec.state.savedOutputs.r2VideoUrl = chromeUrl;
    spec.assembledVideoUrl = chromeUrl;
    _log('chrome overlay applied (TTS path) and re-uploaded to R2');
  } catch (chromeErr) {
    _warn(`chrome overlay (TTS path) failed (non-fatal) — ${chromeErr.message}`);
  }

  await db.updateJobSpec(jobId, spec).catch(() => {});
  _log('TTS mixed into assembled video');
}

/**
 * CPD-185/199: Apply chrome if not yet applied (safety net on portal3a pass).
 * Fires when tts_ext was not ordered or failed silently before this point.
 */
async function ensureChromeApplied(spec, jobId, opts = {}) {
  const { persist, logPrefix = '[assembly]' } = opts;
  const db = require('../db');
  const _log  = (msg) => console.log(`${logPrefix} ${jobId}: ${msg}`);
  const _warn = (msg) => console.warn(`${logPrefix} ${jobId}: ${msg}`);

  if (!spec.assembledPath) return;
  if (spec.state?.chromeApplied) return;
  if (spec.addOns?.branding?.active === false) return;

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

    await applyChrome(spec.assembledPath, chromedPath, { showName, isVertical: isVert, streamerName, needsPortraitReframe: isVert && !portraitDone, durationSecs });
    require('fs').renameSync(chromedPath, spec.assembledPath);
    if (!spec.state) spec.state = {};
    spec.state.chromeApplied = true;
    if (isVert && !portraitDone) {
      if (!spec.state.savedOutputs) spec.state.savedOutputs = {};
      spec.state.savedOutputs.layoutPortraitApplied = true;
    }

    if (spec.addOns?.imageBurn?.active) {
      try {
        const burnExt = require('../portals/portal_burn_image_ext');
        await burnExt.runWorker(spec, jobId);
      } catch (burnErr) {
        _warn(`burn_image overlay (portal3a safety net) failed (non-fatal) — ${burnErr.message}`);
      }
    }

    const { uploadToR2 } = require('../storage');
    const chromeUrl = await uploadToR2(spec.assembledPath, `assembled_${jobId}_final.mp4`, { folder: `outputs/${jobId}` });
    if (!spec.state.savedOutputs) spec.state.savedOutputs = {};
    spec.state.savedOutputs.r2VideoUrl = chromeUrl;
    spec.assembledVideoUrl = chromeUrl;
    await db.updateJobSpec(jobId, spec).catch(() => {});
    _log('chrome overlay applied (portal3a safety net) and uploaded to R2');
  } catch (chromeErr) {
    _warn(`chrome overlay (portal3a safety net) failed (non-fatal) — ${chromeErr.message}`);
  }
}

/**
 * Shared onJobComplete handler — grade, persist, notify.
 * Parity between inline jobs_c1, BullMQ worker, and v1 developer_api.
 *
 * @param {object} spec
 * @param {string} jobId
 * @param {object} opts
 * @param {number}   [opts.jobStartMs]       — Date.now() when pipeline started
 * @param {Function} [opts.logPrefix]
 * @param {Function} [opts.nrJobComplete]    — New Relic event fn
 */
async function runJobComplete(spec, jobId, opts = {}) {
  const { jobStartMs, logPrefix = '[assembly]', nrJobComplete } = opts;
  const db = require('../db');
  const _log = (msg) => console.log(`${logPrefix} ${jobId}: ${msg}`);

  if (nrJobComplete && jobStartMs) nrJobComplete(spec, Date.now() - jobStartMs);

  // Build publishCopy from topic if portals didn't produce one
  const _platforms = spec.order?.publish?.platforms || [];
  if (_platforms.length > 0 && !spec.state?.savedOutputs?.publishCopy) {
    const _topic    = spec.order?.title || spec.order?.topic || spec.topic || 'AuraFlux Video';
    const _streamer = spec.order?.inputs?.streamer || spec.brandName || '';
    const _ytTitle  = (_streamer ? `${_streamer} — ` : '') + _topic.slice(0, 90);
    const _ytDesc   = [_topic, '', _streamer ? `Watch more from ${_streamer} on AuraFlux.` : 'Created with AuraFlux.'].join('\n').slice(0, 5000);
    if (!spec.state) spec.state = {};
    if (!spec.state.savedOutputs) spec.state.savedOutputs = {};
    spec.state.savedOutputs.publishCopy = {
      youtube:   { title: _ytTitle, description: _ytDesc, tags: _streamer ? [_streamer, 'clips', 'twitch'] : ['auraflux'] },
      tiktok:    { caption: _ytTitle },
      instagram: { caption: _ytTitle },
    };
    _log('publishCopy auto-generated from topic');
  }

  Object.assign(spec, {
    status:    'complete',
    outputUrl: spec.outputUrl || spec.state?.savedOutputs?.r2VideoUrl || spec.assembledVideoUrl || null,
    updatedAt: new Date().toISOString(),
  });

  // CPD-422: grade after status='complete' so grader sees final state
  try {
    const { gradeJob } = require('../services/job_grader');
    const gr     = gradeJob(spec);
    const gradeAt = new Date().toISOString();
    Object.assign(spec, {
      grade:       gr.grade,
      gradeResult: { grade: gr.grade, passed: gr.passed, gaps: gr.gaps, warnings: gr.warnings, summary: gr.summary, gradedAt: gradeAt },
    });
    _log(`grade ${gr.grade}/100 — ${gr.passed ? 'PASSED ✅' : 'GAPS: ' + gr.gaps.map((g) => g.checkId).join(', ')}`);

    if (!gr.passed) {
      spec.status = 'operator_review';
      const gpt4oNotes = spec.state?.savedOutputs?.gpt4oQA || null;
      const autoFixable = gpt4oNotes?.fixableIssues?.filter((i) => i.autoFixable) || [];
      const manualFix   = gpt4oNotes?.fixableIssues?.filter((i) => !i.autoFixable) || [];
      if (!spec.state) spec.state = {};
      spec.state.operatorReview = {
        enteredAt:     gradeAt,
        grade:         gr.grade,
        gaps:          gr.gaps,
        warnings:      gr.warnings,
        gpt4oScore:    gpt4oNotes?.score || null,
        autoFixable,
        manualFix,
        creativeNotes: gpt4oNotes?.creativeNotes || [],
      };
      _log(`grade ${gr.grade}/100 → operator_review (${gr.gaps.length} gaps, ${autoFixable.length} auto-fixable)`);
    }
  } catch (ge) {
    console.error(`${logPrefix} ${jobId}: grader error —`, ge.message);
  }

  try {
    await db.updateJobSpec(jobId, spec);
    await db.saveJob(jobId, spec);
  } catch (e) {
    console.error(`${logPrefix} ${jobId}: onJobComplete final persist failed:`, e.message);
  }

  // Notify customer
  try {
    const { createNotification } = require('../db');
    await createNotification(spec.customerId, {
      type:      'job_ready',
      title:     'Your video is ready — review now',
      body:      spec.order?.title || null,
      actionUrl: '/dashboard/staging',
    });
  } catch (_ne) { /* non-fatal */ }
}

module.exports = {
  hasSourceClips,
  isPortal1Active,
  runAssemblyAndPostProcess,
  runTtsMixAndChrome,
  ensureChromeApplied,
  runJobComplete,
};
