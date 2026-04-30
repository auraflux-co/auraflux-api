'use strict';

const { getJobSpec, updateJobSpec } = require('./job_spec');

const PORTAL_ORDER = ['gate0', 'gate1', 'gate2', 'gate3a', 'gate3b', 'gate4', 'gate5'];
const PORTAL_PREREQS = {
  gate0: [],
  gate1: ['gate0'],
  gate2: ['gate1'],
  gate3a: ['gate2'],
  gate3b: ['gate3a'],
  gate4: ['gate3b'],
  gate5: ['gate4'],
};

function cloneSafe(obj) {
  return JSON.parse(JSON.stringify(obj || null));
}

function portalSummaryFromCommitment(commitment) {
  if (!commitment) return null;
  return commitment.summary || commitment.committed || null;
}

function buildGateContracts(jobSpec, commitments = {}) {
  const items = jobSpec?.order?.inputs?.items || [];
  const expectedClipCount =
    jobSpec?.designSpec?.sceneStructure?.expectedClipCount ??
    jobSpec?.designSpec?.expectedClipCount ??
    0;
  const templateId = jobSpec?.templateId || null;
  const contentType = jobSpec?.contentType || null;
  const chromeSkin = jobSpec?.designSpec?.chrome?.skin || null;
  const qaThresholds = jobSpec?.designSpec?.qaThresholds || {};

  const gates = {};
  for (const gate of PORTAL_ORDER) {
    gates[gate] = {
      gate,
      workerFocus: {
        gate0: 'confirm ordered source inputs and clip readiness',
        gate1: 'validate script style/accuracy against committed order',
        gate2: 'validate render segment technical quality',
        gate3a: 'qualitative assembly QA against chrome/story presentation',
        gate3b: 'quantitative visual checklist QA',
        gate4: 'final quality acceptance before delivery',
        gate5: 'delivery readiness and completion gate',
      }[gate],
      prerequisites: PORTAL_PREREQS[gate] || [],
      expectedFromOrder: {
        templateId,
        contentType,
        itemCount: items.length,
        expectedClipCount,
        chromeSkin,
        threshold: qaThresholds?.[gate] || null,
      },
      commitSummary: portalSummaryFromCommitment(commitments?.[gate]?.commitment),
      signedOffReady: commitments?.[gate]?.ready !== false,
    };
  }
  return gates;
}

function baselineFromJobSpec(jobSpec) {
  return {
    capturedAt: new Date().toISOString(),
    jobId: jobSpec?.jobId || null,
    customerId: jobSpec?.customerId || null,
    templateId: jobSpec?.templateId || null,
    contentType: jobSpec?.contentType || null,
    ordered: {
      sourceType: jobSpec?.order?.inputs?.sourceType || null,
      itemCount: (jobSpec?.order?.inputs?.items || []).length,
      expectedClipCount:
        jobSpec?.designSpec?.sceneStructure?.expectedClipCount ??
        jobSpec?.designSpec?.expectedClipCount ??
        0,
      platforms: jobSpec?.deliverySpec?.platforms || [],
      aspectRatio: jobSpec?.order?.output?.aspectRatio || null,
      resolution: jobSpec?.order?.output?.resolution || null,
      chromeSkin: jobSpec?.designSpec?.chrome?.skin || null,
    },
  };
}

function persistJobSpecGateContracts(jobSpec, commitments = {}) {
  if (!jobSpec?.jobId) return null;
  const patch = {
    state: {
      gateContracts: {
        version: 1,
        baseline: baselineFromJobSpec(jobSpec),
        gates: buildGateContracts(jobSpec, commitments),
        qaByGate: {},
        cumulative: {
          status: 'pending',
          lastGate: null,
          issues: [],
          softHeals: [],
          updatedAt: null,
        },
      },
    },
  };
  return updateJobSpec(jobSpec.jobId, patch);
}

function gatePassedish(result) {
  if (!result) return false;
  if (result.passed === true) return true;
  return (
    result.outcome === 'pass' ||
    result.outcome === 'pass_with_notes' ||
    result.outcome === 'proceed'
  );
}

function softHealJobSpec(currentSpec, gate) {
  const heals = [];
  const patch = { order: { inputs: {} }, state: { gateContracts: {} } };

  const inputs = currentSpec?.order?.inputs || {};
  const sceneItems = currentSpec?.designSpec?.sceneStructure?.items || [];

  if (
    (!Array.isArray(inputs.items) || inputs.items.length === 0) &&
    Array.isArray(sceneItems) &&
    sceneItems.length > 0
  ) {
    const hydrated = sceneItems
      .map((it, idx) => (it?.data ? { id: String(idx), ...it.data } : null))
      .filter(Boolean);
    if (hydrated.length > 0) {
      patch.order.inputs.items = hydrated;
      patch.order.inputs.itemCount = hydrated.length;
      heals.push(
        `hydrated order.inputs.items from designSpec.sceneStructure.items (${hydrated.length})`
      );
    }
  }

  if (heals.length === 0) return { heals, patch: null };
  // Prevent deepMerge from wiping unrelated fields
  return { heals, patch };
}

function auditIssuesForGate(spec, gate, result) {
  const issues = [];
  const prereqs = PORTAL_PREREQS[gate] || [];
  const gateResults = spec?.state?.gateResults || {};

  for (const prereq of prereqs) {
    if (!gatePassedish(gateResults[prereq])) {
      issues.push(`prerequisite ${prereq} is not passed before ${gate}`);
    }
  }

  if (!result || typeof result !== 'object') {
    issues.push(`missing ${gate} result payload`);
    return issues;
  }
  if (!('outcome' in result) && !('passed' in result)) {
    issues.push(`${gate} result missing outcome/passed marker`);
  }

  if (gate === 'gate4' || gate === 'gate5') {
    const assembled =
      spec?.state?.savedOutputs?.assembledPath || spec?.assembledPath || spec?.outputPath;
    if (!assembled) issues.push('assembled output path missing before final delivery gates');
  }
  if (gate === 'gate5') {
    const baselinePlatforms = spec?.state?.gateContracts?.baseline?.ordered?.platforms || [];
    const nowPlatforms = spec?.deliverySpec?.platforms || [];
    if (baselinePlatforms.length > 0 && nowPlatforms.length > 0) {
      const same = baselinePlatforms.join(',') === nowPlatforms.join(',');
      if (!same)
        issues.push(
          `delivery platforms drifted from baseline (${baselinePlatforms.join(',')} -> ${nowPlatforms.join(',')})`
        );
    }
  }
  return issues;
}

function statusFromIssues(issues) {
  if (!issues || issues.length === 0) return 'pass';
  if (issues.some((i) => i.includes('missing') || i.includes('not passed'))) return 'fail';
  return 'warn';
}

function preflightGateExecution({ jobId, gate, fallbackJobSpec = null }) {
  if (!jobId || !gate) return { ready: false, reasons: ['missing jobId or gate'], softHeals: [] };
  const current = getJobSpec(jobId) || fallbackJobSpec;
  if (!current) return { ready: false, reasons: ['job spec not found'], softHeals: [] };

  if (!current?.state?.gateContracts?.gates) {
    persistJobSpecGateContracts(current, {});
  }

  const latest = getJobSpec(jobId) || current;
  const { heals, patch } = softHealJobSpec(latest, gate);
  const healed = patch ? updateJobSpec(jobId, patch) : latest;
  const prereqs = PORTAL_PREREQS[gate] || [];
  const reasons = [];
  for (const prereq of prereqs) {
    if (!gatePassedish(healed?.state?.gateResults?.[prereq])) {
      reasons.push(`prerequisite ${prereq} missing/not passed`);
    }
  }
  return {
    ready: reasons.length === 0,
    reasons,
    softHeals: heals,
    jobSpec: healed,
  };
}

function auditAndRecordGateResult({ jobId, gate, result, fallbackJobSpec = null }) {
  if (!jobId || !gate) return null;
  const current = getJobSpec(jobId) || fallbackJobSpec;
  if (!current) return null;

  // Ensure contracts exist even for older jobs
  if (!current?.state?.gateContracts?.gates) {
    persistJobSpecGateContracts(current, {});
  }

  const latest = getJobSpec(jobId) || current;
  const { heals, patch } = softHealJobSpec(latest, gate);
  let healedSpec = latest;
  if (patch) healedSpec = updateJobSpec(jobId, patch);

  const issues = auditIssuesForGate(healedSpec, gate, result);
  const status = statusFromIssues(issues);
  const record = {
    gate,
    auditedAt: new Date().toISOString(),
    status,
    issues,
    softHeals: heals,
    resultOutcome: result?.outcome || (result?.passed ? 'pass' : null),
    cumulativeGateOrder: PORTAL_ORDER.slice(0, PORTAL_ORDER.indexOf(gate) + 1),
  };

  const existingContracts = healedSpec?.state?.gateContracts || {};
  const nextQaByGate = { ...(existingContracts.qaByGate || {}), [gate]: record };
  const cumulativeIssues = Object.values(nextQaByGate).flatMap((r) =>
    (r?.issues || []).map((i) => `${r.gate}: ${i}`)
  );
  const cumulativeHeals = Object.values(nextQaByGate).flatMap((r) =>
    (r?.softHeals || []).map((h) => `${r.gate}: ${h}`)
  );
  const cumulativeStatus =
    cumulativeIssues.length === 0
      ? 'pass'
      : cumulativeIssues.some((i) => i.includes('missing') || i.includes('not passed'))
        ? 'fail'
        : 'warn';

  updateJobSpec(jobId, {
    state: {
      gateContracts: {
        ...existingContracts,
        qaByGate: nextQaByGate,
        cumulative: {
          status: cumulativeStatus,
          lastGate: gate,
          issues: cumulativeIssues,
          softHeals: cumulativeHeals,
          updatedAt: new Date().toISOString(),
        },
      },
    },
  });

  return record;
}

function buildGateStatusSnapshot(jobSpec) {
  const spec = jobSpec || {};
  const gateResults = spec?.state?.gateResults || {};
  const contracts = spec?.state?.gateContracts || {};
  const qaByGate = contracts?.qaByGate || {};
  const saved = spec?.state?.savedOutputs || {};

  const gates = {};
  for (const gate of PORTAL_ORDER) {
    const result = gateResults[gate] || null;
    const qa = qaByGate[gate] || null;
    const handoff = saved[`${gate}_handoff_review`] || null;
    const policy = saved[`${gate}_policy`] || null;
    gates[gate] = {
      passed: result?.passed === true,
      outcome: result?.outcome || null,
      score: result?.score ?? null,
      qaStatus: qa?.status || null,
      qaIssues: qa?.issues || [],
      handoffPass: handoff?.passed ?? null,
      handoffIssues: handoff?.issues || [],
      nextGate: handoff?.nextGate || null,
      policyStatus: policy?.status || null,
      policyWorkerAttempts: policy?.workerAttempts ?? null,
      policySendbackAttempts: policy?.sendbackAttempts ?? null,
      policyInterventionAttempts: policy?.interventionAttempts ?? null,
    };
  }

  const blockers = [];
  for (const gate of PORTAL_ORDER) {
    const row = gates[gate];
    if (row.handoffPass === false) blockers.push(`${gate} handoff blocked`);
    if (row.qaStatus === 'fail') blockers.push(`${gate} QA failed`);
    if (row.passed === false && row.outcome && row.outcome !== 'sendback')
      blockers.push(`${gate} outcome=${row.outcome}`);
  }

  return {
    updatedAt: new Date().toISOString(),
    cumulativeStatus: contracts?.cumulative?.status || null,
    lastGate: contracts?.cumulative?.lastGate || null,
    blockers,
    gates,
  };
}

function validateGateContractConsistency(jobSpec) {
  const issues = [];
  const warnings = [];
  const spec = jobSpec || {};
  const contracts = spec?.state?.gateContracts;
  if (!contracts?.gates) {
    return {
      ok: false,
      issues: ['state.gateContracts.gates missing'],
      warnings,
      duplicateWorkerFocus: [],
      missingCommitSummary: [],
      missingExpectedFromOrder: [],
    };
  }

  const seenFocus = new Map();
  const duplicateWorkerFocus = [];
  const missingCommitSummary = [];
  const missingExpectedFromOrder = [];

  for (const gate of PORTAL_ORDER) {
    const c = contracts.gates[gate];
    if (!c) {
      issues.push(`missing gate contract entry for ${gate}`);
      continue;
    }
    if (!c.workerFocus || !String(c.workerFocus).trim()) {
      issues.push(`${gate} workerFocus missing`);
    } else {
      const norm = String(c.workerFocus).trim().toLowerCase();
      if (seenFocus.has(norm)) {
        duplicateWorkerFocus.push(`${seenFocus.get(norm)} <-> ${gate}`);
      } else {
        seenFocus.set(norm, gate);
      }
    }

    if (!c.expectedFromOrder || typeof c.expectedFromOrder !== 'object') {
      missingExpectedFromOrder.push(gate);
    } else {
      const eo = c.expectedFromOrder;
      if (!eo.contentType) warnings.push(`${gate} expectedFromOrder.contentType missing`);
      if (!eo.templateId) warnings.push(`${gate} expectedFromOrder.templateId missing`);
    }

    if (!c.commitSummary || !String(c.commitSummary).trim()) {
      missingCommitSummary.push(gate);
    }
  }

  if (duplicateWorkerFocus.length > 0) {
    issues.push(`duplicate workerFocus found: ${duplicateWorkerFocus.join(', ')}`);
  }
  if (missingExpectedFromOrder.length > 0) {
    issues.push(`missing expectedFromOrder for: ${missingExpectedFromOrder.join(', ')}`);
  }
  if (missingCommitSummary.length > 0) {
    warnings.push(`missing commitSummary for: ${missingCommitSummary.join(', ')}`);
  }

  return {
    ok: issues.length === 0,
    issues,
    warnings,
    duplicateWorkerFocus,
    missingCommitSummary,
    missingExpectedFromOrder,
  };
}

module.exports = {
  persistJobSpecGateContracts,
  auditAndRecordGateResult,
  preflightGateExecution,
  buildGateStatusSnapshot,
  validateGateContractConsistency,
};
