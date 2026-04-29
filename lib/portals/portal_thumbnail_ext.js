'use strict';
/**
 * lib/portals/portal_thumbnail_ext.js — Thumbnail approval extension worker
 *
 * Fires after Portal 4 (Full Assembly QA). Generates candidate thumbnails,
 * sets jobSpec.state.thumbnail = { status: 'pending', candidates: [...] },
 * and emits thumbnail:approval_needed.
 *
 * This extension always passes — it hands off to the async customer approval
 * flow. Portal 5 then holds if thumbnail.status is still 'pending'.
 *
 * Activation: jobSpec.extensions.thumbnail_ext.ordered === true
 *             (set when addOns.thumbnail_approval.active === true)
 */

const { initiateApprovalStage } = require('../services/thumbnail_stage');
const { logError }              = require('../error_logger');

/**
 * Extension worker entry point.
 *
 * @param {Object} opts
 * @param {Object} opts.jobSpec
 * @param {number} opts.workerAttempt
 * @returns {Promise<{passed: boolean, outcome: string, thumbnail: Object}>}
 */
async function runWorker({ jobSpec, workerAttempt = 1 }) {
  const jobId = jobSpec?.jobId || 'unknown';
  console.log(`[thumbnail_ext:${jobId}] attempt=${workerAttempt} — initiating approval stage`);

  try {
    const result = await initiateApprovalStage(jobSpec);
    console.log(
      `[thumbnail_ext:${jobId}] candidates generated: ${result.thumbnail.candidates.length} — status=pending`
    );
    return result;
  } catch (e) {
    logError('THUMBNAIL_EXT_FAIL', e, { jobId, workerAttempt });
    // Non-blocking — if thumbnail generation fails, portal5 proceeds without thumbnail.
    // Log and pass with a warning rather than halting the pipeline.
    return {
      passed:  true,
      outcome: 'thumbnail_generation_failed_non_blocking',
      error:   e.message,
    };
  }
}

function isPass(result) {
  return result?.passed === true;
}

module.exports = { runWorker, isPass };
