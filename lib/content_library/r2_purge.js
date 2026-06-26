'use strict';

const { deleteFromR2, isR2Configured } = require('../storage');
const {
  listStagedClipsEligibleForPurge,
  listUsedStagedClipsEligibleForPurge,
  deleteStagedClipRow,
} = require('./staged_store');

async function purgeStagedR2Clips({ dryRun = false, log = console.log, now = Date.now() } = {}) {
  const unusedRows = listStagedClipsEligibleForPurge(now);
  const usedRows = listUsedStagedClipsEligibleForPurge(now);
  const rows = [...unusedRows, ...usedRows];
  log(`[content-library] R2 staged purge dryRun=${dryRun} unused=${unusedRows.length} used+7d=${usedRows.length}`);
  if (dryRun) {
    return { deleted: 0, wouldDelete: rows.length, r2Removed: 0, rows };
  }

  let deleted = 0;
  let r2Removed = 0;
  if (isR2Configured()) {
    for (const row of rows) {
      if (!row.r2_key) continue;
      try {
        await deleteFromR2(row.r2_key);
        r2Removed += 1;
      } catch (err) {
        log(`[content-library] R2 delete failed ${row.r2_key}: ${err.message}`);
      }
    }
  }

  for (const row of rows) {
    deleteStagedClipRow(row.id);
    deleted += 1;
  }

  return { deleted, wouldDelete: rows.length, r2Removed, rows };
}

module.exports = { purgeStagedR2Clips };
