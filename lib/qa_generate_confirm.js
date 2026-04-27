'use strict';
/**
 * QA confirmation on generate (vs gate-worker sign-off at pre-generate).
 *
 * Policy: QA_CONFIRM_ON_GENERATE=true → POST /generate-full-script must include
 *   qaGenerateConfirmed: true (or qaGenerateConfirm: true) after QA agents agree,
 *   OR call POST /job/:jobId/qa-confirm-generate first.
 *
 * Monitoring: state.automation.qaGenerateConfirm records policy, status, timestamps
 * even when policy is off (not_required) so dashboards can compare to gate workers.
 */

function isPolicyEnabled() {
  return process.env.QA_CONFIRM_ON_GENERATE === 'true';
}

function persistAfterPreGenerate(jobId, { allReady, commitments } = {}) {
  if (!jobId) return;
  const { updateJobSpec, getJobSpec } = require('./job_spec');
  const enabled = isPolicyEnabled();
  const prev = (() => {
    try {
      return getJobSpec(jobId)?.state?.automation?.qaGenerateConfirm || {};
    } catch (_e) {
      return {};
    }
  })();
  const readyCount =
    commitments && typeof commitments === 'object'
      ? Object.values(commitments).filter((c) => c && c.ready).length
      : null;
  updateJobSpec(jobId, {
    state: {
      automation: {
        qaGenerateConfirm: {
          ...prev,
          policyEnabled: enabled,
          status: enabled ? 'awaiting_qa' : 'not_required',
          preGenerateAt: new Date().toISOString(),
          gateWorkersAllReady: !!allReady,
          gateCommitmentsReadyCount: readyCount,
        },
      },
    },
  });
}

/**
 * Mark QA as having confirmed generate for this job (DB).
 */
function markConfirmed(jobId, meta = {}) {
  if (!jobId) return;
  const { updateJobSpec, getJobSpec } = require('./job_spec');
  const prev = (() => {
    try {
      return getJobSpec(jobId)?.state?.automation?.qaGenerateConfirm || {};
    } catch (_e) {
      return {};
    }
  })();
  updateJobSpec(jobId, {
    state: {
      automation: {
        qaGenerateConfirm: {
          ...prev,
          status: 'confirmed',
          confirmedAt: new Date().toISOString(),
          confirmSource: meta.source || 'api',
        },
      },
    },
  });
}

function requestSaysConfirmed(body) {
  if (!body || typeof body !== 'object') return false;
  if (body.qaGenerateConfirmed === true) return true;
  if (body.qaGenerateConfirm === true) return true;
  return false;
}

module.exports = {
  isPolicyEnabled,
  persistAfterPreGenerate,
  markConfirmed,
  requestSaysConfirmed,
};
