'use strict';

/**
 * Upload assembled MP4 to R2 and sync driveUrl on job card + job spec.
 * Used after credits outro (pass or Gate 3 fail) so preview === publish source.
 */

async function uploadAssemblyMp4ToR2AndPersist(opts = {}) {
  const {
    asmId,
    cardId,
    outPath,
    outFile,
    assemblyJobsRef,
    saveJobCard,
    creditsAppended = false,
    logFn,
  } = opts;
  if (!cardId || !outPath || !outFile) return null;

  const log = logFn || (() => {});
  const pipelineBus = require('./pipeline_events');

  try {
    const { uploadToR2 } = require('./storage');
    const driveUrl = await uploadToR2(outPath, outFile, { folder: `outputs/${cardId}` });
    if (!driveUrl) return null;

    if (assemblyJobsRef && asmId) {
      const slot = assemblyJobsRef[asmId] || {};
      slot.driveUrl = driveUrl;
      if (creditsAppended) slot.creditsOutroAppended = true;
      assemblyJobsRef[asmId] = slot;
    }

    try {
      const { saveOutput } = require('./job_spec');
      await saveOutput(cardId, 'driveUrl', driveUrl);
    } catch (_) { /* ad-hoc assemblies may lack job spec */ }

    const live = global.persistedJobsRef?.[cardId];
    if (live) {
      live.driveUrl = driveUrl;
      live.outputPath = outPath;
      if (creditsAppended) live.creditsOutroAppended = true;
      live.state = live.state || {};
      live.state.savedOutputs = {
        ...(live.state.savedOutputs || {}),
        driveUrl,
        assembledPath: outPath,
      };
      if (typeof saveJobCard === 'function') {
        try { saveJobCard(cardId, live); } catch (_) {}
      }
    }

    try {
      pipelineBus.emit('assembly:drive_url', { asmId, jobId: cardId, driveUrl });
    } catch (_) {}

    log(`  ☁️  R2 uploaded → ${driveUrl}`);
    return driveUrl;
  } catch (err) {
    log(`  ⚠️  R2 upload failed (non-fatal): ${err.message}`);
    return null;
  }
}

module.exports = { uploadAssemblyMp4ToR2AndPersist };
