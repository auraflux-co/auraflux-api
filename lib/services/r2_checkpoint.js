'use strict';
/**
 * lib/services/r2_checkpoint.js — CPD-1047
 * Restore assembledPath from R2 when Render ephemeral /tmp lost the local file.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const { getPresignedDownloadUrl } = require('../storage');

function _resolveCheckpointUrl(spec = {}) {
  return (
    spec.state?.savedOutputs?.r2VideoUrl ||
    spec.state?.savedOutputs?.assembledVideoUrl ||
    spec.assembledVideoUrl ||
    spec.state?.checkpoints?.assembledR2Url ||
    null
  );
}

/**
 * Download R2 checkpoint to local tmp when assembledPath is missing.
 * Mutates spec.assembledPath / outputPath on success.
 * @returns {Promise<string>} local path
 */
async function restoreAssembledPathFromCheckpoint(spec, jobId, opts = {}) {
  const log = opts.log || ((msg) => console.log(`[r2_checkpoint] ${jobId}: ${msg}`));

  if (spec?.assembledPath && fs.existsSync(spec.assembledPath)) {
    return spec.assembledPath;
  }

  const r2Url = _resolveCheckpointUrl(spec);
  if (!r2Url) {
    throw new Error('No R2 checkpoint — r2VideoUrl missing on job spec');
  }

  let fetchUrl = r2Url;
  try {
    fetchUrl = await getPresignedDownloadUrl(r2Url, 7200);
  } catch (_) {
    log('presign failed — trying raw R2 URL');
  }

  const localPath = path.join(os.tmpdir(), `reprocess_${jobId}_${Date.now()}.mp4`);
  log(`downloading checkpoint from R2 → ${path.basename(localPath)}`);
  const resp = await axios.get(fetchUrl, {
    responseType: 'arraybuffer',
    timeout: 300000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });
  if (!resp.data?.length) throw new Error('R2 checkpoint download returned empty body');

  fs.writeFileSync(localPath, resp.data);
  spec.assembledPath = localPath;
  spec.outputPath = localPath;
  if (!spec.state) spec.state = {};
  if (!spec.state.savedOutputs) spec.state.savedOutputs = {};
  spec.state.savedOutputs.reprocessedFromR2 = r2Url;
  spec.state.savedOutputs.reprocessedAt = new Date().toISOString();
  log(`checkpoint restored (${(resp.data.length / 1024 / 1024).toFixed(1)} MB)`);
  return localPath;
}

module.exports = {
  restoreAssembledPathFromCheckpoint,
  _resolveCheckpointUrl,
};
