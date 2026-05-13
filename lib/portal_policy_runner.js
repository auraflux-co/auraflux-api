'use strict';

async function runUnifiedGatePolicy({
  gateKey,
  jobId,
  runWorkerAttempt,
  runInterventionAttempt,
  isPass,
  persistStatus,
  onRetryAttempt,
  onHardStop,
  maxSendbacks = 3,
  maxInterventions = 2,
}) {
  const policy = {
    gate: gateKey,
    status: 'running',
    workerAttempts: 0,
    sendbackAttempts: 0,
    interventionAttempts: 0,
    maxSendbacks,
    maxInterventions,
    lastOutcome: null,
    lastScore: null,
    history: [],
  };

  const persist = async () => {
    if (!persistStatus) return;
    try {
      await persistStatus(policy);
    } catch (_e) {
      /* non-fatal */
    }
  };

  const markResult = (result, phase) => {
    policy.lastOutcome = result?.outcome || null;
    policy.lastScore = result?.score ?? null;
    policy.history.push({
      at: new Date().toISOString(),
      phase,
      outcome: result?.outcome || null,
      score: result?.score ?? null,
      passed: !!result?.passed,
    });
  };

  const invokeWorker = async (phase) => {
    policy.workerAttempts += 1;
    if (onRetryAttempt) {
      try {
        await onRetryAttempt({
          gate: gateKey,
          jobId,
          phase,
          attempt: policy.workerAttempts,
          maxAttempts: 1 + maxSendbacks + maxInterventions,
        });
      } catch (_e) {
        /* non-fatal */
      }
    }
    const result = await runWorkerAttempt({ workerAttempt: policy.workerAttempts, phase });
    markResult(result, phase);
    await persist();
    return result;
  };

  let result = await invokeWorker('worker_attempt');
  if (isPass(result)) {
    policy.status = 'passed';
    await persist();
    return { result, policy };
  }

  while (policy.sendbackAttempts < maxSendbacks) {
    policy.sendbackAttempts += 1;
    policy.status = 'sendback';
    await persist();
    result = await invokeWorker(`sendback_${policy.sendbackAttempts}`);
    if (isPass(result)) {
      policy.status = 'passed';
      await persist();
      return { result, policy };
    }
  }

  while (policy.interventionAttempts < maxInterventions) {
    policy.interventionAttempts += 1;
    policy.status = 'intervention';
    if (runInterventionAttempt) {
      try {
        const note = await runInterventionAttempt({
          interventionAttempt: policy.interventionAttempts,
          lastResult: result,
        });
        if (note) {
          policy.history.push({
            at: new Date().toISOString(),
            phase: `intervention_action_${policy.interventionAttempts}`,
            note: String(note),
          });
        }
      } catch (e) {
        policy.history.push({
          at: new Date().toISOString(),
          phase: `intervention_action_${policy.interventionAttempts}`,
          note: `intervention error: ${e.message}`,
        });
      }
    }
    await persist();
    result = await invokeWorker(`intervention_${policy.interventionAttempts}`);
    if (isPass(result)) {
      policy.status = 'passed';
      await persist();
      return { result, policy };
    }
  }

  policy.status = 'hard_stop';
  if (result && typeof result === 'object') {
    result.passed = false;
    if (!result.outcome || result.outcome === 'review' || result.outcome === 'sendback') {
      result.outcome = 'hard_fail';
    }
  }
  if (onHardStop) {
    try {
      await onHardStop({ gateKey, jobId, policy, result });
    } catch (_e) {
      /* non-fatal */
    }
  }
  await persist();
  return { result, policy };
}

// ── runPortalSequence ─────────────────────────────────────────────────────────

/**
 * Autonomous portal-to-portal progression (CPD-25).
 *
 * Runs active portals for a job in order, using resolveActivePortals() to build
 * the sequence from the job spec. For each portal:
 *   - pass          → advance to next portal
 *   - sendback/fail → apply retry policy (sendbacks + interventions per runUnifiedGatePolicy)
 *   - hard_stop     → mark job failed at this portal, halt pipeline
 *   - all pass      → invoke onJobComplete
 *
 * Retry caps: controlled by the per-portal entry in `retryCaps` (or global defaults).
 *
 * @param {Object} opts
 * @param {Object}   opts.jobSpec               — job spec from createJobSpec()
 * @param {Object}   opts.portalWorkers          — map of portalKey → { runWorker, runIntervention, isPass }
 *                                                 e.g. { portal0: { runWorker: fn, isPass: fn }, ... }
 * @param {Object}   [opts.retryCaps]            — per-portal retry overrides { portalKey: { maxSendbacks, maxInterventions } }
 * @param {number}   [opts.defaultMaxSendbacks]  — default sendbacks per portal (default 3)
 * @param {number}   [opts.defaultMaxInterventions] — default interventions per portal (default 2)
 * @param {Function} [opts.onPortalStart]        — async (portalKey, jobSpec) => void
 * @param {Function} [opts.onPortalPass]         — async (portalKey, result, policy) => void
 * @param {Function} [opts.onPortalFail]         — async (portalKey, result, policy) => void — called on hard_stop
 * @param {Function} [opts.onJobComplete]        — async (results) => void — called when all portals pass
 * @param {Function} [opts.onJobFailed]          — async (failedPortal, result, policy) => void
 * @param {Function} [opts.persistJobStatus]     — async (update) => void — called with { portalKey, policy, phase }
 *
 * @returns {Promise<{ passed: boolean, failedAt: string|null, portalResults: Object, policies: Object }>}
 */
/**
 * Extension insertion points — defines after which portal each extension fires.
 * Extensions only run if resolveActiveExtensions(jobSpec) includes their key.
 *
 * heygen_ext runs after portal1 (Script QA) — avatar render needs the final script.
 */
const EXTENSION_AFTER_PORTAL = {
  heygen_ext:       'portal1',
  tts_ext:          'portal1',         // ElevenLabs VO — fires after Portal 1, before Portal 3b
  thumbnail_ext:    'portal4',         // Thumbnail approval stage — fires after Portal 4, before Portal 5
  shoppable_ext:    'portal4',         // shoppable CTA bake-in fires after assembly, before publish
};

async function runPortalSequence({
  jobSpec,
  portalWorkers = {},
  extensionWorkers = {},
  retryCaps = {},
  defaultMaxSendbacks = 3,
  defaultMaxInterventions = 2,
  onPortalStart,
  onPortalPass,
  onPortalFail,
  onJobComplete,
  onJobFailed,
  persistJobStatus,
}) {
  const jobId = jobSpec?.jobId || 'unknown';

  // Resolve active portals — prefer job_spec export if available (CPD-65),
  // otherwise fall back to reading jobSpec.portals directly.
  let activePortals;
  try {
    const { resolveActivePortals } = require('./job_spec');
    activePortals = resolveActivePortals(jobSpec);
  } catch {
    // Fallback: read portals map directly from jobSpec
    const PORTAL_ORDER = ['portal0', 'portal1', 'portal1b', 'portal2', 'portal3a', 'portal3b', 'portal4', 'portal5'];
    const portals = jobSpec?.portals || {};
    activePortals = PORTAL_ORDER.filter((key) => portals[key]?.active === true);
  }

  const portalResults = {};
  const policies = {};

  for (const portalKey of activePortals) {
    const worker = portalWorkers[portalKey];

    // If no worker registered for an active portal, skip with a warning
    if (!worker || typeof worker.runWorker !== 'function') {
      console.warn(`[portal-sequence:${jobId}] No worker registered for ${portalKey} — skipping`);
      portalResults[portalKey] = { skipped: true, reason: 'no_worker_registered' };
      continue;
    }

    if (onPortalStart) {
      try { await onPortalStart(portalKey, jobSpec); } catch (_e) { /* non-fatal */ }
    }

    const caps = retryCaps[portalKey] || {};
    const maxSendbacks = caps.maxSendbacks ?? defaultMaxSendbacks;
    const maxInterventions = caps.maxInterventions ?? defaultMaxInterventions;

    const persistStatus = persistJobStatus
      ? async (policy) => {
          try {
            await persistJobStatus({ portalKey, policy, phase: policy.status });
          } catch (_e) { /* non-fatal */ }
        }
      : null;

    const { result, policy } = await runUnifiedGatePolicy({
      gateKey: portalKey,
      jobId,
      runWorkerAttempt: worker.runWorker,
      runInterventionAttempt: worker.runIntervention || null,
      isPass: worker.isPass || ((r) => !!r?.passed),
      persistStatus,
      maxSendbacks,
      maxInterventions,
    });

    portalResults[portalKey] = result;
    policies[portalKey] = policy;

    if (policy.status === 'passed') {
      if (onPortalPass) {
        try { await onPortalPass(portalKey, result, policy); } catch (_e) { /* non-fatal */ }
      }

      // After each portal passes, check if any ordered extension fires here. (CPD-68)
      let activeExtensions;
      try {
        const { resolveActiveExtensions } = require('./job_spec');
        activeExtensions = resolveActiveExtensions(jobSpec);
      } catch {
        activeExtensions = Object.keys(jobSpec?.extensions || {}).filter(
          (k) => jobSpec.extensions[k]?.ordered === true
        );
      }
      for (const extKey of activeExtensions) {
        if (EXTENSION_AFTER_PORTAL[extKey] !== portalKey) continue;
        const extWorker = extensionWorkers[extKey];
        if (!extWorker || typeof extWorker.runWorker !== 'function') {
          console.warn(
            `[portal-sequence:${jobId}] Extension ${extKey} ordered but no worker registered — skipping`
          );
          portalResults[extKey] = { skipped: true, reason: 'no_extension_worker_registered' };
          continue;
        }
        if (onPortalStart) {
          try { await onPortalStart(extKey, jobSpec); } catch (_e) { /* non-fatal */ }
        }
        const extCaps = retryCaps[extKey] || {};
        const extMaxSendbacks = extCaps.maxSendbacks ?? defaultMaxSendbacks;
        const extMaxInterventions = extCaps.maxInterventions ?? defaultMaxInterventions;
        const { result: extResult, policy: extPolicy } = await runUnifiedGatePolicy({
          gateKey: extKey,
          jobId,
          runWorkerAttempt: extWorker.runWorker,
          runInterventionAttempt: extWorker.runIntervention || null,
          isPass: extWorker.isPass || ((r) => !!r?.passed),
          persistStatus: persistJobStatus
            ? async (p) => {
                try { await persistJobStatus({ portalKey: extKey, policy: p, phase: p.status }); } catch (_e) {}
              }
            : null,
          maxSendbacks: extMaxSendbacks,
          maxInterventions: extMaxInterventions,
        });
        portalResults[extKey] = extResult;
        policies[extKey] = extPolicy;
        if (extPolicy.status === 'passed') {
          if (onPortalPass) {
            try { await onPortalPass(extKey, extResult, extPolicy); } catch (_e) {}
          }
        } else if (extResult?.outcome === 'skip') {
          // CPD-191: Extension skipped (feature unavailable or env var missing) — non-fatal.
          // Extensions are graceful degradations; a skip means the feature is inactive for this
          // job but the job should continue and produce output without that feature.
          console.warn(
            `[portal-sequence:${jobId}] Extension ${extKey} skipped — ${extResult.reason || 'no reason given'} — continuing without it`
          );
          if (onPortalFail) {
            try { await onPortalFail(extKey, extResult, extPolicy); } catch (_e) {}
          }
        } else {
          if (onPortalFail) {
            try { await onPortalFail(extKey, extResult, extPolicy); } catch (_e) {}
          }
          if (onJobFailed) {
            try { await onJobFailed(extKey, extResult, extPolicy); } catch (_e) {}
          }
          return { passed: false, failedAt: extKey, portalResults, policies };
        }
      }
    } else {
      // hard_stop — job failed at this portal
      if (onPortalFail) {
        try { await onPortalFail(portalKey, result, policy); } catch (_e) { /* non-fatal */ }
      }
      if (onJobFailed) {
        try { await onJobFailed(portalKey, result, policy); } catch (_e) { /* non-fatal */ }
      }
      return {
        passed: false,
        failedAt: portalKey,
        portalResults,
        policies,
      };
    }
  }

  // All active portals passed
  if (onJobComplete) {
    try { await onJobComplete(portalResults); } catch (_e) { /* non-fatal */ }
  }
  return {
    passed: true,
    failedAt: null,
    portalResults,
    policies,
  };
}

module.exports = { runUnifiedGatePolicy, runPortalSequence };
