'use strict';
/**
 * Per-gate QA cycle policy (monitoring layer).
 *
 * Tier model:
 *   QA_TIER_REVIEW (1) — formal QA review/report; `gate:sendback` — drives qa_cycle kill limits.
 *   QA_TIER_OPS (2)    — operational / worker / self-heal handoffs; `gate:ops_sendback` — logged only.
 *
 * Worker phase: up to QA_MAX_WORKER_SENDBACKS sendbacks to gate workers (with optional self-heal in gate code).
 * Intervention phase: up to QA_MAX_INTERVENTION_ATTEMPTS sendback-equivalent failures while QA/system intervenes.
 * Kill: after worker + intervention sendbacks are exhausted (default 3 + 3 = 6 total at the same gate).
 *
 * Counts reset when the gate passes (gate:pass). Separate counter per gate id.
 *
 * Env:
 *   QA_MAX_WORKER_SENDBACKS   (default 3)
 *   QA_MAX_INTERVENTION_ATTEMPTS (default 3) — includes final kill on last attempt
 */

function limits() {
  const worker = Math.max(1, parseInt(process.env.QA_MAX_WORKER_SENDBACKS || '3', 10) || 3);
  const intervention = Math.max(
    1,
    parseInt(process.env.QA_MAX_INTERVENTION_ATTEMPTS || '3', 10) || 3
  );
  return { worker, intervention, maxTotal: worker + intervention };
}

/**
 * Normalize gate to a short key, e.g. "gate1" → "1", 3 → "3"
 */
function gateKey(gate) {
  if (gate == null || gate === '') return 'unknown';
  const s = String(gate);
  const m = s.match(/(\d+)/);
  return m ? m[1] : s.replace(/^gate/i, '') || 'unknown';
}

function getByGateFromSpec(jobSpec) {
  return (
    (jobSpec &&
      jobSpec.state &&
      jobSpec.state.automation &&
      jobSpec.state.automation.qaCycle &&
      jobSpec.state.automation.qaCycle.byGate) ||
    {}
  );
}

/**
 * Record one QA sendback at a gate; persist to job_spec and return phase + kill decision.
 * @returns {{
 *   gateKey: string,
 *   sendbacks: number,
 *   phase: 'worker'|'intervention',
 *   workerAttempt: number,
 *   interventionAttempt: number,
 *   shouldKill: boolean,
 *   killReason: string|null
 * }}
 */
/**
 * Describe cycle phase from a 1-based sendback index (no DB). Useful when jobId is unknown.
 */
function describeFromSendbackIndex(sendbacks) {
  const { worker, intervention, maxTotal } = limits();
  let phase = 'worker';
  let interventionAttempt = 0;
  let workerAttempt = 0;
  if (sendbacks <= worker) {
    phase = 'worker';
    workerAttempt = sendbacks;
  } else {
    phase = 'intervention';
    workerAttempt = worker;
    interventionAttempt = sendbacks - worker;
  }
  const shouldKill = sendbacks >= maxTotal;
  const killReason = shouldKill
    ? `QA cycle exhausted: ${sendbacks} sendback(s) (policy worker=${worker} + intervention=${intervention} = ${maxTotal} max)`
    : null;
  return {
    gateKey: 'unknown',
    sendbacks,
    phase,
    workerAttempt,
    interventionAttempt,
    shouldKill,
    killReason,
  };
}

function recordSendback(jobId, gate) {
  if (!jobId || jobId === 'unknown') {
    throw new Error('recordSendback requires a canonical jobId');
  }
  const { worker, intervention, maxTotal } = limits();
  const k = gateKey(gate);

  const { getJobSpec, updateJobSpec } = require('./job_spec');
  let spec = null;
  try {
    spec = getJobSpec(jobId);
  } catch (_e) {
    spec = null;
  }

  const prev = getByGateFromSpec(spec);
  const cur = prev[k] || { sendbacks: 0 };
  const sendbacks = (cur.sendbacks || 0) + 1;
  const now = new Date().toISOString();
  const nextByGate = {
    ...prev,
    [k]: {
      ...cur,
      sendbacks,
      lastAt: now,
      lastPhase: sendbacks <= worker ? 'worker' : 'intervention',
    },
  };

  try {
    updateJobSpec(jobId, {
      state: {
        automation: {
          qaCycle: {
            byGate: nextByGate,
            lastSendbackGate: k,
            lastSendbackAt: now,
          },
        },
      },
    });
  } catch (e) {
    console.warn(`[qa_cycle] persist failed for ${jobId}: ${e.message}`);
  }

  let phase = 'worker';
  let interventionAttempt = 0;
  let workerAttempt = 0;

  if (sendbacks <= worker) {
    phase = 'worker';
    workerAttempt = sendbacks;
  } else {
    phase = 'intervention';
    workerAttempt = worker;
    interventionAttempt = sendbacks - worker;
  }

  const shouldKill = sendbacks >= maxTotal;
  const killReason = shouldKill
    ? `QA cycle exhausted at gate ${gate}: ${sendbacks} sendback(s) (policy worker=${worker} + intervention=${intervention} = ${maxTotal} max)`
    : null;

  return {
    gateKey: k,
    sendbacks,
    phase,
    workerAttempt,
    interventionAttempt,
    shouldKill,
    killReason,
  };
}

/**
 * Clear per-gate QA sendback count when the gate passes.
 */
function resetGate(jobId, gate) {
  if (!jobId) return;
  const { getJobSpec, updateJobSpec } = require('./job_spec');
  let spec;
  try {
    spec = getJobSpec(jobId);
  } catch (_e) {
    return;
  }
  const k = gateKey(gate);
  const prev = getByGateFromSpec(spec);
  if (!prev[k]) return;
  const nextByGate = { ...prev };
  delete nextByGate[k];
  try {
    updateJobSpec(jobId, {
      state: {
        automation: {
          qaCycle: {
            byGate: nextByGate,
            lastPassGate: k,
            lastPassAt: new Date().toISOString(),
          },
        },
      },
    });
  } catch (e) {
    console.warn(`[qa_cycle] resetGate failed for ${jobId}: ${e.message}`);
  }
}

/** Tier 1 — QA review/report (counts toward qa_cycle on gate:sendback) */
const QA_TIER_REVIEW = 1;
/** Tier 2 — operational / worker / internal (gate:ops_sendback — no qa_cycle) */
const QA_TIER_OPS = 2;

module.exports = {
  QA_TIER_REVIEW,
  QA_TIER_OPS,
  limits,
  gateKey,
  recordSendback,
  describeFromSendbackIndex,
  resetGate,
  getByGateFromSpec,
};
