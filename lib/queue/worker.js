'use strict';
/**
 * lib/queue/worker.js — BullMQ pipeline worker (CPD-324)
 *
 * Picks up jobs from the 'pipeline' queue and runs them through
 * runPortalSequence — the same logic that was previously inline in
 * jobs_c1.js via setImmediate.
 *
 * Survives server restarts: unprocessed jobs stay in Redis and are
 * claimed by the worker when the server comes back up.
 *
 * Called from lib/server.js via startPipelineWorker().
 */

const { Worker } = require('bullmq');
const { redisConnection, QUEUE_NAME } = require('./index');
const { logError } = require('../error_logger');

const CONCURRENCY = parseInt(process.env.PIPELINE_WORKER_CONCURRENCY || '2', 10);

let _worker = null;

/**
 * Process a single pipeline job from the queue.
 * This mirrors the setImmediate body from jobs_c1.js POST /jobs.
 */
async function processPipelineJob(bullJob) {
  const { jobSpec } = bullJob.data;
  const jobId = jobSpec?.jobId || bullJob.id;

  console.log(`[pipeline-worker] picking up job ${jobId} (attempt ${bullJob.attemptsMade + 1})`);

  // ── Credit deduction ────────────────────────────────────────────────────────
  const customerId = jobSpec?.customerId;
  const creditCost = jobSpec?.creditCost || 0;

  if (creditCost > 0 && customerId) {
    const { consumeCredits } = require('../services/credits');
    const creditResult = await consumeCredits(customerId, jobId, creditCost);

    if (!creditResult.ok) {
      if (creditResult.status === 'PAUSED') {
        logError('CPD120_CREDIT_PAUSED', creditResult.reason, { jobId, customerId });
        const { saveJob } = require('../db');
        await saveJob(jobId, { ...jobSpec, status: 'credit_paused', updatedAt: new Date().toISOString() }).catch(() => {});
        return { skipped: true, reason: 'credit_paused' };
      }
      if (creditResult.status !== 'ALREADY_CHARGED') {
        logError('CPD120_CREDIT_WARN', creditResult.reason || creditResult.status, { jobId });
      }
    }
  }

  // ── Pre-pipeline steps (mirrors jobs_c1.js) ─────────────────────────────────
  const sourceType = jobSpec?.order?.sourceType || jobSpec?.sourceType;

  if (sourceType === 'wan_gen') {
    const { _runWanPreGeneration } = require('../routes/jobs_c1');
    const ok = await _runWanPreGeneration(jobSpec, jobId);
    if (!ok) {
      throw new Error(`WAN pre-generation failed for job ${jobId}`);
    }
  }

  if (sourceType === 'research_query') {
    const { _runWebResearchPreStep } = require('../routes/jobs_c1');
    await _runWebResearchPreStep(jobSpec, jobId);
  }

  if (jobSpec.addOns?.clipSourcing?.active) {
    try {
      const { isFeatureEnabled } = require('../services/feature_gate');
      if (isFeatureEnabled('clip.sourcing', jobSpec.planTier)) {
        const clipSourcingSvc = require('../clip_sourcing');
        await clipSourcingSvc.runForJob(jobSpec).catch((e) =>
          console.warn(`[pipeline-worker] ${jobId}: clip sourcing failed (non-fatal) — ${e.message}`)
        );
      }
    } catch (_e) {
      console.warn(`[pipeline-worker] ${jobId}: clip sourcing unavailable — ${_e.message}`);
    }
  }

  try {
    const { generateJobScript } = require('../script_gen_service');
    await generateJobScript(jobSpec);
  } catch (_e) {
    console.warn(`[pipeline-worker] ${jobId}: script pre-gen failed (non-fatal) — ${_e.message}`);
  }

  // ── Portal sequence ─────────────────────────────────────────────────────────
  const { runPortalSequence } = require('../portal_policy_runner');
  const { _resolvePortalWorkers, _resolveExtensionWorkers } = require('../routes/jobs_c1');

  const { nrJobCreated, nrJobComplete, nrJobFailed, nrPortalStart, nrPortalPass, nrPortalFail } = require('../nr_events');
  const _jobStartMs = Date.now();
  nrJobCreated(jobSpec);

  const result = await runPortalSequence({
    jobSpec,
    portalWorkers:    _resolvePortalWorkers(jobSpec),
    extensionWorkers: _resolveExtensionWorkers(),
    onPortalStart: (portalKey) => {
      console.log(`[pipeline-worker] ${jobId}: portal ${portalKey} started`);
      nrPortalStart(jobSpec, portalKey);
    },
    onPortalPass: (portalKey) => {
      console.log(`[pipeline-worker] ${jobId}: portal ${portalKey} passed`);
      nrPortalPass(jobSpec, portalKey);
    },
    onPortalFail: (portalKey, r) => {
      console.log(`[pipeline-worker] ${jobId}: portal ${portalKey} failed`);
      nrPortalFail(jobSpec, portalKey, r);
    },
    onJobComplete: () => {
      console.log(`[pipeline-worker] ${jobId}: complete in ${Date.now() - _jobStartMs}ms`);
      nrJobComplete(jobSpec, Date.now() - _jobStartMs);
    },
    onJobFailed: (failedPortal, r) => {
      console.log(`[pipeline-worker] ${jobId}: failed at ${failedPortal}`);
      nrJobFailed(jobSpec, failedPortal, r);
    },
  });

  return result;
}

function startPipelineWorker() {
  if (_worker) return _worker;

  let connection;
  try {
    connection = redisConnection();
  } catch (err) {
    console.warn('[pipeline-worker] REDIS_URL not set — worker not started. Jobs will not process.');
    return null;
  }

  _worker = new Worker(QUEUE_NAME, processPipelineJob, {
    connection,
    concurrency: CONCURRENCY,
    lockDuration: 30 * 60 * 1000, // 30 min — long enough for a full pipeline run
  });

  _worker.on('completed', (job, result) => {
    console.log(`[pipeline-worker] ✅ Job ${job.data?.jobSpec?.jobId || job.id} completed`);
  });

  _worker.on('failed', (job, err) => {
    const jid = job?.data?.jobSpec?.jobId || job?.id;
    console.error(`[pipeline-worker] ❌ Job ${jid} failed (attempt ${job?.attemptsMade}): ${err.message}`);
    logError('PIPELINE_WORKER_FAIL', err, { jobId: jid, attempt: job?.attemptsMade });
  });

  _worker.on('error', (err) => {
    console.error('[pipeline-worker] Worker error:', err.message);
  });

  console.log(`[pipeline-worker] Started (concurrency=${CONCURRENCY})`);
  return _worker;
}

function stopPipelineWorker() {
  if (_worker) {
    _worker.close();
    _worker = null;
  }
}

module.exports = { startPipelineWorker, stopPipelineWorker };
