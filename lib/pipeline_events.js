'use strict';
/**
 * lib/pipeline_events.js
 *
 * Singleton EventEmitter for CWN pipeline stage transitions.
 * Both the HeyGen poller and server.js import the same instance
 * (same Node process = same object reference).
 *
 * Events emitted:
 *   heygen:all_complete  { jobId, contentType, segmentUrls[] }   — all HeyGen segments done
 *   gate2:complete       { jobId, contentType, score, outcome }   — Gate 2 QA finished
 *   gate2:fail           { jobId, score }                         — Gate 2 hard fail
 *   assembly:triggered   { jobId, assemblyId }                    — auto-assembly fired
 *   gate3:complete       { jobId, score, outcome }                — Gate 3 QA finished
 *
 * Gate worker system events (added 2026-04-18):
 *   gate:escalate        { jobId, gate, reason, trail }           — gate escalated to monitoring
 *   gate:sendback        { jobId, gate, qaTier:1, attempt, fixDirective } — Tier 1 QA review/report (qa_cycle)
 *   gate:ops_sendback    { jobId, gate, qaTier:2, attempt, fixDirective } — Tier 2 operational/worker (no qa_cycle)
 *   gate:pass            { jobId, gate, score, outcome }          — gate passed
 *   gate:hard_fail       { jobId, gate, reason }                  — gate hard fail
 *   why:ledger           { jobId, gate, kind, failureClass, ... } — RCA / intervention (NR + SQLite + this log)
 *   job:killed           { jobId, failedGate, rootCause, restartGate } — job killed cleanly
 *   job:restored         { jobId, fromGate }                      — job restored from gate
 *   automation:agent_escalation { jobId, reason }                  — last-resort AI/human triage (see job_spec)
 *   qa:agents_notified   { jobId, commitments, allReady, jobSpecRef } — after job:confirmed; QA uses full spec from DB
 *   qa:phase             { jobId, gate, phase, sendbacksAtGate, workerMax, interventionMax, ... }
 *   qa:intervention_required { jobId, gate, reason, fixDirective } — worker sendback cap reached; QA intervenes
 *   qa:generate_confirm_policy { jobId, policyEnabled, gateWorkersAllReady, monitorNote } — should QA ack generate (vs gate pre-gen sign-off)
 *
 * Usage:
 *   const pipelineBus = require('./pipeline_events');
 *   pipelineBus.emit('heygen:all_complete', { jobId, contentType, segmentUrls });
 *   pipelineBus.on('heygen:all_complete', (data) => { ... });
 */

const { EventEmitter } = require('events');

const pipelineBus = new EventEmitter();
pipelineBus.setMaxListeners(20); // headroom for multiple listeners per event

module.exports = pipelineBus;
