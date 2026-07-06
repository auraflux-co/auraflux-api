'use strict';
/**
 * lib/services/job_retry_dispatch.js — CPD-1231
 *
 * Shared operator/customer job retry dispatch used by jobs_c1 and developer_api.
 */

const { logError } = require('../error_logger');

const RETRYABLE_STATUSES = new Set(['failed', 'held', 'complete', 'staged']);

/**
 * Reset job spec for pipeline re-dispatch.
 */
function prepareJobForRetry(spec, { operatorId, action = 'retry', note = null, clearGateResults = true } = {}) {
  const now = new Date().toISOString();
  spec.status = 'queued';
  spec.updatedAt = now;
  if (!spec.state) spec.state = {};
  if (clearGateResults) spec.state.gateResults = {};
  spec.state.operatorActions = [
    ...(spec.state.operatorActions || []),
    { action, operatorId: operatorId || null, at: now, note },
  ];
  return now;
}

/**
 * Fire-and-forget portal sequence re-dispatch (mirrors jobs_c1 retry path).
 */
function dispatchJobRetry(jobId, spec, {
  resolvePortalWorkers,
  resolveExtensionWorkers,
  logPrefix = '[retry]',
  nrPortalFail,
  nrJobComplete,
  nrJobFailed,
} = {}) {
  if (typeof resolvePortalWorkers !== 'function' || typeof resolveExtensionWorkers !== 'function') {
    throw new Error('resolvePortalWorkers and resolveExtensionWorkers are required');
  }

  const { runPortalSequence } = require('../portal_policy_runner');
  const {
    runAssemblyAndPostProcess,
    isPortal1Active,
    runTtsMixAndChrome,
    ensureChromeApplied,
    runJobComplete,
  } = require('./pipeline_assembly');

  const workers = resolvePortalWorkers(spec);
  const _retryStartMs = Date.now();

  setImmediate(() => {
    runPortalSequence({
      jobSpec: spec,
      portalWorkers: workers,
      extensionWorkers: resolveExtensionWorkers(spec),
      onPortalPass: async (portalKey, result) => {
        const { saveJob: _sj } = require('../db');
        const _persist = (patch) => _sj(jobId, { ...spec, ...patch }).catch(() => {});
        if ((portalKey === 'portal1') || (portalKey === 'portal0' && !isPortal1Active(spec))) {
          await runAssemblyAndPostProcess(spec, jobId, { logPrefix, persist: _persist });
        }
        if (portalKey === 'tts_ext') {
          const ttsAudio = result?.audioPath || spec.state?.tts?.audioPath;
          if (ttsAudio) await runTtsMixAndChrome(spec, jobId, ttsAudio, { logPrefix, persist: _persist });
        }
        if (portalKey === 'portal3a') {
          await ensureChromeApplied(spec, jobId, { logPrefix });
        }
      },
      onPortalFail: (pk, r) => {
        logError('JOB_RETRY_PORTAL_FAIL', r?.reason || pk, { jobId });
        if (typeof nrPortalFail === 'function') nrPortalFail(spec, pk, r?.reason || r?.failReason);
      },
      onJobComplete: () => runJobComplete(spec, jobId, {
        jobStartMs: _retryStartMs,
        logPrefix,
        nrJobComplete,
      }),
      onJobFailed: (fp, r) => {
        logError('JOB_RETRY_JOB_FAILED', r?.reason || fp, { jobId });
        if (typeof nrJobFailed === 'function') nrJobFailed(spec, fp, r?.reason || r?.failReason);
      },
      persistJobStatus: ({ portalKey: pKey, phase }) => {
        try {
          const { saveJob } = require('../db');
          saveJob(jobId, {
            ...spec,
            status: phase,
            currentPortal: pKey,
            updatedAt: new Date().toISOString(),
          }).catch((err) => console.error('[db] retry persistJobStatus failed:', err.message));
        } catch (_e) { /* ignore */ }
      },
    }).catch((err) => logError('JOB_RETRY_DISPATCH_FAIL', err, { jobId }));
  });
}

module.exports = {
  RETRYABLE_STATUSES,
  prepareJobForRetry,
  dispatchJobRetry,
};
