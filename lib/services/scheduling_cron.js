'use strict';
/**
 * lib/services/scheduling_cron.js — Content scheduling cron (CPD-48 / CPD-118 / CPD-119)
 *
 * Runs every 5 minutes. Handles three scheduling surfaces:
 *
 * 1. Deferred publish (CPD-48) — jobs already assembled, publish deferred to a future time.
 *    publish_mode = 'scheduled', scheduled_publish_at <= NOW()
 *
 * 2. Scheduled job start (CPD-118) — pipeline fires at a scheduled time from a job spec.
 *    status = 'queued_scheduled', scheduled_start_at <= NOW()
 *
 * 3. Recurring templates (CPD-119) — templates with a cadence auto-create new jobs when due.
 *    recurrence_active = TRUE, next_fire_at <= NOW()
 */

const {
  getJobsDueForScheduledPublish,
  markJobActuallyPublished,
  loadJob,
  getJobsDueForScheduledStart,
  getTemplatesDueForRecurrence,
  bumpTemplateNextFire,
} = require('../db');
const { consumeCredits }     = require('./credits');
const { logError }           = require('../error_logger');
const { createNotification } = require('./notifications');

const CRON_INTERVAL_MS = 5 * 60 * 1000;

let _cronTimer = null;

// ── 1. Deferred publish (CPD-48) ──────────────────────────────────────────────

async function _fireScheduledPublish(row) {
  const jobId = row.id;
  try {
    const { handlePublish } = require('../publish');
    const jobSpec = row.job_spec ? JSON.parse(row.job_spec) : loadJob(jobId);
    if (!jobSpec) {
      logError('SCHED_NO_SPEC', new Error(`No spec for scheduled job ${jobId}`), { jobId });
      return;
    }
    const fakeReq = {
      body:   { jobId, platforms: jobSpec.platforms || [] },
      user:   { id: jobSpec.customerId, planTier: jobSpec.planTier || 'operate' },
      method: 'POST',
      path:   '/publish',
    };
    const fakeRes = {
      _status: 200, _body: null,
      status(c) { this._status = c; return this; },
      json(b)   { this._body = b; },
      end()     {},
    };
    await handlePublish(fakeReq, fakeRes);
    if (fakeRes._status >= 200 && fakeRes._status < 300) {
      await markJobActuallyPublished(jobId);
      console.log(`[sched-cron] Published scheduled job ${jobId}`);
    } else {
      logError('SCHED_PUBLISH_FAIL', new Error(`Publish returned ${fakeRes._status}`), { jobId, body: fakeRes._body });
    }
  } catch (err) {
    logError('SCHED_CRON_ERROR', err, { jobId });
  }
}

// ── 2. Scheduled job start (CPD-118) ─────────────────────────────────────────

async function _fireScheduledStart(row) {
  const jobId = row.id;
  try {
    const jobSpec = row.job_spec ? JSON.parse(row.job_spec) : loadJob(jobId);
    if (!jobSpec) {
      logError('SCHED_START_NO_SPEC', new Error(`No spec for queued_scheduled job ${jobId}`), { jobId });
      return;
    }

    // Debit credits now (CPD-118 — fire time, not creation time)
    const creditCost = jobSpec.creditCost || 1;
    try {
      await consumeCredits(jobSpec.customerId, jobId, creditCost, jobSpec.brandId || null);
    } catch (creditErr) {
      logError('SCHED_START_CREDIT_FAIL', creditErr, { jobId });
      // Pause job rather than starting it without credits
      const { failJob } = require('../job_spec');
      failJob(jobId, 'sched_start', 'credit_paused');
      createNotification(jobSpec.customerId, {
        type:      'scheduled_missed',
        title:     "A scheduled job didn't run",
        body:      'Insufficient credits at fire time. Top up to resume scheduling.',
        actionUrl: '/dashboard/billing',
      });
      return;
    }

    // Fire the portal sequence in-process
    const { runPortalSequence } = require('../portal_policy_runner');
    console.log(`[sched-cron] Starting scheduled job ${jobId}`);
    setImmediate(() => {
      runPortalSequence(jobSpec).catch((err) =>
        logError('SCHED_START_PORTAL_ERROR', err, { jobId }),
      );
    });
  } catch (err) {
    logError('SCHED_START_ERROR', err, { jobId });
  }
}

// ── 3. Recurring templates (CPD-119) ─────────────────────────────────────────

async function _fireRecurringTemplate(tpl) {
  try {
    const { createJobSpec } = require('../job_spec');
    const { saveJob }       = require('../db');

    const baseSpec = typeof tpl.job_spec === 'string' ? JSON.parse(tpl.job_spec) : tpl.job_spec;
    const jobSpec  = createJobSpec({
      ...baseSpec,
      customerId:    tpl.customer_id,
      templateId:    tpl.id,
      templateName:  tpl.name,
      scheduledFrom: 'recurrence',
    });

    await saveJob(jobSpec.jobId, jobSpec);

    // Debit credits immediately
    const creditCost = jobSpec.creditCost || 1;
    try {
      await consumeCredits(tpl.customer_id, jobSpec.jobId, creditCost, tpl.brand_id || null);
    } catch (creditErr) {
      logError('RECUR_CREDIT_FAIL', creditErr, { templateId: tpl.id });
      createNotification(tpl.customer_id, {
        type:      'template_failed',
        title:     `Template "${tpl.name || tpl.id}" failed to run`,
        body:      'Insufficient credits. Top up to keep this template running.',
        actionUrl: '/dashboard/billing',
      });
      await bumpTemplateNextFire(tpl.id, tpl.recurrence_type, tpl.recurrence_day, tpl.recurrence_time);
      return;
    }

    // Start the pipeline
    const { runPortalSequence } = require('../portal_policy_runner');
    console.log(`[sched-cron] Firing recurring template ${tpl.id} → job ${jobSpec.jobId}`);
    setImmediate(() => {
      runPortalSequence(jobSpec).catch((err) => {
        logError('RECUR_PORTAL_ERROR', err, { jobId: jobSpec.jobId, templateId: tpl.id });
        createNotification(tpl.customer_id, {
          type:      'template_failed',
          title:     `Template "${tpl.name || tpl.id}" failed to run`,
          body:      err.message || 'Pipeline error during template job.',
          actionUrl: `/dashboard/jobs/${jobSpec.jobId}`,
        });
      });
    });

    // Advance next_fire_at to the next occurrence
    await bumpTemplateNextFire(tpl.id, tpl.recurrence_type, tpl.recurrence_day, tpl.recurrence_time);
  } catch (err) {
    logError('RECUR_TEMPLATE_ERROR', err, { templateId: tpl.id });
    createNotification(tpl.customer_id, {
      type:      'template_failed',
      title:     `Template "${tpl.name || tpl.id}" failed to run`,
      body:      err.message || 'Unexpected error.',
      actionUrl: '/dashboard/templates',
    });
  }
}

// ── Main cron tick ────────────────────────────────────────────────────────────

async function runSchedulingCron() {
  // 1. Deferred publishes (CPD-48)
  try {
    const duePublish = await getJobsDueForScheduledPublish();
    if (duePublish.length > 0) {
      console.log(`[sched-cron] ${duePublish.length} job(s) due for deferred publish`);
      for (const row of duePublish) await _fireScheduledPublish(row);
    }
  } catch (err) {
    logError('SCHED_CRON_PUBLISH_QUERY', err, {});
  }

  // 2. Scheduled job starts (CPD-118)
  try {
    const dueStarts = await getJobsDueForScheduledStart();
    if (dueStarts.length > 0) {
      console.log(`[sched-cron] ${dueStarts.length} job(s) due for scheduled start`);
      for (const row of dueStarts) await _fireScheduledStart(row);
    }
  } catch (err) {
    logError('SCHED_CRON_START_QUERY', err, {});
  }

  // 3. Recurring templates (CPD-119)
  try {
    const dueTemplates = await getTemplatesDueForRecurrence();
    if (dueTemplates.length > 0) {
      console.log(`[sched-cron] ${dueTemplates.length} recurring template(s) due`);
      for (const tpl of dueTemplates) await _fireRecurringTemplate(tpl);
    }
  } catch (err) {
    logError('SCHED_CRON_RECUR_QUERY', err, {});
  }

  // 4. Upload temp file TTL cleanup (CPD-321)
  try { cleanupStaleUploads(); } catch (err) { logError('UPLOAD_CLEANUP_CRON', err, {}); }
}

function startSchedulingCron() {
  if (_cronTimer) return;
  _cronTimer = setInterval(() => {
    runSchedulingCron().catch((err) => logError('SCHED_CRON_FATAL', err, {}));
  }, CRON_INTERVAL_MS);
  if (_cronTimer.unref) _cronTimer.unref();
  console.log('[sched-cron] Scheduling cron started (5-min interval)');
}

function stopSchedulingCron() {
  if (_cronTimer) { clearInterval(_cronTimer); _cronTimer = null; }
}

// ── Upload temp file TTL cleanup (CPD-321) ──────────────────────────────────
// Deletes uploaded video files older than 48 hours from the persistent disk
// upload directory. Runs as part of the scheduling cron (every 5 min).
const UPLOAD_TTL_MS = 48 * 60 * 60 * 1000; // 48 hours
const UPLOAD_DIRS = [
  '/app/data/uploads',
  require('path').join(__dirname, '../../data/uploads'),
];

function cleanupStaleUploads() {
  const fs = require('fs');
  const path = require('path');
  const cutoff = Date.now() - UPLOAD_TTL_MS;
  for (const dir of UPLOAD_DIRS) {
    if (!fs.existsSync(dir)) continue;
    let cleaned = 0;
    try {
      for (const file of fs.readdirSync(dir)) {
        const full = path.join(dir, file);
        try {
          const stat = fs.statSync(full);
          if (stat.isFile() && stat.mtimeMs < cutoff) {
            fs.unlinkSync(full);
            cleaned++;
          }
        } catch (_) {}
      }
      if (cleaned > 0) console.log(`[sched-cron] Cleaned ${cleaned} stale upload(s) from ${dir}`);
    } catch (err) {
      logError('UPLOAD_CLEANUP', err, { dir });
    }
  }
}

module.exports = { startSchedulingCron, stopSchedulingCron, runSchedulingCron, cleanupStaleUploads };
