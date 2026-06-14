'use strict';
/**
 * test/portal_sequence.test.js — CPD-25
 * Unit tests for runPortalSequence() — autonomous portal-to-portal progression.
 */

const { runPortalSequence } = require('../lib/portal_policy_runner');

// Minimal mock job spec with portals map
function makeJobSpec(activePortalKeys = ['portal0', 'portal1']) {
  const portals = {};
  for (const key of activePortalKeys) {
    portals[key] = { key, label: key, active: true, skippable: false, provider: 'test' };
  }
  return {
    jobId: 'test_job_001',
    portals,
  };
}

// Mock portal worker that always passes
function passingWorker() {
  return {
    runWorker: async () => ({ passed: true, outcome: 'pass', score: 95 }),
    isPass: (r) => !!r?.passed,
  };
}

// Mock portal worker that always fails (hard stop after max sendbacks)
function failingWorker() {
  return {
    runWorker: async () => ({ passed: false, outcome: 'hard_fail', score: 10 }),
    isPass: (r) => !!r?.passed,
  };
}

// Mock portal worker that fails N times then passes
function flakyWorker(failCount) {
  let calls = 0;
  return {
    runWorker: async () => {
      calls++;
      if (calls <= failCount) return { passed: false, outcome: 'sendback', score: 60 };
      return { passed: true, outcome: 'pass', score: 85 };
    },
    isPass: (r) => !!r?.passed,
  };
}

describe('runPortalSequence', () => {
  test('all portals pass → returns passed=true, failedAt=null', async () => {
    const jobSpec = makeJobSpec(['portal0', 'portal1', 'portal2']);
    const result = await runPortalSequence({
      jobSpec,
      portalWorkers: {
        portal0: passingWorker(),
        portal1: passingWorker(),
        portal2: passingWorker(),
      },
    });
    expect(result.passed).toBe(true);
    expect(result.failedAt).toBeNull();
    expect(Object.keys(result.portalResults)).toEqual(['portal0', 'portal1', 'portal2']);
  });

  test('portal1 fails (hard stop) → returns passed=false, failedAt=portal1', async () => {
    const jobSpec = makeJobSpec(['portal0', 'portal1', 'portal2']);
    const result = await runPortalSequence({
      jobSpec,
      portalWorkers: {
        portal0: passingWorker(),
        portal1: failingWorker(),
        portal2: passingWorker(),
      },
      defaultMaxSendbacks: 0,
      defaultMaxInterventions: 0,
    });
    expect(result.passed).toBe(false);
    expect(result.failedAt).toBe('portal1');
    // portal2 should NOT have run after portal1 hard-stopped
    expect(result.portalResults.portal2).toBeUndefined();
  });

  test('flaky portal passes after 2 retries', async () => {
    const jobSpec = makeJobSpec(['portal0', 'portal1']);
    const result = await runPortalSequence({
      jobSpec,
      portalWorkers: {
        portal0: passingWorker(),
        portal1: flakyWorker(2), // fails 2x, passes on 3rd
      },
      defaultMaxSendbacks: 3,
      defaultMaxInterventions: 0,
    });
    expect(result.passed).toBe(true);
    expect(result.failedAt).toBeNull();
    expect(result.policies.portal1.workerAttempts).toBe(3);
  });

  test('flaky portal fails if retries exhausted', async () => {
    const jobSpec = makeJobSpec(['portal0', 'portal1']);
    const result = await runPortalSequence({
      jobSpec,
      portalWorkers: {
        portal0: passingWorker(),
        portal1: flakyWorker(5), // would need 5 retries but cap is 1 sendback
      },
      defaultMaxSendbacks: 1,
      defaultMaxInterventions: 0,
    });
    expect(result.passed).toBe(false);
    expect(result.failedAt).toBe('portal1');
  });

  test('missing worker for active portal → portal skipped, pipeline continues', async () => {
    const jobSpec = makeJobSpec(['portal0', 'portal1']);
    const result = await runPortalSequence({
      jobSpec,
      portalWorkers: {
        portal0: passingWorker(),
        // portal1 has no worker registered
      },
    });
    expect(result.passed).toBe(true);
    expect(result.portalResults.portal1).toEqual({ skipped: true, reason: 'no_worker_registered' });
  });

  test('callbacks fire in correct order', async () => {
    const jobSpec = makeJobSpec(['portal0', 'portal1']);
    const events = [];
    await runPortalSequence({
      jobSpec,
      portalWorkers: {
        portal0: passingWorker(),
        portal1: passingWorker(),
      },
      onPortalStart: async (key) => events.push(`start:${key}`),
      onPortalPass: async (key) => events.push(`pass:${key}`),
      onJobComplete: async () => events.push('complete'),
    });
    expect(events).toEqual(['start:portal0', 'pass:portal0', 'start:portal1', 'pass:portal1', 'complete']);
  });

  test('onJobFailed fires when portal hard-stops', async () => {
    const jobSpec = makeJobSpec(['portal0', 'portal1']);
    let failedPortal = null;
    await runPortalSequence({
      jobSpec,
      portalWorkers: {
        portal0: passingWorker(),
        portal1: failingWorker(),
      },
      defaultMaxSendbacks: 0,
      defaultMaxInterventions: 0,
      onJobFailed: async (portalKey) => { failedPortal = portalKey; },
    });
    expect(failedPortal).toBe('portal1');
  });

  test('empty jobSpec returns passed=true with no portal results', async () => {
    const result = await runPortalSequence({
      jobSpec: { jobId: 'empty', portals: {} },
      portalWorkers: {},
    });
    expect(result.passed).toBe(true);
    expect(result.failedAt).toBeNull();
    expect(Object.keys(result.portalResults)).toHaveLength(0);
  });

  test('per-portal retry cap overrides global default', async () => {
    const jobSpec = makeJobSpec(['portal0', 'portal1']);
    const result = await runPortalSequence({
      jobSpec,
      portalWorkers: {
        portal0: passingWorker(),
        portal1: flakyWorker(2), // needs 2 retries to pass
      },
      defaultMaxSendbacks: 0,          // global: no retries
      retryCaps: { portal1: { maxSendbacks: 3 } }, // portal1: 3 retries allowed
    });
    expect(result.passed).toBe(true); // portal1 passes with per-portal cap
  });
});
