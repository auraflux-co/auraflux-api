'use strict';
/**
 * lib/pipeline_events.js
 *
 * Singleton EventEmitter for CWN pipeline stage transitions.
 * Both the HeyGen poller and server.js import the same instance
 * (same Node process = same object reference).
 *
 * **Emit wrapper:** every `emit(type, data)` shallow-clones `data`, attaches
 * `canonicalJobId` when `jobId` is present (via `lib/db.resolveCanonicalJobId`),
 * appends one JSON line to `logs/job_run_timeline.jsonl` (ordered run story), then
 * forwards to listeners. Callers keep using `pipelineBus.emit(...)`.
 *
 * Events emitted:
 *   heygen:all_complete  { jobId, contentType, segmentUrls[] }   — all HeyGen segments done
 *   portal2:complete       { jobId, contentType, score, outcome }   — Portal 2 QA finished
 *   portal2:fail           { jobId, score }                         — Portal 2 hard fail
 *   assembly:triggered   { jobId, assemblyId }                    — auto-assembly fired
 *   portal3:complete       { jobId, score, outcome }                — Portal 3 QA finished
 *
 * Portal worker system events (added 2026-04-18):
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
 *   job:spine_linked       { jobId, semanticJobId, scriptJobId, canonicalJobId } — semantic row linked to script_* canonical id
 *   pipeline:retry_attempt { jobId, gate, stage, attempt, maxAttempts } — uniform retry marker (e.g. Portal 1 script loop)
 *   publish:submit         { jobId, platforms, contentType, scheduled } — Upload-Post request about to fire
 *   publish:accepted       { jobId, request_id, job_id, platforms } — Upload-Post accepted
 *   publish:failed         { jobId, error, platforms } — Upload-Post HTTP or validation failure
 *   publish:failed_validation { jobId, code, message } — request rejected before Upload-Post call
 *   publish:poll_tick      { jobId, request_id, attempt, uploadPostStatus, ... } — async status poll
 *   publish:poll_terminal  { jobId, request_id, outcome } — poll done: completed | failed | timeout
 *   publish:platform_done { jobId, platform, request_id, outcome } — Portal 5 per-platform Upload-Post poll terminal
 *   publish:all_done       { jobId, anySuccess, allFailed, platforms } — Portal 5 finished all platform uploads
 *   heygen:poll_tick       { jobId, pollCount, completed, pending, failed, total } — inline HeyGen poller
 *   heygen:poll_terminal   { jobId, outcome } — timeout or all_segments_ready
 *   job:rollback           { jobId, before, after } — dashboard rollback
 *   job:advance            { jobId, before, after } — dashboard force-advance
 *
 * **Multi-process:** `pipelineBus.appendJobTimelineEvent(type, data)` writes the same jsonl row
 * (with canonical enrichment + sanitization) without emitting on the EventEmitter — use from
 * `bin/heygen-poller.js` when the DB path matches so `resolveCanonicalJobId` works.
 *
 * Env: `JOB_TIMELINE_MAX_BYTES` (default 52428800) — rotate `job_run_timeline.jsonl` when exceeded.
 *      `JOB_TIMELINE_STRING_MAX`, `JOB_TIMELINE_ARRAY_MAX` — sanitization caps for the timeline file only.
 *
 * Usage:
 *   const pipelineBus = require('./pipeline_events');
 *   pipelineBus.emit('heygen:all_complete', { jobId, contentType, segmentUrls });
 *   pipelineBus.on('heygen:all_complete', (data) => { ... });
 */

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const TIMELINE_LOG = path.join(__dirname, '..', 'logs', 'job_run_timeline.jsonl');

const TIMELINE_MAX_BYTES = Math.max(
  1024 * 1024,
  parseInt(process.env.JOB_TIMELINE_MAX_BYTES || String(50 * 1024 * 1024), 10) || 52428800
);
const TIMELINE_STRING_MAX = Math.max(
  500,
  parseInt(process.env.JOB_TIMELINE_STRING_MAX || '4000', 10) || 4000
);
const TIMELINE_ARRAY_MAX = Math.max(
  4,
  parseInt(process.env.JOB_TIMELINE_ARRAY_MAX || '16', 10) || 16
);

const pipelineBus = new EventEmitter();
pipelineBus.setMaxListeners(40); // headroom for multiple listeners per event

const _rawEmit = pipelineBus.emit.bind(pipelineBus);

function rotateTimelineIfNeeded() {
  try {
    if (!fs.existsSync(TIMELINE_LOG)) return;
    const st = fs.statSync(TIMELINE_LOG);
    if (st.size < TIMELINE_MAX_BYTES) return;
    const rotated = `${TIMELINE_LOG}.${Date.now()}.bak`;
    fs.renameSync(TIMELINE_LOG, rotated);
  } catch (_e) {
    /* non-fatal */
  }
}

/**
 * Shrink large payloads for the timeline file only (listeners still get full emit payload).
 */
function sanitizeForTimeline(val, depth = 0) {
  if (val == null) return val;
  if (depth > 8) return '[max-depth]';
  if (typeof val === 'string') {
    return val.length <= TIMELINE_STRING_MAX ? val : `${val.slice(0, TIMELINE_STRING_MAX)}…`;
  }
  if (typeof val === 'number' || typeof val === 'boolean') return val;
  if (Array.isArray(val)) {
    if (val.length > TIMELINE_ARRAY_MAX) {
      return {
        _truncated: true,
        _length: val.length,
        sample: val.slice(0, TIMELINE_ARRAY_MAX).map((x) => sanitizeForTimeline(x, depth + 1)),
      };
    }
    return val.map((x) => sanitizeForTimeline(x, depth + 1));
  }
  if (typeof val !== 'object') return String(val).slice(0, 200);
  const out = {};
  for (const k of Object.keys(val)) {
    if (k === 'segmentUrls' && Array.isArray(val[k])) {
      out.segmentUrls = { count: val[k].length, _omitted: true };
      continue;
    }
    if (k === 'segmentData' && Array.isArray(val[k]) && val[k].length > 4) {
      out.segmentData = { count: val[k].length, _omitted: true };
      continue;
    }
    if (k === 'card' && val[k] != null && typeof val[k] === 'object') {
      out.card = { _omitted: true };
      continue;
    }
    out[k] = sanitizeForTimeline(val[k], depth + 1);
  }
  return out;
}

/**
 * Append one enriched pipeline row — full run story (generate → publish).
 * Best-effort; never throws into callers.
 */
function appendJobRunTimeline(type, payload) {
  try {
    rotateTimelineIfNeeded();
    fs.mkdirSync(path.dirname(TIMELINE_LOG), { recursive: true });
    const extra =
      payload != null && typeof payload === 'object' && !Array.isArray(payload)
        ? sanitizeForTimeline(payload)
        : {};
    const row = { ts: new Date().toISOString(), type, ...extra };
    fs.appendFileSync(TIMELINE_LOG, JSON.stringify(row) + '\n');
  } catch (_e) {
    /* non-fatal */
  }
}

/**
 * Same timeline row as `emit`, but no in-process listeners (for Docker poller, etc.).
 */
function appendJobTimelineEvent(type, data) {
  let payload = data;
  if (data != null && typeof data === 'object' && !Array.isArray(data)) {
    payload = { ...data };
    if (payload.jobId && typeof payload.jobId === 'string') {
      try {
        const { resolveCanonicalJobIdSync } = require('./db');
        payload.canonicalJobId = resolveCanonicalJobIdSync(payload.jobId);
      } catch (_e) {
        payload.canonicalJobId = payload.jobId;
      }
    }
  }
  appendJobRunTimeline(type, payload);
}

pipelineBus.appendJobTimelineEvent = appendJobTimelineEvent;

pipelineBus.emit = function (type, data) {
  let payload = data;
  if (data != null && typeof data === 'object' && !Array.isArray(data)) {
    payload = { ...data };
    if (payload.jobId && typeof payload.jobId === 'string') {
      try {
        const { resolveCanonicalJobIdSync } = require('./db');
        payload.canonicalJobId = resolveCanonicalJobIdSync(payload.jobId);
      } catch (_e) {
        payload.canonicalJobId = payload.jobId;
      }
    }
  }
  appendJobRunTimeline(type, payload);
  return _rawEmit(type, payload);
};

module.exports = pipelineBus;
