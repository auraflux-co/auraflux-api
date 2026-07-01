'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Upload assembled MP4 to R2 and sync driveUrl on job card + job spec.
 * Used after credits outro (pass or Gate 3 fail) so preview === publish source.
 */

function resolveLocalPublishPath(card = {}) {
  if (card.outputPath && fs.existsSync(card.outputPath)) return card.outputPath;
  try {
    const { findJobFinalOutputPath } = require('./assembly_card_persist');
    const p = findJobFinalOutputPath(card);
    return p && fs.existsSync(p) ? p : null;
  } catch (_e) {
    return null;
  }
}

function localPublishSourceStat(card = {}) {
  const localPath = resolveLocalPublishPath(card);
  if (!localPath) return null;
  const st = fs.statSync(localPath);
  return { path: localPath, mtimeMs: st.mtimeMs, size: st.size };
}

function isLocalPublishSourceSynced(card = {}, stat = null) {
  const s = stat || localPublishSourceStat(card);
  if (!s) return true;
  const driveUrl = card.driveUrl || card.state?.savedOutputs?.driveUrl;
  if (!driveUrl || String(driveUrl).includes('localhost')) return false;
  const syncedMtime = card.driveUrlLocalMtime || 0;
  const syncedSize = card.driveUrlLocalSize || 0;
  return syncedMtime >= s.mtimeMs && syncedSize === s.size;
}

/**
 * Gate 5 must publish the same bytes as localhost /download preview.
 * Re-upload when local output is newer or never synced to R2.
 */
async function ensurePublishDriveUrlMatchesLocal(opts = {}) {
  const { cardId, card, saveJobCard, logFn } = opts;
  if (!cardId || !card) return null;

  const stat = localPublishSourceStat(card);
  if (!stat) {
    return card.driveUrl || card.state?.savedOutputs?.driveUrl || null;
  }

  if (isLocalPublishSourceSynced(card, stat)) {
    return card.driveUrl || card.state?.savedOutputs?.driveUrl || null;
  }

  logFn?.('Local preview file differs from R2 publish source — re-uploading before Gate 5');
  return uploadAssemblyMp4ToR2AndPersist({
    cardId,
    outPath: stat.path,
    outFile: path.basename(stat.path),
    saveJobCard,
    logFn,
  });
}

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
      try {
        const st = fs.statSync(outPath);
        live.driveUrlLocalMtime = st.mtimeMs;
        live.driveUrlLocalSize = st.size;
      } catch (_st) { /* non-fatal */ }
      live.state = live.state || {};
      live.state.savedOutputs = {
        ...(live.state.savedOutputs || {}),
        driveUrl,
        assembledPath: outPath,
        driveUrlLocalMtime: live.driveUrlLocalMtime,
        driveUrlLocalSize: live.driveUrlLocalSize,
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

module.exports = {
  uploadAssemblyMp4ToR2AndPersist,
  ensurePublishDriveUrlMatchesLocal,
  resolveLocalPublishPath,
  isLocalPublishSourceSynced,
};
