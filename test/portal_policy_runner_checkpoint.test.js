'use strict';
/**
 * test/portal_policy_runner_checkpoint.test.js — CPD-898
 *
 * Verifies BullMQ checkpoint resume logic in runPortalSequence.
 */

jest.mock('../lib/job_spec', () => ({
  resolveActivePortals: jest.fn((spec) =>
    Object.keys(spec.portals || {}).filter((k) => spec.portals[k]?.active === true)
  ),
  resolveActiveExtensions: jest.fn(() => []),
}));

const { runPortalSequence } = require('../lib/portal_policy_runner');

function makePassWorker() {
  return {
    runWorker: jest.fn(async () => ({ passed: true, outcome: 'pass' })),
    isPass:    (r) => !!r?.passed,
  };
}

function makeSpec(overrides = {}) {
  return {
    jobId:   'test-job',
    portals: {
      portal0: { active: true },
      portal1: { active: true },
      portal2: { active: true },
    },
    state: {},
    extensions: {},
    ...overrides,
  };
}

// ─── Checkpoint write ─────────────────────────────────────────────────────────

describe('runPortalSequence — checkpoint write', () => {
  it('writes lastPassingPortal to state.checkpoints after each portal passes', async () => {
    const spec = makeSpec();
    const w0 = makePassWorker();
    const w1 = makePassWorker();
    const w2 = makePassWorker();

    await runPortalSequence({
      jobSpec:      spec,
      portalWorkers: { portal0: w0, portal1: w1, portal2: w2 },
    });

    expect(spec.state.checkpoints.lastPassingPortal).toBe('portal2');
    expect(spec.state.checkpoints.lastPassingPortalAt).toBeDefined();
  });

  it('checkpoints to the last portal that actually ran when later portals fail', async () => {
    const spec = makeSpec();
    const w0 = makePassWorker();
    const w1 = { runWorker: jest.fn(async () => ({ passed: false, outcome: 'hard_stop' })), isPass: (r) => !!r?.passed };
    const w2 = makePassWorker();

    await runPortalSequence({
      jobSpec:      spec,
      portalWorkers: { portal0: w0, portal1: w1, portal2: w2 },
    });

    // portal0 passed → checkpoint set; portal1 failed → not updated
    expect(spec.state.checkpoints.lastPassingPortal).toBe('portal0');
  });
});

// ─── Checkpoint skip (resumeFromPortal) ───────────────────────────────────────

describe('runPortalSequence — resumeFromPortal skip', () => {
  it('skips portals at/before resumeFromPortal', async () => {
    const spec = makeSpec();
    const w0 = makePassWorker();
    const w1 = makePassWorker();
    const w2 = makePassWorker();

    await runPortalSequence({
      jobSpec:          spec,
      portalWorkers:    { portal0: w0, portal1: w1, portal2: w2 },
      resumeFromPortal: 'portal1',
    });

    // portal0 and portal1 are at/before 'portal1' → skipped
    expect(w0.runWorker).not.toHaveBeenCalled();
    expect(w1.runWorker).not.toHaveBeenCalled();
    // portal2 is after 'portal1' → runs
    expect(w2.runWorker).toHaveBeenCalled();
  });

  it('marks skipped portals with checkpoint_already_passed reason', async () => {
    const spec = makeSpec();
    const w2 = makePassWorker();
    const onPortalPass = jest.fn();

    const result = await runPortalSequence({
      jobSpec:          spec,
      portalWorkers:    { portal0: makePassWorker(), portal1: makePassWorker(), portal2: w2 },
      resumeFromPortal: 'portal1',
      onPortalPass,
    });

    // result portalResults for skipped portals
    expect(result.portalResults.portal0.reason).toBe('checkpoint_already_passed');
    expect(result.portalResults.portal1.reason).toBe('checkpoint_already_passed');
    // portal2 ran and passed
    expect(result.passed).toBe(true);
  });

  it('null resumeFromPortal runs all portals normally', async () => {
    const spec = makeSpec();
    const w0 = makePassWorker();
    const w1 = makePassWorker();

    await runPortalSequence({
      jobSpec:          spec,
      portalWorkers:    { portal0: w0, portal1: w1, portal2: makePassWorker() },
      resumeFromPortal: null,
    });

    expect(w0.runWorker).toHaveBeenCalled();
    expect(w1.runWorker).toHaveBeenCalled();
  });

  it('resumeFromPortal beyond all active portals → all skipped, job completes', async () => {
    const spec = makeSpec();
    const onJobComplete = jest.fn();

    const result = await runPortalSequence({
      jobSpec:          spec,
      portalWorkers:    {
        portal0: makePassWorker(),
        portal1: makePassWorker(),
        portal2: makePassWorker(),
      },
      resumeFromPortal: 'portal4', // beyond all active portals
      onJobComplete,
    });

    expect(result.passed).toBe(true);
    expect(onJobComplete).toHaveBeenCalled();
  });
});
