'use strict';
/**
 * lib/pipeline_event_logger.js — Pipeline Event Logger
 *
 * Subscribes to every pipelineBus event and writes structured records to
 * logs/pipeline_events.jsonl so operators and monitoring agents have
 * real-time visibility into all gate pass/fail/sendback/escalation events.
 *
 * Also maintains logs/pipeline_status.json — a compact live snapshot of all
 * active jobs, rewritten on each event.
 *
 * Called once from monitoring.js after startListening(). No other callers.
 *
 * Files written:
 *   logs/pipeline_events.jsonl  — append-only event log, one JSON line per event
 *   logs/pipeline_status.json   — live active job snapshot, rewritten on each event
 *   logs/pipeline_trigger.json  — latest job-started trigger (operators / integrations can poll)
 */

const fs = require('fs');
const path = require('path');

const EVENTS_LOG = path.join(__dirname, '../logs/pipeline_events.jsonl');
const STATUS_FILE = path.join(__dirname, '../logs/pipeline_status.json');
const TRIGGER_FILE = path.join(__dirname, '../logs/pipeline_trigger.json');

// In-memory active job state for pipeline_status.json
const activeJobs = new Map();

/** Prefer canonical id so semantic + script rows collapse to one card after link. */
function primaryJobKey(data) {
  if (!data || typeof data !== 'object') return null;
  return data.canonicalJobId || data.jobId || null;
}

function touchActiveJob(data, patch = {}) {
  const k = primaryJobKey(data);
  if (!k) return;
  const base = activeJobs.get(k) || {
    jobId: data.jobId,
    canonicalJobId: data.canonicalJobId || null,
    gateHistory: [],
    sendbackCount: 0,
  };
  const job = {
    ...base,
    ...patch,
    lastActivity: new Date().toISOString(),
  };
  if (data.jobId) job.jobId = data.jobId;
  if (data.canonicalJobId) job.canonicalJobId = data.canonicalJobId;
  activeJobs.set(k, job);
}

// ─── Append one event to pipeline_events.jsonl ───────────────────────────────

function logEvent(type, data) {
  const entry = JSON.stringify({ ts: new Date().toISOString(), type, ...data }) + '\n';
  try {
    fs.appendFileSync(EVENTS_LOG, entry);
  } catch (_e) {
    // Non-fatal — never let logger errors reach the pipeline
  }
  flushStatus();
}

// ─── Rewrite pipeline_status.json with current active job state ──────────────

function flushStatus() {
  try {
    fs.mkdirSync(path.dirname(STATUS_FILE), { recursive: true });
    fs.writeFileSync(
      STATUS_FILE,
      JSON.stringify(
        {
          updatedAt: new Date().toISOString(),
          activeJobs: Array.from(activeJobs.values()),
        },
        null,
        2
      )
    );
  } catch (_e) {
    /* non-fatal */
  }
}

// ─── Wire to pipelineBus ──────────────────────────────────────────────────────

function attachToBus(pipelineBus) {
  try {
    fs.mkdirSync(path.dirname(EVENTS_LOG), { recursive: true });
  } catch (_e) {
    /* non-fatal */
  }

  pipelineBus.on('job:confirmed', (data) => {
    const { jobId, contentType, templateId, allReady, canonicalJobId } = data;
    const k = primaryJobKey(data) || jobId;
    activeJobs.set(k, {
      jobId,
      canonicalJobId: canonicalJobId || null,
      contentType: contentType || 'unknown',
      templateId: templateId || null,
      startedAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      currentGate: 'gate0',
      gateHistory: [],
      sendbackCount: 0,
      status: 'running',
      allGatesReady: allReady || false,
    });
    logEvent('job:confirmed', {
      jobId,
      canonicalJobId: canonicalJobId || null,
      contentType,
      templateId,
      allReady,
    });
    // Write trigger file so integrations can detect new jobs
    try {
      fs.writeFileSync(
        TRIGGER_FILE,
        JSON.stringify(
          {
            jobId,
            canonicalJobId: canonicalJobId || null,
            contentType: contentType || 'unknown',
            templateId: templateId || null,
            firedAt: new Date().toISOString(),
            handled: false,
            handledAt: null,
          },
          null,
          2
        )
      );
    } catch (_e) {
      /* non-fatal */
    }
  });

  pipelineBus.on('job:spine_linked', (data) => {
    const { semanticJobId, scriptJobId, canonicalJobId, jobId } = data;
    const can = canonicalJobId || scriptJobId || primaryJobKey(data);
    const semKey = semanticJobId;
    const a = semKey ? activeJobs.get(semKey) : null;
    const b = can ? activeJobs.get(can) : null;
    const merged = {
      ...(a || {}),
      ...(b || {}),
      jobId: jobId || scriptJobId,
      semanticJobId: semanticJobId || null,
      scriptJobId: scriptJobId || null,
      canonicalJobId: can || null,
      lastActivity: new Date().toISOString(),
    };
    if (can) activeJobs.set(can, merged);
    if (semKey && semKey !== can) activeJobs.delete(semKey);
    logEvent('job:spine_linked', {
      jobId: jobId || scriptJobId,
      semanticJobId,
      scriptJobId,
      canonicalJobId: can || null,
    });
  });

  pipelineBus.on('heygen:all_complete', (data) => {
    touchActiveJob(data, {
      pipelineStage: 'segments_complete',
      segmentCount: Array.isArray(data.segmentUrls) ? data.segmentUrls.length : null,
    });
    logEvent('heygen:all_complete', {
      jobId: data.jobId,
      canonicalJobId: data.canonicalJobId || null,
      contentType: data.contentType,
      segmentCount: Array.isArray(data.segmentUrls) ? data.segmentUrls.length : 0,
    });
  });

  pipelineBus.on('assembly:triggered', (data) => {
    touchActiveJob(data, {
      pipelineStage: 'assembly_triggered',
      assemblyId: data.assemblyId || null,
    });
    logEvent('assembly:triggered', {
      jobId: data.jobId,
      canonicalJobId: data.canonicalJobId || null,
      assemblyId: data.assemblyId,
    });
  });

  pipelineBus.on('portal3:complete', (data) => {
    touchActiveJob(data, {
      pipelineStage: 'gate3_complete',
      gate3Score: data.score,
      gate3Outcome: data.outcome,
    });
    logEvent('portal3:complete', {
      jobId: data.jobId,
      canonicalJobId: data.canonicalJobId || null,
      score: data.score,
      outcome: data.outcome,
    });
  });

  pipelineBus.on('pipeline:complete', (data) => {
    touchActiveJob(data, {
      status: 'gates_complete',
      pipelineStage: 'pipeline_gates_through_5',
      completedAt: data.completedAt,
    });
    logEvent('pipeline:complete', {
      jobId: data.jobId,
      canonicalJobId: data.canonicalJobId || null,
      customerId: data.customerId,
      bar: data.bar,
    });
  });

  pipelineBus.on('pipeline:retry_attempt', (data) => {
    touchActiveJob(data, { lastRetryGate: data.gate, lastRetryAttempt: data.attempt });
    logEvent('pipeline:retry_attempt', {
      jobId: data.jobId,
      canonicalJobId: data.canonicalJobId || null,
      gate: data.gate,
      stage: data.stage,
      attempt: data.attempt,
      maxAttempts: data.maxAttempts,
    });
  });

  pipelineBus.on('publish:submit', (data) => {
    touchActiveJob(data, { pipelineStage: 'publish_submit' });
    logEvent('publish:submit', {
      jobId: data.jobId,
      canonicalJobId: data.canonicalJobId || null,
      platforms: data.platforms,
      contentType: data.contentType,
      scheduled: data.scheduled,
    });
  });

  pipelineBus.on('publish:accepted', (data) => {
    touchActiveJob(data, {
      pipelineStage: 'publish_accepted',
      publishRequestId: data.request_id,
      publishJobId: data.job_id,
    });
    logEvent('publish:accepted', {
      jobId: data.jobId,
      canonicalJobId: data.canonicalJobId || null,
      request_id: data.request_id,
      job_id: data.job_id,
      platforms: data.platforms,
    });
  });

  pipelineBus.on('publish:failed', (data) => {
    touchActiveJob(data, { status: 'publish_failed', pipelineStage: 'publish_failed' });
    logEvent('publish:failed', {
      jobId: data.jobId,
      canonicalJobId: data.canonicalJobId || null,
      error: (data.error || '').slice(0, 800),
      platforms: data.platforms,
    });
  });

  pipelineBus.on('publish:failed_validation', (data) => {
    touchActiveJob(data, { pipelineStage: 'publish_failed_validation' });
    logEvent('publish:failed_validation', {
      jobId: data.jobId,
      canonicalJobId: data.canonicalJobId || null,
      code: data.code || null,
      message: (data.message || '').slice(0, 500),
    });
  });

  pipelineBus.on('publish:poll_tick', (data) => {
    touchActiveJob(data, { pipelineStage: 'publish_polling' });
    logEvent('publish:poll_tick', {
      jobId: data.jobId,
      canonicalJobId: data.canonicalJobId || null,
      attempt: data.attempt,
      maxAttempts: data.maxAttempts,
      uploadPostStatus: data.uploadPostStatus != null ? data.uploadPostStatus : null,
      request_id: data.request_id || null,
      source: data.source || null,
      platform: data.platform || null,
      pollError: (data.pollError || '').slice(0, 300),
    });
  });

  pipelineBus.on('publish:poll_terminal', (data) => {
    touchActiveJob(data, { pipelineStage: 'publish_poll_terminal' });
    logEvent('publish:poll_terminal', {
      jobId: data.jobId,
      canonicalJobId: data.canonicalJobId || null,
      outcome: data.outcome,
      request_id: data.request_id || null,
      attempts: data.attempts,
      maxAttempts: data.maxAttempts,
      pollError: (data.pollError || '').slice(0, 300),
    });
  });

  pipelineBus.on('publish:platform_done', (data) => {
    touchActiveJob(data, { pipelineStage: 'publish_platform_done' });
    logEvent('publish:platform_done', {
      jobId: data.jobId,
      canonicalJobId: data.canonicalJobId || null,
      platform: data.platform,
      outcome: data.outcome,
      request_id: data.request_id || null,
      reason: (data.reason || '').slice(0, 300),
    });
  });

  pipelineBus.on('publish:all_done', (data) => {
    touchActiveJob(data, { pipelineStage: 'publish_all_done' });
    logEvent('publish:all_done', {
      jobId: data.jobId,
      canonicalJobId: data.canonicalJobId || null,
      anySuccess: data.anySuccess,
      allFailed: data.allFailed,
      platforms: data.platforms || null,
    });
  });

  pipelineBus.on('heygen:poll_tick', (data) => {
    touchActiveJob(data, { pipelineStage: 'segments_polling' });
    logEvent('heygen:poll_tick', {
      jobId: data.jobId,
      canonicalJobId: data.canonicalJobId || null,
      attempt: data.attempt,
      allComplete: !!data.allComplete,
      pending: data.pending,
      failed: data.failed,
      total: data.total,
    });
  });

  pipelineBus.on('heygen:poll_terminal', (data) => {
    touchActiveJob(data, { pipelineStage: 'segments_poll_terminal' });
    logEvent('heygen:poll_terminal', {
      jobId: data.jobId,
      canonicalJobId: data.canonicalJobId || null,
      outcome: data.outcome,
      reason: (data.reason || '').slice(0, 300),
    });
  });

  pipelineBus.on('job:rollback', (data) => {
    touchActiveJob(data, { pipelineStage: 'job_rollback' });
    logEvent('job:rollback', {
      jobId: data.jobId,
      canonicalJobId: data.canonicalJobId || null,
      before: data.before,
      after: data.after,
      message: (data.message || '').slice(0, 500),
    });
  });

  pipelineBus.on('job:advance', (data) => {
    touchActiveJob(data, { pipelineStage: 'job_advance' });
    logEvent('job:advance', {
      jobId: data.jobId,
      canonicalJobId: data.canonicalJobId || null,
      from: data.from,
      to: data.to,
      message: (data.message || '').slice(0, 500),
    });
  });

  pipelineBus.on('portal:pass', (data) => {
    const {
      jobId,
      gate,
      score,
      outcome,
      contentType,
      durationMs,
      concerns,
      deductions,
      canonicalJobId,
    } = data;
    const k = primaryJobKey(data) || jobId;
    const job = activeJobs.get(k) || {
      jobId,
      canonicalJobId: canonicalJobId || null,
      gateHistory: [],
      sendbackCount: 0,
    };
    job.lastActivity = new Date().toISOString();
    job.currentGate = gate;
    job.status = 'running';
    job.gateHistory = [
      ...(job.gateHistory || []),
      { gate, result: 'pass', score, outcome, ts: new Date().toISOString() },
    ];
    if (canonicalJobId) job.canonicalJobId = canonicalJobId;
    activeJobs.set(k, job);
    logEvent('portal:pass', {
      jobId,
      canonicalJobId: canonicalJobId || null,
      gate,
      score,
      outcome,
      contentType,
      durationMs,
      concerns: concerns || [],
      deductions: deductions || [],
    });
  });

  pipelineBus.on('qa:generate_confirm_policy', (data) => {
    const {
      jobId,
      contentType,
      templateId,
      policyEnabled,
      gateWorkersAllReady,
      monitorNote,
      canonicalJobId,
    } = data;
    logEvent('qa:generate_confirm_policy', {
      jobId,
      canonicalJobId: canonicalJobId || null,
      contentType,
      templateId,
      policyEnabled: !!policyEnabled,
      gateWorkersAllReady: !!gateWorkersAllReady,
      monitorNote: (monitorNote || '').slice(0, 500),
    });
  });

  pipelineBus.on('qa:agents_notified', (data) => {
    const { jobId, contentType, templateId, allReady, gatesReady, canonicalJobId } = data;
    const k = primaryJobKey(data) || jobId;
    const job = activeJobs.get(k) || {
      jobId,
      canonicalJobId: canonicalJobId || null,
      gateHistory: [],
      sendbackCount: 0,
    };
    job.lastActivity = new Date().toISOString();
    job.qaNotified = true;
    if (canonicalJobId) job.canonicalJobId = canonicalJobId;
    activeJobs.set(k, job);
    logEvent('qa:agents_notified', {
      jobId,
      canonicalJobId: canonicalJobId || null,
      contentType,
      templateId,
      allReady,
      gatesReady,
    });
  });

  pipelineBus.on('qa:phase', (data) => {
    const { jobId, gate, phase, sendbacksAtGate, workerMax, interventionMax, canonicalJobId } =
      data;
    logEvent('qa:phase', {
      jobId,
      canonicalJobId: canonicalJobId || null,
      gate,
      phase,
      sendbacksAtGate,
      workerMax,
      interventionMax,
    });
  });

  pipelineBus.on('qa:intervention_required', (data) => {
    const { jobId, gate, reason, canonicalJobId } = data;
    logEvent('qa:intervention_required', {
      jobId,
      canonicalJobId: canonicalJobId || null,
      gate,
      reason: (reason || '').slice(0, 500),
    });
  });

  pipelineBus.on('portal:sendback', (data) => {
    const { jobId, gate, attempt, fixDirective, contentType, canonicalJobId } = data;
    const k = primaryJobKey(data) || jobId;
    const job = activeJobs.get(k) || {
      jobId,
      canonicalJobId: canonicalJobId || null,
      gateHistory: [],
      sendbackCount: 0,
    };
    job.lastActivity = new Date().toISOString();
    job.sendbackCount = (job.sendbackCount || 0) + 1;
    job.status = 'sendback';
    job.qaTier = 1;
    job.gateHistory = [
      ...(job.gateHistory || []),
      { gate, result: 'sendback', qaTier: 1, attempt, ts: new Date().toISOString() },
    ];
    if (canonicalJobId) job.canonicalJobId = canonicalJobId;
    activeJobs.set(k, job);
    logEvent('portal:sendback', {
      jobId,
      canonicalJobId: canonicalJobId || null,
      gate,
      attempt,
      contentType,
      qaTier: 1,
      fixDirectiveKeys: fixDirective ? Object.keys(fixDirective) : [],
    });
  });

  pipelineBus.on('portal:ops_sendback', (data) => {
    const { jobId, gate, attempt, fixDirective, contentType, canonicalJobId } = data;
    const k = primaryJobKey(data) || jobId;
    const job = activeJobs.get(k) || {
      jobId,
      canonicalJobId: canonicalJobId || null,
      gateHistory: [],
      sendbackCount: 0,
    };
    job.lastActivity = new Date().toISOString();
    job.opsSendbackCount = (job.opsSendbackCount || 0) + 1;
    job.status = 'ops_sendback';
    job.qaTier = 2;
    job.gateHistory = [
      ...(job.gateHistory || []),
      { gate, result: 'ops_sendback', qaTier: 2, attempt, ts: new Date().toISOString() },
    ];
    if (canonicalJobId) job.canonicalJobId = canonicalJobId;
    activeJobs.set(k, job);
    logEvent('portal:ops_sendback', {
      jobId,
      canonicalJobId: canonicalJobId || null,
      gate,
      attempt,
      contentType,
      qaTier: 2,
      fixDirectiveKeys: fixDirective ? Object.keys(fixDirective) : [],
    });
  });

  pipelineBus.on('portal:hard_fail', (data) => {
    const { jobId, gate, reason, contentType, concerns, deductions, canonicalJobId } = data;
    const k = primaryJobKey(data) || jobId;
    const job = activeJobs.get(k) || {
      jobId,
      canonicalJobId: canonicalJobId || null,
      gateHistory: [],
      sendbackCount: 0,
    };
    job.lastActivity = new Date().toISOString();
    job.status = 'hard_fail';
    job.failedGate = gate;
    job.failReason = reason;
    job.gateHistory = [
      ...(job.gateHistory || []),
      { gate, result: 'hard_fail', reason, ts: new Date().toISOString() },
    ];
    if (canonicalJobId) job.canonicalJobId = canonicalJobId;
    activeJobs.set(k, job);
    logEvent('portal:hard_fail', {
      jobId,
      canonicalJobId: canonicalJobId || null,
      gate,
      reason,
      contentType,
      concerns: concerns || [],
      deductions: deductions || [],
    });
  });

  pipelineBus.on('portal:escalate', (data) => {
    const { jobId, gate, reason, trail, canonicalJobId } = data;
    const k = primaryJobKey(data) || jobId;
    const job = activeJobs.get(k) || {
      jobId,
      canonicalJobId: canonicalJobId || null,
      gateHistory: [],
      sendbackCount: 0,
    };
    job.lastActivity = new Date().toISOString();
    job.status = 'escalated';
    job.escalatedGate = gate;
    if (canonicalJobId) job.canonicalJobId = canonicalJobId;
    activeJobs.set(k, job);
    logEvent('portal:escalate', {
      jobId,
      canonicalJobId: canonicalJobId || null,
      gate,
      reason,
      trailLength: Array.isArray(trail) ? trail.length : 0,
    });
  });

  pipelineBus.on('automation:agent_escalation', (data) => {
    const { jobId, reason, canonicalJobId } = data;
    const k = primaryJobKey(data) || jobId;
    const job = activeJobs.get(k) || {
      jobId,
      canonicalJobId: canonicalJobId || null,
      gateHistory: [],
      sendbackCount: 0,
    };
    job.lastActivity = new Date().toISOString();
    job.status = 'agent_escalation';
    job.agentEscalationReason = reason;
    if (canonicalJobId) job.canonicalJobId = canonicalJobId;
    activeJobs.set(k, job);
    logEvent('automation:agent_escalation', {
      jobId,
      canonicalJobId: canonicalJobId || null,
      reason: (reason || '').slice(0, 500),
    });
  });

  pipelineBus.on('job:killed', (data) => {
    const { jobId, failedGate, rootCause, restartGate, canonicalJobId } = data;
    const k = primaryJobKey(data) || jobId;
    const job = activeJobs.get(k) || { jobId, canonicalJobId: canonicalJobId || null };
    job.status = 'killed';
    job.failedGate = failedGate;
    job.rootCause = rootCause;
    job.restartGate = restartGate;
    job.killedAt = new Date().toISOString();
    if (canonicalJobId) job.canonicalJobId = canonicalJobId;
    activeJobs.set(k, job);
    logEvent('job:killed', {
      jobId,
      canonicalJobId: canonicalJobId || null,
      failedGate,
      rootCause,
      restartGate,
    });
    setTimeout(
      () => {
        activeJobs.delete(k);
        flushStatus();
      },
      60 * 60 * 1000
    );
  });

  pipelineBus.on('job:restored', (data) => {
    const { jobId, fromGate, canonicalJobId } = data;
    const k = primaryJobKey(data) || jobId;
    const job = activeJobs.get(k) || {
      jobId,
      canonicalJobId: canonicalJobId || null,
      gateHistory: [],
    };
    job.status = 'restored';
    job.restoredFrom = fromGate;
    job.lastActivity = new Date().toISOString();
    if (canonicalJobId) job.canonicalJobId = canonicalJobId;
    activeJobs.set(k, job);
    logEvent('job:restored', { jobId, canonicalJobId: canonicalJobId || null, fromGate });
  });

  pipelineBus.on('why:ledger', (payload) => {
    if (!payload || typeof payload !== 'object') return;
    const { type, ts, ...rest } = payload;
    logEvent('why:ledger', rest);
  });

  flushStatus();
}

module.exports = { attachToBus };
