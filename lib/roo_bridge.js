'use strict';
/**
 * lib/roo_bridge.js — Pipeline Event Bridge for Roo Code
 *
 * Writes every pipelineBus event to logs/pipeline_events.jsonl so Roo Code
 * gate owner modes and the Pipeline Orchestrator have real-time visibility
 * into all gate pass/fail/sendback/escalation events.
 *
 * Also maintains logs/roo_status.json — a compact snapshot of all active jobs
 * that Roo can read at a glance without querying SQLite.
 *
 * Called once from monitoring.js after startListening(). No other callers.
 *
 * Files written:
 *   logs/pipeline_events.jsonl  — append-only event log, one JSON per line
 *   logs/roo_status.json        — live active job snapshot, rewritten on each event
 */

const fs = require('fs');
const path = require('path');

const EVENTS_LOG = path.join(__dirname, '../logs/pipeline_events.jsonl');
const STATUS_FILE = path.join(__dirname, '../logs/roo_status.json');
const TRIGGER_FILE = path.join(__dirname, '../logs/roo_trigger.json');

// In-memory active job state for roo_status.json
const activeJobs = new Map();

// ─── Append one event to pipeline_events.jsonl ───────────────────────────────

function logEvent(type, data) {
  const entry = JSON.stringify({ ts: new Date().toISOString(), type, ...data }) + '\n';
  try {
    fs.appendFileSync(EVENTS_LOG, entry);
  } catch (e) {
    // Non-fatal — never let bridge errors reach the pipeline
  }
  flushStatus();
}

// ─── Rewrite roo_status.json with current active job state ───────────────────

function flushStatus() {
  try {
    const snapshot = {
      updatedAt: new Date().toISOString(),
      activeJobs: Array.from(activeJobs.values())
    };
    fs.writeFileSync(STATUS_FILE, JSON.stringify(snapshot, null, 2));
  } catch (e) { /* non-fatal */ }
}

// ─── Wire to pipelineBus ──────────────────────────────────────────────────────

function attachToBus(pipelineBus) {

  pipelineBus.on('job:confirmed', ({ jobId, contentType, templateId, allReady, commitments }) => {
    activeJobs.set(jobId, {
      jobId,
      contentType: contentType || 'unknown',
      templateId: templateId || null,
      startedAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      currentGate: 'gate0',
      gateHistory: [],
      sendbackCount: 0,
      status: 'running',
      allGatesReady: allReady || false
    });
    logEvent('job:confirmed', { jobId, contentType, templateId, allReady });
    // Write trigger file so Roo knows a new job started — Roo marks handled:true when it picks it up
    try {
      fs.writeFileSync(TRIGGER_FILE, JSON.stringify({
        jobId,
        contentType: contentType || 'unknown',
        templateId: templateId || null,
        firedAt: new Date().toISOString(),
        handled: false,
        handledAt: null
      }, null, 2));
    } catch (e) { /* non-fatal */ }
  });

  pipelineBus.on('gate:pass', ({ jobId, gate, score, outcome, contentType, durationMs, concerns, deductions }) => {
    const job = activeJobs.get(jobId) || { jobId, gateHistory: [], sendbackCount: 0 };
    job.lastActivity = new Date().toISOString();
    job.currentGate = gate;
    job.status = 'running';
    job.gateHistory = [...(job.gateHistory || []), { gate, result: 'pass', score, outcome, ts: new Date().toISOString() }];
    activeJobs.set(jobId, job);
    logEvent('gate:pass', { jobId, gate, score, outcome, contentType, durationMs,
      concerns: concerns || [], deductions: deductions || [] });
  });

  pipelineBus.on('gate:sendback', ({ jobId, gate, attempt, fixDirective, contentType }) => {
    const job = activeJobs.get(jobId) || { jobId, gateHistory: [], sendbackCount: 0 };
    job.lastActivity = new Date().toISOString();
    job.sendbackCount = (job.sendbackCount || 0) + 1;
    job.status = 'sendback';
    job.gateHistory = [...(job.gateHistory || []), { gate, result: 'sendback', attempt, ts: new Date().toISOString() }];
    activeJobs.set(jobId, job);
    logEvent('gate:sendback', { jobId, gate, attempt, contentType,
      fixDirectiveKeys: fixDirective ? Object.keys(fixDirective) : [] });
  });

  pipelineBus.on('gate:hard_fail', ({ jobId, gate, reason, contentType, concerns, deductions }) => {
    const job = activeJobs.get(jobId) || { jobId, gateHistory: [], sendbackCount: 0 };
    job.lastActivity = new Date().toISOString();
    job.status = 'hard_fail';
    job.failedGate = gate;
    job.failReason = reason;
    job.gateHistory = [...(job.gateHistory || []), { gate, result: 'hard_fail', reason, ts: new Date().toISOString() }];
    activeJobs.set(jobId, job);
    logEvent('gate:hard_fail', { jobId, gate, reason, contentType,
      concerns: concerns || [], deductions: deductions || [] });
  });

  pipelineBus.on('gate:escalate', ({ jobId, gate, reason, trail }) => {
    const job = activeJobs.get(jobId) || { jobId, gateHistory: [], sendbackCount: 0 };
    job.lastActivity = new Date().toISOString();
    job.status = 'escalated';
    job.escalatedGate = gate;
    activeJobs.set(jobId, job);
    logEvent('gate:escalate', { jobId, gate, reason,
      trailLength: Array.isArray(trail) ? trail.length : 0 });
  });

  pipelineBus.on('job:killed', ({ jobId, failedGate, rootCause, restartGate }) => {
    const job = activeJobs.get(jobId) || { jobId };
    job.status = 'killed';
    job.failedGate = failedGate;
    job.rootCause = rootCause;
    job.restartGate = restartGate;
    job.killedAt = new Date().toISOString();
    activeJobs.set(jobId, job);
    logEvent('job:killed', { jobId, failedGate, rootCause, restartGate });
    // Keep killed jobs in status for 1 hour then prune
    setTimeout(() => { activeJobs.delete(jobId); flushStatus(); }, 60 * 60 * 1000);
  });

  pipelineBus.on('job:restored', ({ jobId, fromGate }) => {
    const job = activeJobs.get(jobId) || { jobId, gateHistory: [] };
    job.status = 'restored';
    job.restoredFrom = fromGate;
    job.lastActivity = new Date().toISOString();
    activeJobs.set(jobId, job);
    logEvent('job:restored', { jobId, fromGate });
  });

  pipelineBus.on('why:ledger', (payload) => {
    if (!payload || typeof payload !== 'object') return;
    const { type, ts, ...rest } = payload;
    logEvent('why:ledger', rest);
  });

  // Write an initial status file immediately so Roo has something to read
  flushStatus();
}

module.exports = { attachToBus };
