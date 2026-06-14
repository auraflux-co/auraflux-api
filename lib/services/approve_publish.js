'use strict';
/**
 * lib/services/approve_publish.js — CPD-1020
 * Shared helpers for POST /jobs/:id/approve-publish result handling.
 */

/** True when at least one platform upload succeeded. */
function publishResultsHadSuccess(results) {
  if (!results || typeof results !== 'object') return false;
  return Object.values(results).some((r) => {
    if (!r || typeof r !== 'object') return false;
    if (r.failed === true || r.error) return false;
    if (r.ok === true && !r.failReason) return true;
    if (r.platformJobId || r.jobId || r.url || r.videoId) return true;
    return false;
  });
}

module.exports = { publishResultsHadSuccess };
