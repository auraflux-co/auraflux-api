'use strict';
/**
 * Unified "why" trail: every gate outcome and intervention is recorded to
 * New Relic (PipelineWhy), logs/pipeline_events.jsonl (via pipelineBus → roo_bridge),
 * and SQLite (why_ledger) so ops can answer: spec drift vs bad QA inputs vs broken prod.
 */

const { nrPipelineEvent } = require('./nr_pipeline');
const pipelineBus = require('./pipeline_events');

const FAILURE_CLASS = Object.freeze({
  SPEC_VIOLATION: 'SPEC_VIOLATION',
  QA_INPUT_DEFECT: 'QA_INPUT_DEFECT',
  PRODUCTION_DEFECT: 'PRODUCTION_DEFECT',
  UNKNOWN: 'UNKNOWN',
  NONE: 'NONE'
});

const INTERVENTION = Object.freeze({
  NONE: 'NONE',
  AUTO_SCRIPT: 'AUTO_SCRIPT',
  AGENT_OR_MANUAL: 'AGENT_OR_MANUAL',
  SYSTEM_RETRY: 'SYSTEM_RETRY',
  ESCALATION: 'ESCALATION',
  JOB_KILL: 'JOB_KILL',
  JOB_RESTORE: 'JOB_RESTORE'
});

const NR_STR_MAX = 240;

function trunc(s, n = NR_STR_MAX) {
  if (s == null || s === '') return null;
  const t = typeof s === 'string' ? s : JSON.stringify(s);
  return t.length <= n ? t : `${t.slice(0, n)}…`;
}

/**
 * Heuristic RCA class from free-text + deductions (callers may override).
 */
function inferFailureClass(evt = {}) {
  const parts = [
    evt.reason,
    ...(evt.concerns || []),
    ...((evt.deductions || []).map(d => (typeof d === 'string' ? d : d.reason) || ''))
  ].filter(Boolean);
  const blob = parts.join(' ').toLowerCase();

  const prod = /\b(econn|etimedout|timeout|502|503|504\b|status code 5|puppeteer|ffmpeg|heygen|enotfound|eai_again|socket hang|download failed|assembly_preflight|no such file|sqlite error|json\.parse|rate limit|api error|connection refused)\b/i;
  const qa = /\b(clip analysis|authorized facts|cannot be verified against clip|gate 0|no score data|missing.*analysis|gemini.*clip|video metadata|no video analysis|qa input)\b/i;
  if (prod.test(blob)) return FAILURE_CLASS.PRODUCTION_DEFECT;
  if (qa.test(blob)) return FAILURE_CLASS.QA_INPUT_DEFECT;
  const spec = /\b(locked intro|locked outro|fabricat(?:ion|ed)?|prohibited|scene count|clip count|format mismatch|template|accuracy|intro text incorrect)\b/i;
  if (spec.test(blob)) return FAILURE_CLASS.SPEC_VIOLATION;
  return FAILURE_CLASS.UNKNOWN;
}

/**
 * @param {Object} p
 * @param {string} p.jobId
 * @param {string} [p.gate]
 * @param {string} p.kind — gate_outcome | auto_action | pipeline_escalation | job_kill | job_restore | gate_input_defect
 * @param {boolean} [p.passed]
 * @param {number|null} [p.score]
 * @param {string} [p.outcome]
 * @param {string} [p.contentType]
 * @param {string} [p.customerId]
 * @param {string} [p.failureClass] — override inferFailureClass
 * @param {string} [p.interventionType]
 * @param {string} [p.interventionOutcome] — e.g. proceed | blocked | retried
 * @param {string[]} [p.reasons]
 * @param {Object} [p.contractDigest]
 * @param {Object} [p.evidenceDigest]
 * @param {string} [p.source]
 */
function recordWhyLedger(p) {
  if (!p || !p.jobId) return;

  const passed = p.passed === undefined ? null : !!p.passed;
  let failureClass = p.failureClass;
  if (!failureClass) {
    if (passed === true) failureClass = FAILURE_CLASS.NONE;
    else failureClass = inferFailureClass(p);
  }

  const interventionType = p.interventionType || INTERVENTION.NONE;
  const reasons = Array.isArray(p.reasons) ? p.reasons.filter(Boolean).slice(0, 20) : [];
  const contractDigest = p.contractDigest && typeof p.contractDigest === 'object' ? p.contractDigest : null;
  const evidenceDigest = p.evidenceDigest && typeof p.evidenceDigest === 'object' ? p.evidenceDigest : null;
  const createdAt = Date.now();

  const row = {
    jobId: p.jobId,
    gate: p.gate != null ? String(p.gate) : null,
    kind: p.kind || 'unknown',
    passed: passed === null ? null : passed ? 1 : 0,
    score: p.score != null ? Number(p.score) : null,
    outcome: p.outcome || null,
    failureClass,
    interventionType,
    interventionOutcome: p.interventionOutcome || null,
    reasons,
    contractDigest,
    evidenceDigest,
    source: p.source || null,
    meta: p.meta && typeof p.meta === 'object' ? p.meta : null
  };

  try {
    const db = require('./db');
    if (db && typeof db.saveWhyLedger === 'function') {
      db.saveWhyLedger(row);
    }
  } catch (_e) { /* non-fatal */ }

  nrPipelineEvent('PipelineWhy', {
    jobId: row.jobId,
    gate: row.gate,
    kind: row.kind,
    passed: row.passed,
    score: row.score,
    outcome: trunc(row.outcome, 120),
    failureClass: row.failureClass,
    interventionType: row.interventionType,
    interventionOutcome: trunc(row.interventionOutcome, 120),
    reasonList: trunc(reasons.join(' | '), 3900),
    contractDigest: trunc(contractDigest ? JSON.stringify(contractDigest) : null, 3900),
    evidenceDigest: trunc(evidenceDigest ? JSON.stringify(evidenceDigest) : null, 3900),
    source: trunc(row.source, 120)
  });

  const busPayload = {
    ts: new Date().toISOString(),
    type: 'why:ledger',
    ...row,
    reasons,
    passed: passed === null ? null : passed
  };
  try {
    pipelineBus.emit('why:ledger', busPayload);
  } catch (_e) { /* non-fatal */ }
}

module.exports = {
  FAILURE_CLASS,
  INTERVENTION,
  inferFailureClass,
  recordWhyLedger
};
