'use strict';

const path = require('path');
const fs = require('fs');
const { countEligibleForPurge, purgeEligibleClips } = require('./store');

const THUMB_ROOT = path.join(__dirname, '../../data/content_library/thumbs');

function deleteOrphanThumbs(deletedRows = []) {
  let removed = 0;
  for (const row of deletedRows) {
    if (!row.thumbnail_url || !row.clip_id) continue;
    const p = path.join(THUMB_ROOT, row.streamer, `${row.clip_id}.jpg`);
    if (fs.existsSync(p)) {
      try {
        fs.unlinkSync(p);
        removed += 1;
      } catch (_e) { /* ignore */ }
    }
  }
  return removed;
}

async function runPurge({ dryRun = false, log = console.log } = {}) {
  const now = Date.now();
  const would = countEligibleForPurge(now);
  log(`[content-library] purge dryRun=${dryRun} eligible=${would}`);
  const result = purgeEligibleClips(now, { dryRun });
  if (!dryRun && result.rows?.length) {
    result.thumbsRemoved = deleteOrphanThumbs(result.rows);
  }
  return result;
}

module.exports = { runPurge };
