'use strict';
/**
 * lib/monitoring.js — Pipeline Monitor + Escalation
 *
 * Listens to pipeline_events.js bus for escalation events.
 * Watches for:
 *   - Gate worker silent > 10 minutes
 *   - QA sendback loop (per gate): worker sendbacks (QA_MAX_WORKER_SENDBACKS, default 3)
 *     then intervention attempts (QA_MAX_INTERVENTION_ATTEMPTS, default 3); then kill at gate
 *   - Escalation cap (hard_fail / silence): two full escalation rounds — third trigger kills the job
 *   - External API error
 *   - Hard fail from any gate
 *
 * On escalation:
 *   - Writes to logs/errors.jsonl with jobId + gate + full trail
 *   - Emits 'escalation' event on monitoringBus
 *   - Applies recovery decision tree
 *
 * Recovery decision tree:
 *   Is root cause fixable automatically? → fix + restore job from last clean gate
 *   Is root cause fixable with code change? → log for Claude Code, job holds
 *   Is root cause unfixable? → killJobCleanly()
 *     - mark job status:failed, failedGate, rootCause in DB
 *     - write full gate trail to errors.jsonl
 *     - release BullMQ locks
 *     - DO NOT delete produced outputs (they're recoverable)
 *     - determine restart gate based on state.savedOutputs
 *
 * Exports: { monitoringBus, escalate, determineRestartGate, killJobCleanly, registerJob, deregisterJob }
 */

const { EventEmitter } = require('events');
const { logError } = require('./error_logger');
const pipelineEventLogger = require('./pipeline_event_logger');
const { nrPipelineEvent } = require('./nr_pipeline');

// ─── New Relic event helper ───────────────────────────────────────────────────
// Delegates to nr_pipeline so canonicalJobId is always attached when jobId is present.
function nrEvent(eventType, attributes) {
  nrPipelineEvent(eventType, attributes || {});
}

// Import the pipeline bus (same singleton — same Node process)
let pipelineBus;
try {
  pipelineBus = require('./pipeline_events');
} catch (err) {
  // If pipeline_events not loaded yet, create a stub
  pipelineBus = new EventEmitter();
}

const whyLedger = require('./why_ledger');
const qaCycle = require('./qa_cycle');
const { QA_TIER_REVIEW, QA_TIER_OPS } = qaCycle;

function recordGateWhyFromBus(eventName, data) {
  if (!data || !data.jobId) return;
  const passed = eventName === 'gate:pass';
  const outcome = data.outcome || (passed ? 'pass' : eventName.replace(/^gate:/, ''));
  const reasons = (data.deductions || [])
    .map((d) => (typeof d === 'string' ? d : d.reason) || '')
    .filter(Boolean);
  if (data.reason && !reasons.includes(data.reason)) reasons.unshift(data.reason);
  whyLedger.recordWhyLedger({
    jobId: data.jobId,
    gate: data.gate != null ? String(data.gate) : null,
    kind: 'gate_outcome',
    passed,
    score: data.score ?? null,
    outcome,
    contentType: data.contentType,
    customerId: data.customerId,
    reasons: reasons.slice(0, 24),
    interventionType: whyLedger.INTERVENTION.NONE,
    interventionOutcome: outcome,
    evidenceDigest: {
      attempt: data.attempt,
      concerns: (data.concerns || []).slice(0, 8),
      fixDirectiveKeys: data.fixDirective ? Object.keys(data.fixDirective) : undefined,
    },
    contractDigest: {
      contentType: data.contentType,
      customerId: data.customerId,
    },
    source: `lib/monitoring:${eventName}`,
  });
}

// ─── Monitoring bus ───────────────────────────────────────────────────────────

const monitoringBus = new EventEmitter();
monitoringBus.setMaxListeners(20);

// ─── State tracking ───────────────────────────────────────────────────────────

// Track active jobs: jobId → { lastActivity, sendbackCount, escalated }
const activeJobs = new Map();

// Silence threshold: 10 minutes
const SILENCE_THRESHOLD_MS = 10 * 60 * 1000;

// Check for silent workers every 2 minutes
const SILENCE_CHECK_INTERVAL_MS = 2 * 60 * 1000;

let silenceChecker = null;

// ─── Gate event ordering ──────────────────────────────────────────────────────

// Which outputs to check when determining restart gate
// Earlier gates in this list = earlier restart point
const GATE_ORDER = ['gate0', 'gate1', 'gate2', 'gate3a', 'gate3b', 'gate4', 'gate5'];

// ─── Escalation logic ─────────────────────────────────────────────────────────

/**
 * Classify a root cause into an escalation category.
 * Returns 'auto_fix' | 'code_fix' | 'unfixable'
 */
function classifyRootCause(reason) {
  const r = (reason || '').toLowerCase();

  // Auto-fixable: transient API errors, network blips
  if (
    r.includes('timeout') ||
    r.includes('network') ||
    r.includes('econnreset') ||
    r.includes('enotfound')
  ) {
    return 'auto_fix';
  }

  // Code fix needed: logic errors, missing env vars, structural issues
  if (
    r.includes('api_key') ||
    r.includes('not set') ||
    r.includes('missing') ||
    r.includes('undefined')
  ) {
    return 'code_fix';
  }

  // Unfixable: content failures, fabrication, freeze, format mismatch
  if (
    r.includes('freeze') ||
    r.includes('fabrication') ||
    r.includes('format mismatch') ||
    r.includes('hard fail') ||
    r.includes('hard_fail') ||
    r.includes('unfilled')
  ) {
    return 'unfixable';
  }

  // Default: code fix (conservative)
  return 'code_fix';
}

/**
 * Escalate a job to monitoring.
 * Writes to errors.jsonl, emits 'escalation' on monitoringBus, applies recovery.
 *
 * @param {Object} params
 * @param {string} params.jobId
 * @param {string|number} params.gate - Gate identifier
 * @param {string} params.reason - Human-readable escalation reason
 * @param {Object[]} params.trail - Array of prior gate reports
 */
async function escalate({ jobId, gate, reason, trail = [] }) {
  if (!jobId) {
    logError('MONITORING_ESCALATE_NO_JOBID', new Error('escalate() called without jobId'), {
      gate,
      reason,
    });
    return;
  }

  const safeReason =
    reason == null || reason === '' ? 'No escalation reason provided' : String(reason);

  const jobState = activeJobs.get(jobId) || {};
  if (jobState.escalationExhausted) {
    return;
  }

  const isSilence = /\bsilent\b/i.test(safeReason);
  if (isSilence && jobState.silenceEscalationDone) {
    return;
  }

  let prevDb = 0;
  try {
    const { getJobSpec: getSpec } = require('./job_spec');
    const spec = getSpec(jobId);
    prevDb = spec?.state?.automation?.escalationAttempts || 0;
  } catch (_e) {
    /* non-fatal */
  }

  const prevMem = jobState.escalationAttempts || 0;
  const nextAttempts = Math.max(prevMem, prevDb) + 1;

  if (nextAttempts > 2) {
    activeJobs.set(jobId, {
      ...jobState,
      escalationAttempts: nextAttempts,
      escalationExhausted: true,
      silenceEscalationDone: isSilence || !!jobState.silenceEscalationDone,
      escalated: true,
      failedGate: gate,
    });
    try {
      const { persistEscalationAttempts } = require('./job_spec');
      persistEscalationAttempts(jobId, nextAttempts);
    } catch (_e) {
      /* non-fatal */
    }
    const capReason = `Escalation did not resolve after 2 attempts — terminating (round ${nextAttempts}): ${safeReason}`;
    logError('MONITORING_ESCALATION_CAP_KILL', new Error(capReason), { jobId, gate, nextAttempts });
    await killJobCleanly({ jobId, failedGate: gate, rootCause: capReason, trail });
    return;
  }

  activeJobs.set(jobId, {
    ...jobState,
    escalationAttempts: nextAttempts,
    escalated: true,
    escalatedAt: new Date().toISOString(),
    failedGate: gate,
    silenceEscalationDone: isSilence || !!jobState.silenceEscalationDone,
  });

  try {
    const { persistEscalationAttempts } = require('./job_spec');
    persistEscalationAttempts(jobId, nextAttempts);
  } catch (_e) {
    /* non-fatal */
  }

  const escalationEntry = {
    jobId,
    gate,
    reason: safeReason,
    trail: trail.map((r) => ({
      gate: r?.gate,
      passed: r?.passed,
      outcome: r?.outcome,
      score: r?.score,
      completedAt: r?.completedAt,
    })),
    escalatedAt: new Date().toISOString(),
  };

  logError('PIPELINE_ESCALATION', new Error(safeReason), { jobId, gate, escalationEntry });

  try {
    const existing = activeJobs.get(jobId) || {};
    whyLedger.recordWhyLedger({
      jobId,
      gate: String(gate),
      kind: 'pipeline_escalation',
      passed: false,
      score: null,
      outcome: 'escalate',
      contentType: existing.contentType,
      customerId: existing.customerId,
      failureClass: whyLedger.inferFailureClass({ reason: safeReason }),
      interventionType: whyLedger.INTERVENTION.ESCALATION,
      interventionOutcome: 'monitoring_escalate',
      reasons: [safeReason],
      evidenceDigest: { trailLen: (trail || []).length },
      source: 'lib/monitoring:escalate',
    });
  } catch (_e) {
    /* non-fatal */
  }

  // Emit escalation event
  monitoringBus.emit('escalation', escalationEntry);
  pipelineBus.emit('gate:escalate', { jobId, gate, reason: safeReason, trail });

  // Apply recovery decision tree
  const rootCauseType = classifyRootCause(safeReason);

  if (rootCauseType === 'auto_fix') {
    // Transient error — restore from last clean gate
    const restartGate = determineRestartGate({
      jobId,
      savedOutputs: trail.filter((r) => r?.passed).map((r) => `gate${r.gate}`),
    });
    logError('MONITORING_AUTO_RESTORE', new Error(`Auto-restoring ${jobId} from ${restartGate}`), {
      jobId,
      gate,
      restartGate,
    });
    pipelineBus.emit('job:restored', { jobId, fromGate: restartGate });
  } else if (rootCauseType === 'code_fix') {
    // Needs Claude Code — hold job
    logError(
      'MONITORING_CODE_FIX_NEEDED',
      new Error(`${jobId} requires code fix at gate ${gate}: ${safeReason}`),
      { jobId, gate, reason: safeReason }
    );
    monitoringBus.emit('code_fix_needed', { jobId, gate, reason: safeReason });
  } else {
    // Unfixable — kill cleanly
    await killJobCleanly({ jobId, failedGate: gate, rootCause: safeReason, trail });
  }
}

/**
 * Kill a job cleanly:
 *   - Mark job status:failed in DB (if db available)
 *   - Write full gate trail to errors.jsonl
 *   - Release BullMQ locks (via event)
 *   - DO NOT delete produced outputs
 *   - Determine and log restart gate
 *
 * @param {Object} params
 * @param {string} params.jobId
 * @param {string|number} params.failedGate
 * @param {string} params.rootCause
 * @param {Object[]} params.trail - Prior gate reports
 */
async function killJobCleanly({ jobId, failedGate, rootCause, trail = [] }) {
  const passedOutputs = trail.filter((r) => r?.passed).map((r) => String(r.gate));
  const restartGate = determineRestartGate({ jobId, savedOutputs: passedOutputs });

  const killRecord = {
    jobId,
    failedGate,
    rootCause,
    restartGate,
    killedAt: new Date().toISOString(),
    passedGates: passedOutputs,
    trail: trail.map((r) => ({
      gate: r?.gate,
      passed: r?.passed,
      outcome: r?.outcome || null,
      score: r?.score || null,
      completedAt: r?.completedAt || null,
    })),
  };

  logError(
    'JOB_KILLED_CLEANLY',
    new Error(`Job ${jobId} killed at gate ${failedGate}: ${rootCause}`),
    { jobId, killRecord }
  );

  try {
    whyLedger.recordWhyLedger({
      jobId,
      gate: String(failedGate),
      kind: 'job_kill',
      passed: false,
      outcome: 'killed',
      failureClass: whyLedger.inferFailureClass({ reason: rootCause }),
      interventionType: whyLedger.INTERVENTION.JOB_KILL,
      reasons: [rootCause],
      evidenceDigest: { restartGate, passedGates: passedOutputs },
      source: 'lib/monitoring:killJobCleanly',
    });
  } catch (_e) {
    /* non-fatal */
  }

  // Emit BullMQ lock release event
  pipelineBus.emit('job:killed', { jobId, failedGate, rootCause, restartGate });

  // Try to update DB status if available
  try {
    const db = require('./db');
    if (db && typeof db.updateJobStatus === 'function') {
      await db.updateJobStatus(jobId, {
        status: 'failed',
        failedGate,
        rootCause,
        restartGate,
        killedAt: killRecord.killedAt,
      });
    }
  } catch (err) {
    // DB not available or updateJobStatus not implemented — log and continue
    logError('MONITORING_DB_UPDATE_FAIL', err, { jobId, gate: failedGate });
  }

  monitoringBus.emit('job_killed', killRecord);

  try {
    const { requestAgentInterventionLastResort } = require('./job_spec');
    requestAgentInterventionLastResort(
      jobId,
      `unfixable_job_kill gate=${failedGate}: ${rootCause}`
    );
  } catch (_e) {
    /* non-fatal */
  }
}

/**
 * Determine which gate to restart from, based on what outputs are saved.
 * Returns the earliest gate that needs to be re-run.
 *
 * @param {Object} params
 * @param {string} params.jobId
 * @param {string[]} params.savedOutputs - List of gate names with saved outputs e.g. ['gate0', 'gate1']
 * @returns {string} Gate name to restart from
 */
function determineRestartGate({ jobId, savedOutputs = [] }) {
  const saved = new Set(savedOutputs.map((g) => String(g).toLowerCase().replace('gate', '')));

  // Walk gate order — find the first gate NOT in saved outputs
  for (const gateKey of GATE_ORDER) {
    const gateNum = gateKey.replace('gate', '');
    if (!saved.has(gateNum) && !saved.has(gateKey)) {
      return gateKey;
    }
  }

  // If all gates passed somehow — restart from gate0 (shouldn't happen)
  return 'gate0';
}

// ─── Pipeline event listeners ─────────────────────────────────────────────────

/**
 * Start listening to pipelineBus events and updating active job tracking.
 */
function startListening() {
  // Track activity on every gate event
  pipelineBus.on(
    'gate:pass',
    ({
      jobId,
      gate,
      score,
      outcome,
      contentType,
      customerId,
      durationMs,
      concerns,
      deductions,
    }) => {
      const existing = activeJobs.get(jobId) || {};
      if (jobId && jobId !== 'unknown') {
        try {
          qaCycle.resetGate(jobId, gate);
        } catch (_e) {
          /* non-fatal */
        }
      }
      activeJobs.set(jobId, {
        ...existing,
        lastActivity: Date.now(),
        lastGatePassed: gate,
      });
      // Semantic job (c0_*) continues on gates 2–5 while script_* id stops receiving gate:pass.
      // Refresh linked script job activity so silence checker does not false-escalate "silent at gate1".
      try {
        const { getJobSpec } = require('./job_spec');
        const spec = getJobSpec(jobId);
        const scriptJobId = spec && spec.scriptJobId;
        if (scriptJobId && scriptJobId !== jobId && activeJobs.has(scriptJobId)) {
          const ex = activeJobs.get(scriptJobId);
          activeJobs.set(scriptJobId, {
            ...ex,
            lastActivity: Date.now(),
            lastGatePassed: ex.lastGatePassed || 'gate1',
            semanticPipelineActive: true,
          });
        }
      } catch (_e) {
        /* non-fatal */
      }
      nrEvent('GateResult', {
        jobId,
        customerId: customerId || existing.customerId || 'unknown',
        contentType: contentType || existing.contentType || 'unknown',
        gate: String(gate),
        passed: 1,
        score: score ?? null,
        outcome: outcome || 'pass',
        durationMs: durationMs || null,
        concerns: Array.isArray(concerns) && concerns.length ? concerns.join('; ') : null,
        deductionCount: Array.isArray(deductions) ? deductions.length : 0,
      });
      recordGateWhyFromBus('gate:pass', {
        jobId,
        gate,
        score,
        outcome,
        contentType,
        customerId: customerId || existing.customerId,
        durationMs,
        concerns,
        deductions,
      });
    }
  );

  pipelineBus.on(
    'gate:hard_fail',
    ({ jobId, gate, reason, contentType, customerId, concerns, deductions }) => {
      const existing = activeJobs.get(jobId) || {};
      activeJobs.set(jobId, {
        ...existing,
        lastActivity: Date.now(),
        lastHardFail: { gate, reason },
      });
      const hardFailReason =
        reason ||
        (Array.isArray(deductions) && deductions.length
          ? deductions
              .map((d) => (typeof d === 'string' ? d : d.reason) || '')
              .filter(Boolean)
              .join('; ')
          : '') ||
        (Array.isArray(concerns) && concerns.length ? concerns.join('; ') : '') ||
        `Hard fail at gate ${gate}`;
      escalate({ jobId, gate, reason: hardFailReason, trail: [] }).catch((err) => {
        logError('MONITORING_ESCALATE_ERROR', err, { jobId, gate });
      });
      // NR: gate hard fail — track failure rate and reasons per gate
      nrEvent('GateResult', {
        jobId,
        customerId: customerId || existing.customerId || 'unknown',
        contentType: contentType || existing.contentType || 'unknown',
        gate: String(gate),
        passed: 0,
        outcome: 'hard_fail',
        reason: hardFailReason.slice(0, 200),
        concerns: Array.isArray(concerns) && concerns.length ? concerns.join('; ') : hardFailReason,
        deductionCount: Array.isArray(deductions) ? deductions.length : 0,
      });
      recordGateWhyFromBus('gate:hard_fail', {
        jobId,
        gate,
        score: null,
        outcome: 'hard_fail',
        contentType,
        customerId: customerId || existing.customerId,
        reason: hardFailReason,
        concerns,
        deductions,
      });
    }
  );

  // Tier 1 — QA review/report only. Tier 2 uses gate:ops_sendback (no qa_cycle / kill ladder).
  pipelineBus.on(
    'gate:sendback',
    ({ jobId, gate, attempt, fixDirective, contentType, customerId, qaTier }) => {
      if (qaTier === QA_TIER_OPS) {
        logError(
          'MONITORING_SENDBACK_TIER_MISMATCH',
          new Error('gate:sendback received qaTier ops — use gate:ops_sendback'),
          { jobId, gate }
        );
        return;
      }
      const existing = activeJobs.get(jobId) || {};
      const sendbackCount = (existing.sendbackCount || 0) + 1;
      const { worker, intervention, maxTotal } = qaCycle.limits();

      let cycle;
      try {
        cycle =
          jobId && jobId !== 'unknown'
            ? qaCycle.recordSendback(jobId, gate)
            : qaCycle.describeFromSendbackIndex(sendbackCount);
      } catch (e) {
        logError('QA_CYCLE_RECORD_ERROR', e, { jobId, gate });
        cycle = qaCycle.describeFromSendbackIndex(sendbackCount);
      }

      activeJobs.set(jobId, {
        ...existing,
        lastActivity: Date.now(),
        sendbackCount,
        lastQaPhase: cycle.phase,
        lastQaSendbacksAtGate: cycle.sendbacks,
      });

      // Self-heal window: worker sendbacks 1..N — gate code may auto-fix; no monitoring escalation.
      // Intervention phase: after worker cap — qa:phase / qa:intervention_required for agents.
      // Kill: after worker + intervention sendbacks exhausted (default 3+3=6 at same gate).
      if (cycle.shouldKill && jobId && jobId !== 'unknown') {
        killJobCleanly({
          jobId,
          failedGate: gate,
          rootCause: cycle.killReason || `QA cycle exhausted at gate ${gate}`,
          trail: [],
        }).catch((err) => {
          logError('MONITORING_QA_KILL_ERROR', err, { jobId, gate });
        });
      } else if (!cycle.shouldKill) {
        try {
          pipelineBus.emit('qa:phase', {
            jobId,
            gate,
            contentType: contentType || existing.contentType,
            customerId: customerId || existing.customerId,
            phase: cycle.phase,
            sendbacksAtGate: cycle.sendbacks,
            workerMax: worker,
            interventionMax: intervention,
            maxTotal,
            workerAttempt: cycle.workerAttempt,
            interventionAttempt: cycle.interventionAttempt,
            fixDirective,
          });
          if (cycle.phase === 'intervention' && cycle.interventionAttempt === 1) {
            pipelineBus.emit('qa:intervention_required', {
              jobId,
              gate,
              contentType: contentType || existing.contentType,
              customerId: customerId || existing.customerId,
              reason: `Worker sendback cap (${worker}) reached — QA intervention phase`,
              fixDirective,
            });
          }
        } catch (_e) {
          /* non-fatal */
        }
      }

      // NR: Tier 1 QA sendback
      nrEvent('GateSendback', {
        jobId,
        customerId: customerId || existing.customerId || 'unknown',
        contentType: contentType || existing.contentType || 'unknown',
        gate: String(gate),
        qaTier: QA_TIER_REVIEW,
        attempt: attempt || cycle.sendbacks,
        fixDirectiveFields: fixDirective
          ? Object.keys(fixDirective)
              .filter((k) => Array.isArray(fixDirective[k]) && fixDirective[k].length > 0)
              .join(',')
          : '',
      });
      recordGateWhyFromBus('gate:sendback', {
        jobId,
        gate,
        score: null,
        outcome: 'sendback',
        contentType,
        customerId: customerId || existing.customerId,
        attempt: attempt || cycle.sendbacks,
        fixDirective,
        reason: null,
        concerns: [],
        deductions: [],
      });
    }
  );

  // Tier 2 — operational / worker / internal (not formal QA review; does not advance qa_cycle)
  pipelineBus.on(
    'gate:ops_sendback',
    ({ jobId, gate, attempt, fixDirective, contentType, customerId, reason }) => {
      const existing = activeJobs.get(jobId) || {};
      activeJobs.set(jobId, {
        ...existing,
        lastActivity: Date.now(),
        lastOpsSendbackGate: gate,
      });
      nrEvent('GateOpsSendback', {
        jobId,
        customerId: customerId || existing.customerId || 'unknown',
        contentType: contentType || existing.contentType || 'unknown',
        gate: String(gate),
        qaTier: QA_TIER_OPS,
        attempt: attempt || null,
        fixDirectiveFields: fixDirective
          ? Object.keys(fixDirective)
              .filter((k) => Array.isArray(fixDirective[k]) && fixDirective[k].length > 0)
              .join(',')
          : '',
      });
      try {
        whyLedger.recordWhyLedger({
          jobId,
          gate: gate != null ? String(gate) : null,
          kind: 'gate_outcome',
          passed: false,
          score: null,
          outcome: 'ops_sendback',
          contentType: contentType || existing.contentType,
          customerId: customerId || existing.customerId,
          reasons: [reason || 'Operational sendback (Tier 2)'].slice(0, 24),
          interventionType: whyLedger.INTERVENTION.NONE,
          interventionOutcome: 'ops_sendback',
          evidenceDigest: {
            attempt,
            fixDirectiveKeys: fixDirective ? Object.keys(fixDirective) : undefined,
          },
          source: 'lib/monitoring:gate:ops_sendback',
        });
      } catch (_e) {
        /* non-fatal */
      }
    }
  );

  pipelineBus.on('job:restored', ({ jobId, fromGate }) => {
    try {
      const existing = activeJobs.get(jobId) || {};
      whyLedger.recordWhyLedger({
        jobId,
        gate: fromGate != null ? String(fromGate) : null,
        kind: 'job_restore',
        passed: false,
        outcome: 'restored',
        contentType: existing.contentType,
        customerId: existing.customerId,
        failureClass: whyLedger.FAILURE_CLASS.UNKNOWN,
        interventionType: whyLedger.INTERVENTION.JOB_RESTORE,
        reasons: [`Auto-restore from ${fromGate || 'unknown'}`],
        source: 'lib/monitoring:job:restored',
      });
    } catch (_e) {
      /* non-fatal */
    }
  });

  pipelineBus.on('gate:escalate', ({ jobId, gate, reason, trail }) => {
    // Already escalated via escalate() — just log receipt
    const r = reason == null || reason === '' ? 'No reason on gate:escalate' : String(reason);
    logError('MONITORING_RECEIVED_ESCALATION', new Error(r), { jobId, gate });
  });

  // Audit trail: log confirmed jobs + gate commitments before production starts
  pipelineBus.on(
    'job:confirmed',
    ({ jobId, contentType, templateId, jobSpec, commitments, allReady }) => {
      if (!jobId) return;

      // Register job in active tracking so silence checker can watch it
      let escalationAttempts = 0;
      try {
        const { getJobSpec: getSpec } = require('./job_spec');
        const spec = getSpec(jobId);
        escalationAttempts = spec?.state?.automation?.escalationAttempts || 0;
      } catch (_e) {
        /* non-fatal */
      }

      if (!activeJobs.has(jobId)) {
        activeJobs.set(jobId, {
          jobId,
          startedAt: new Date().toISOString(),
          lastActivity: Date.now(),
          sendbackCount: 0,
          escalated: false,
          escalationAttempts,
          silenceEscalationDone: false,
          escalationExhausted: false,
        });
      } else {
        // Job already registered — update activity timestamp
        const existing = activeJobs.get(jobId);
        activeJobs.set(jobId, {
          ...existing,
          lastActivity: Date.now(),
          escalationAttempts: Math.max(existing.escalationAttempts || 0, escalationAttempts),
        });
      }

      // Summarize commitment status for audit log
      const gateNames = Object.keys(commitments || {});
      const readyCount = gateNames.filter((g) => commitments[g]?.ready).length;
      const notReadyGates = gateNames.filter((g) => !commitments[g]?.ready);

      const auditSummary = {
        jobId,
        contentType,
        templateId,
        allReady,
        gatesReady: `${readyCount}/${gateNames.length}`,
        notReadyGates,
        confirmedAt: new Date().toISOString(),
      };

      if (allReady) {
        logError(
          'JOB_CONFIRMED_ALL_GATES_READY',
          new Error(`Job ${jobId} confirmed — all ${gateNames.length} gates signed off`),
          auditSummary
        );
      } else {
        logError(
          'JOB_CONFIRMED_WITH_WARNINGS',
          new Error(
            `Job ${jobId} confirmed with warnings — gates not ready: ${notReadyGates.join(', ')}`
          ),
          auditSummary
        );
      }

      // QA agents + orchestrators: same full job spec as pre-generate; workers may start prebuild prep.
      try {
        pipelineBus.emit('qa:agents_notified', {
          jobId,
          contentType,
          templateId,
          allReady: !!allReady,
          gatesReady: auditSummary.gatesReady,
          notReadyGates,
          commitments: commitments || {},
          jobSpecRef: jobId,
        });
      } catch (_e) {
        /* non-fatal */
      }

      // Notify all gate workers to prepare for this job
      // Non-blocking — runs after audit log, never lets gate errors crash monitoring
      const gates = ['gate0', 'gate1', 'gate2', 'gate3a', 'gate3b', 'gate4', 'gate5'];
      gates.forEach((gateName) => {
        try {
          const gateWorker = require(`./gates/${gateName}`);
          if (typeof gateWorker.prepare === 'function') {
            // Run prepare() non-blocking — never let it crash monitoring
            const specRef = jobSpec || { jobId };
            Promise.resolve(gateWorker.prepare(specRef))
              .then(() => {
                if (gateName !== 'gate3a' || !specRef.jobId || !specRef.designSpec) return;
                const ds = specRef.designSpec;
                const patch = {};
                if (ds.synthVerified !== undefined) patch.synthVerified = ds.synthVerified;
                if (ds.synthPreviewPath !== undefined) patch.synthPreviewPath = ds.synthPreviewPath;
                if (ds.synthVerifyHash !== undefined) patch.synthVerifyHash = ds.synthVerifyHash;
                if (ds.synthVerifyRequired !== undefined)
                  patch.synthVerifyRequired = ds.synthVerifyRequired;
                if (ds.synthVerifyError !== undefined) patch.synthVerifyError = ds.synthVerifyError;
                if (!Object.keys(patch).length) return;
                try {
                  const { updateJobSpec } = require('./job_spec');
                  updateJobSpec(specRef.jobId, { designSpec: patch });
                } catch (pe) {
                  console.warn(
                    `[monitoring] gate3a synth fields persist failed (${specRef.jobId}): ${pe.message}`
                  );
                }
              })
              .catch((e) => {
                console.warn(`[monitoring] ${gateName}.prepare() error: ${e.message}`);
              });
          }
        } catch (e) {
          console.warn(`[monitoring] Could not load ${gateName} for prepare(): ${e.message}`);
        }
      });
    }
  );

  // Start silence checker
  silenceChecker = setInterval(() => {
    const now = Date.now();
    for (const [jobId, state] of activeJobs.entries()) {
      if (state.silenceEscalationDone || state.escalationExhausted) continue;
      if (!state.lastActivity) continue;

      const silentMs = now - state.lastActivity;
      if (silentMs > SILENCE_THRESHOLD_MS) {
        const gate = state.lastGatePassed !== undefined ? state.lastGatePassed : 'unknown';
        // No gate:pass yet (e.g. long HeyGen before first gate event) — do not treat as dead worker
        if (state.lastGatePassed === undefined) continue;
        // Script job handed off to semantic pipeline — semantic gate:pass pulses lastActivity (see gate:pass handler)
        if (state.semanticPipelineActive) continue;
        const reason = `Gate worker silent for ${Math.round(silentMs / 60000)} minutes at gate ${gate}`;
        escalate({ jobId, gate, reason, trail: [] }).catch((err) => {
          logError('MONITORING_SILENCE_ESCALATE_ERROR', err, { jobId, gate });
        });
      }
    }
  }, SILENCE_CHECK_INTERVAL_MS);

  // Prevent interval from keeping process alive
  if (silenceChecker.unref) silenceChecker.unref();
}

/**
 * Register a new job in monitoring.
 * Call this when a job starts processing.
 *
 * @param {string} jobId
 */
function registerJob(jobId) {
  if (!jobId) return;
  activeJobs.set(jobId, {
    jobId,
    startedAt: new Date().toISOString(),
    lastActivity: Date.now(),
    sendbackCount: 0,
    escalated: false,
    escalationAttempts: 0,
    silenceEscalationDone: false,
    escalationExhausted: false,
  });
}

/**
 * Deregister a job from monitoring (completed successfully or killed).
 * @param {string} jobId
 */
function deregisterJob(jobId) {
  activeJobs.delete(jobId);
}

/**
 * Call when semantic job (c0_*) is linked to script_* so silence checker knows
 * downstream gates run under the semantic id (avoids false "silent at gate1" on script_*).
 */
function markScriptSemanticLinked(scriptJobId) {
  if (!scriptJobId) return;
  const ex = activeJobs.get(scriptJobId) || {};
  activeJobs.set(scriptJobId, {
    ...ex,
    semanticPipelineActive: true,
    lastActivity: Date.now(),
  });
}

// Auto-start listening when module is loaded
startListening();

// Wire Roo bridge — gives Roo Code full real-time visibility into all gate events
pipelineEventLogger.attachToBus(pipelineBus);

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  monitoringBus,
  escalate,
  determineRestartGate,
  killJobCleanly,
  registerJob,
  deregisterJob,
  markScriptSemanticLinked,
  startMonitoring: startListening,
};
