'use strict';
/**
 * lib/monitoring.js — Pipeline Monitor + Escalation
 *
 * Listens to pipeline_events.js bus for escalation events.
 * Watches for:
 *   - Gate worker silent > 10 minutes
 *   - QA sendback loop (second fail)
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
 * Exports: { monitoringBus, escalate, determineRestartGate, killJobCleanly }
 */

const { EventEmitter } = require('events');
const { logError } = require('./error_logger');

// Import the pipeline bus (same singleton — same Node process)
let pipelineBus;
try {
  pipelineBus = require('./pipeline_events');
} catch (err) {
  // If pipeline_events not loaded yet, create a stub
  pipelineBus = new EventEmitter();
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
  if (r.includes('timeout') || r.includes('network') || r.includes('econnreset') || r.includes('enotfound')) {
    return 'auto_fix';
  }

  // Code fix needed: logic errors, missing env vars, structural issues
  if (r.includes('api_key') || r.includes('not set') || r.includes('missing') || r.includes('undefined')) {
    return 'code_fix';
  }

  // Unfixable: content failures, fabrication, freeze, format mismatch
  if (r.includes('freeze') || r.includes('fabrication') || r.includes('format mismatch') ||
      r.includes('hard fail') || r.includes('hard_fail') || r.includes('unfilled')) {
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
    logError('MONITORING_ESCALATE_NO_JOBID', new Error('escalate() called without jobId'), { gate, reason });
    return;
  }

  const jobState = activeJobs.get(jobId) || {};
  if (jobState.escalated) {
    // Already escalated — don't re-escalate
    return;
  }

  activeJobs.set(jobId, { ...jobState, escalated: true, escalatedAt: new Date().toISOString(), failedGate: gate });

  const escalationEntry = {
    jobId,
    gate,
    reason,
    trail: trail.map(r => ({
      gate: r?.gate,
      passed: r?.passed,
      outcome: r?.outcome,
      score: r?.score,
      completedAt: r?.completedAt
    })),
    escalatedAt: new Date().toISOString()
  };

  logError('PIPELINE_ESCALATION', new Error(reason), { jobId, gate, escalationEntry });

  // Emit escalation event
  monitoringBus.emit('escalation', escalationEntry);
  pipelineBus.emit('gate:escalate', { jobId, gate, reason, trail });

  // Apply recovery decision tree
  const rootCauseType = classifyRootCause(reason);

  if (rootCauseType === 'auto_fix') {
    // Transient error — restore from last clean gate
    const restartGate = determineRestartGate({ jobId, savedOutputs: trail.filter(r => r?.passed).map(r => `gate${r.gate}`) });
    logError('MONITORING_AUTO_RESTORE', new Error(`Auto-restoring ${jobId} from ${restartGate}`), { jobId, gate, restartGate });
    pipelineBus.emit('job:restored', { jobId, fromGate: restartGate });
  } else if (rootCauseType === 'code_fix') {
    // Needs Claude Code — hold job
    logError('MONITORING_CODE_FIX_NEEDED', new Error(`${jobId} requires code fix at gate ${gate}`), { jobId, gate, reason });
    monitoringBus.emit('code_fix_needed', { jobId, gate, reason });
  } else {
    // Unfixable — kill cleanly
    await killJobCleanly({ jobId, failedGate: gate, rootCause: reason, trail });
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
  const passedOutputs = trail.filter(r => r?.passed).map(r => String(r.gate));
  const restartGate = determineRestartGate({ jobId, savedOutputs: passedOutputs });

  const killRecord = {
    jobId,
    failedGate,
    rootCause,
    restartGate,
    killedAt: new Date().toISOString(),
    passedGates: passedOutputs,
    trail: trail.map(r => ({
      gate: r?.gate,
      passed: r?.passed,
      outcome: r?.outcome || null,
      score: r?.score || null,
      completedAt: r?.completedAt || null
    }))
  };

  logError('JOB_KILLED_CLEANLY', new Error(`Job ${jobId} killed at gate ${failedGate}: ${rootCause}`), { jobId, killRecord });

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
        killedAt: killRecord.killedAt
      });
    }
  } catch (err) {
    // DB not available or updateJobStatus not implemented — log and continue
    logError('MONITORING_DB_UPDATE_FAIL', err, { jobId, gate: failedGate });
  }

  monitoringBus.emit('job_killed', killRecord);
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
  const saved = new Set(savedOutputs.map(g => String(g).toLowerCase().replace('gate', '')));

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
  pipelineBus.on('gate:pass', ({ jobId, gate, score, outcome }) => {
    const existing = activeJobs.get(jobId) || {};
    activeJobs.set(jobId, {
      ...existing,
      lastActivity: Date.now(),
      lastGatePassed: gate
    });
  });

  pipelineBus.on('gate:hard_fail', ({ jobId, gate, reason }) => {
    const existing = activeJobs.get(jobId) || {};
    activeJobs.set(jobId, {
      ...existing,
      lastActivity: Date.now(),
      lastHardFail: { gate, reason }
    });
    escalate({ jobId, gate, reason, trail: [] }).catch(err => {
      logError('MONITORING_ESCALATE_ERROR', err, { jobId, gate });
    });
  });

  pipelineBus.on('gate:sendback', ({ jobId, gate, attempt, fixDirective }) => {
    const existing = activeJobs.get(jobId) || {};
    const sendbackCount = (existing.sendbackCount || 0) + 1;
    activeJobs.set(jobId, {
      ...existing,
      lastActivity: Date.now(),
      sendbackCount
    });

    // Second sendback = QA loop — escalate
    if (sendbackCount >= 2) {
      const reason = `QA sendback loop: ${sendbackCount} sendbacks at gate ${gate}`;
      escalate({ jobId, gate, reason, trail: [] }).catch(err => {
        logError('MONITORING_ESCALATE_ERROR', err, { jobId, gate });
      });
    }
  });

  pipelineBus.on('gate:escalate', ({ jobId, gate, reason, trail }) => {
    // Already escalated via escalate() — just log receipt
    logError('MONITORING_RECEIVED_ESCALATION', new Error(reason), { jobId, gate });
  });

  // Audit trail: log confirmed jobs + gate commitments before production starts
  pipelineBus.on('job:confirmed', ({ jobId, contentType, templateId, jobSpec, commitments, allReady }) => {
    if (!jobId) return;

    // Register job in active tracking so silence checker can watch it
    if (!activeJobs.has(jobId)) {
      activeJobs.set(jobId, {
        jobId,
        startedAt: new Date().toISOString(),
        lastActivity: Date.now(),
        sendbackCount: 0,
        escalated: false
      });
    } else {
      // Job already registered — update activity timestamp
      const existing = activeJobs.get(jobId);
      activeJobs.set(jobId, { ...existing, lastActivity: Date.now() });
    }

    // Summarize commitment status for audit log
    const gateNames = Object.keys(commitments || {});
    const readyCount = gateNames.filter(g => commitments[g]?.ready).length;
    const notReadyGates = gateNames.filter(g => !commitments[g]?.ready);

    const auditSummary = {
      jobId,
      contentType,
      templateId,
      allReady,
      gatesReady: `${readyCount}/${gateNames.length}`,
      notReadyGates,
      confirmedAt: new Date().toISOString()
    };

    if (allReady) {
      logError('JOB_CONFIRMED_ALL_GATES_READY', new Error(`Job ${jobId} confirmed — all ${gateNames.length} gates signed off`), auditSummary);
    } else {
      logError('JOB_CONFIRMED_WITH_WARNINGS', new Error(`Job ${jobId} confirmed with warnings — gates not ready: ${notReadyGates.join(', ')}`), auditSummary);
    }

    // Notify all gate workers to prepare for this job
    // Non-blocking — runs after audit log, never lets gate errors crash monitoring
    const gates = ['gate0', 'gate1', 'gate2', 'gate3a', 'gate3b', 'gate4', 'gate5'];
    gates.forEach(gateName => {
      try {
        const gateWorker = require(`./gates/${gateName}`);
        if (typeof gateWorker.prepare === 'function') {
          // Run prepare() non-blocking — never let it crash monitoring
          Promise.resolve(gateWorker.prepare(jobSpec || { jobId })).catch(e => {
            console.warn(`[monitoring] ${gateName}.prepare() error: ${e.message}`);
          });
        }
      } catch (e) {
        console.warn(`[monitoring] Could not load ${gateName} for prepare(): ${e.message}`);
      }
    });
  });

  // Start silence checker
  silenceChecker = setInterval(() => {
    const now = Date.now();
    for (const [jobId, state] of activeJobs.entries()) {
      if (state.escalated) continue; // Already escalated
      if (!state.lastActivity) continue;

      const silentMs = now - state.lastActivity;
      if (silentMs > SILENCE_THRESHOLD_MS) {
        const gate = state.lastGatePassed || 'unknown';
        const reason = `Gate worker silent for ${Math.round(silentMs / 60000)} minutes at gate ${gate}`;
        escalate({ jobId, gate, reason, trail: [] }).catch(err => {
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
    escalated: false
  });
}

/**
 * Deregister a job from monitoring (completed successfully or killed).
 * @param {string} jobId
 */
function deregisterJob(jobId) {
  activeJobs.delete(jobId);
}

// Auto-start listening when module is loaded
startListening();

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  monitoringBus,
  escalate,
  determineRestartGate,
  killJobCleanly,
  registerJob,
  deregisterJob,
  startMonitoring: startListening
};
