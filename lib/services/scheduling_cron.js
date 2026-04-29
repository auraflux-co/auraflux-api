'use strict';
/**
 * lib/services/scheduling_cron.js — Content scheduling cron (CPD-48)
 *
 * Runs every 5 minutes. Finds jobs where:
 *   publish_mode = 'scheduled'
 *   status       = 'ready_to_publish'
 *   scheduled_publish_at <= NOW()
 *   actual_published_at IS NULL
 *
 * Fires POST /publish (Upload-Post proxy) for each due job.
 * Idempotent: actual_published_at guard prevents double-publish.
 *
 * Constraints (CPD-48 spec):
 *   - Schedule window: min 30 min in future, max 60 days in future (enforced at creation)
 *   - Cron runs every 5 min; publish occurs within 5 min of scheduled_publish_at
 */

const { getJobsDueForScheduledPublish, markJobActuallyPublished, loadJob } = require('../db');
const { logError } = require('../error_logger');

const CRON_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

let _cronTimer = null;

/**
 * Fire the Upload-Post publish call for a single scheduled job.
 * Uses the same internal-publish path as POST /publish.
 *
 * @param {Object} row — jobs table row
 */
async function _fireScheduledPublish(row) {
  const jobId = row.id;

  try {
    const { handlePublish } = require('../publish');

    const jobSpec = row.job_spec ? JSON.parse(row.job_spec) : loadJob(jobId);
    if (!jobSpec) {
      logError('SCHED_NO_SPEC', new Error(`No spec for scheduled job ${jobId}`), { jobId });
      return;
    }

    // Build a minimal req/res façade so handlePublish can be called directly
    const fakeReq = {
      body:   { jobId, platforms: jobSpec.platforms || [] },
      user:   { id: jobSpec.customerId, planTier: jobSpec.planTier || 'diy' },
      method: 'POST',
      path:   '/publish',
    };
    const fakeRes = {
      _status: 200,
      _body:   null,
      status(code) { this._status = code; return this; },
      json(body)   { this._body = body; },
      end()        { },
    };

    await handlePublish(fakeReq, fakeRes);

    if (fakeRes._status >= 200 && fakeRes._status < 300) {
      markJobActuallyPublished(jobId);
      console.log(`[sched-cron] Published scheduled job ${jobId} at ${new Date().toISOString()}`);
    } else {
      logError('SCHED_PUBLISH_FAIL', new Error(`Publish returned ${fakeRes._status}`), { jobId, body: fakeRes._body });
    }
  } catch (err) {
    logError('SCHED_CRON_ERROR', err, { jobId });
  }
}

/**
 * Run one tick of the scheduling cron:
 * find all due jobs and fire publish for each.
 */
async function runSchedulingCron() {
  let duJobs;
  try {
    duJobs = getJobsDueForScheduledPublish();
  } catch (err) {
    logError('SCHED_CRON_QUERY_ERROR', err, {});
    return;
  }

  if (duJobs.length === 0) return;

  console.log(`[sched-cron] ${duJobs.length} job(s) due for scheduled publish`);

  // Fire sequentially to avoid thundering-herd on the Upload-Post API
  for (const row of duJobs) {
    await _fireScheduledPublish(row);
  }
}

/**
 * Start the scheduling cron (called from server.js or tests).
 * Idempotent — only starts once.
 */
function startSchedulingCron() {
  if (_cronTimer) return;
  _cronTimer = setInterval(() => {
    runSchedulingCron().catch((err) => logError('SCHED_CRON_FATAL', err, {}));
  }, CRON_INTERVAL_MS);

  // Ensure the interval is not a blocking timer
  if (_cronTimer.unref) _cronTimer.unref();

  console.log('[sched-cron] Scheduling cron started (5-min interval)');
}

/**
 * Stop the scheduling cron (used in tests / graceful shutdown).
 */
function stopSchedulingCron() {
  if (_cronTimer) {
    clearInterval(_cronTimer);
    _cronTimer = null;
  }
}

module.exports = { startSchedulingCron, stopSchedulingCron, runSchedulingCron };
