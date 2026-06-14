'use strict';

// ── New Relic custom event helpers ────────────────────────────────────────────
// All events are fire-and-forget — never block the pipeline.
// Queryable via NRQL on each custom event type name.
const { nrPipelineEvent } = require('./nr_pipeline');

function nrEvent(eventType, attributes) {
  nrPipelineEvent(eventType, attributes);
}

// Keep old helper for backwards compat
function nrGateAttribute(jobId, gate, score, passed) {
  nrEvent('GateResult', { jobId, gate, gateScore: score, gatePassed: passed });
}

function nrJobConfirmed(jobSpec, allReady) {
  nrEvent('JobConfirmed', {
    jobId: jobSpec.jobId,
    customerId: jobSpec.customerId,
    templateId: jobSpec.templateId,
    contentType: jobSpec.contentType,
    formFactor: jobSpec.order?.output?.formFactor,
    platforms: (jobSpec.deliverySpec?.platforms || []).join(','),
    allGatesReady: allReady,
    expectedClips: jobSpec.designSpec?.expectedClipCount ?? 0,
  });
}

function nrQaGenerateConfirmPolicy(jobSpec, attrs = {}) {
  nrEvent('QaGenerateConfirmPolicy', {
    jobId: jobSpec.jobId,
    customerId: jobSpec.customerId,
    templateId: jobSpec.templateId,
    contentType: jobSpec.contentType,
    ...attrs,
  });
}

function nrGateResult(jobId, customerId, contentType, gate, passed, score, outcome, durationMs) {
  nrEvent('GateResult', {
    jobId,
    customerId,
    contentType,
    gate: String(gate),
    passed: passed ? 1 : 0,
    score: score ?? null,
    outcome: outcome || null,
    durationMs: durationMs || null,
  });
}

function nrScriptSendback(jobId, customerId, contentType, score, attempt, reasons) {
  nrEvent('ScriptSendback', {
    jobId,
    customerId,
    contentType,
    score,
    attempt,
    reasons: Array.isArray(reasons) ? reasons.slice(0, 3).join('; ') : reasons || '',
  });
}

function nrVideoPublished(jobId, customerId, contentType, platform, title, pipelineMs, scores) {
  nrEvent('VideoPublished', {
    jobId,
    customerId,
    contentType,
    platform,
    title: (title || '').slice(0, 100),
    totalPipelineMs: pipelineMs || null,
    gate1Score: scores?.gate1 ?? null,
    gate3aScore: scores?.gate3a ?? null,
    gate4Score: scores?.gate4 ?? null,
  });
}

function nrAssemblyComplete(
  jobId,
  customerId,
  contentType,
  asmId,
  durationMs,
  fileSizeMB,
  gate3aScore
) {
  nrEvent('AssemblyComplete', {
    jobId,
    customerId,
    contentType,
    asmId,
    durationMs: durationMs || null,
    fileSizeMB: fileSizeMB || null,
    gate3aScore: gate3aScore ?? null,
  });
}

// ── Job lifecycle events ───────────────────────────────────────────────────────

function _jobAttrs(spec) {
  return {
    jobId:       spec.jobId,
    customerId:  spec.customerId,
    planTier:    spec.planTier   || 'operate',
    contentType: spec.contentType || null,
    sourceType:  spec.sourceType  || null,
    entry:       spec.entry       || null,
    platforms:   (spec.deliverySpec?.platforms || spec.platforms || []).join(',') || null,
    durationMins: spec.durationMins || null,
  };
}

function nrJobCreated(spec) {
  nrEvent('JobCreated', { ..._jobAttrs(spec), createdAt: Date.now() });
}

function nrJobComplete(spec, durationMs) {
  nrEvent('JobComplete', { ..._jobAttrs(spec), durationMs: durationMs || null });
}

function nrJobFailed(spec, failedPortal, reason) {
  nrEvent('JobFailed', {
    ..._jobAttrs(spec),
    failedPortal: failedPortal || null,
    reason:       (reason || '').slice(0, 200),
  });
}

function nrPortalStart(spec, portalKey) {
  nrEvent('PortalStart', { ..._jobAttrs(spec), portalKey });
}

function nrPortalPass(spec, portalKey, score) {
  nrEvent('PortalPass', { ..._jobAttrs(spec), portalKey, score: score ?? null });
}

function nrPortalFail(spec, portalKey, reason) {
  nrEvent('PortalFail', {
    ..._jobAttrs(spec),
    portalKey,
    reason: (reason || '').slice(0, 200),
  });
}

module.exports = {
  nrEvent,
  nrGateAttribute,
  nrJobConfirmed,
  nrQaGenerateConfirmPolicy,
  nrGateResult,
  nrScriptSendback,
  nrVideoPublished,
  nrAssemblyComplete,
  nrJobCreated,
  nrJobComplete,
  nrJobFailed,
  nrPortalStart,
  nrPortalPass,
  nrPortalFail,
};
