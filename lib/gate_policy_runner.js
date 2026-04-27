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

module.exports = { runUnifiedGatePolicy };
