'use strict';
/**
 * test/heygen_ext.test.js — CPD-68
 * Tests for HeyGen extension wiring:
 *   1. createJobSpec() addOns.heygen sets extensions.heygen_ext.ordered=true
 *   2. runPortalSequence() injects heygen_ext worker between portal1 and portal2
 *   3. portal_heygen_ext.js worker logic
 */

const { runPortalSequence } = require('../lib/gate_policy_runner');

// ── createJobSpec addOns wiring ────────────────────────────────────────────

describe('createJobSpec addOns.heygen (CPD-68)', () => {
  const { createJobSpec } = require('../lib/job_spec');

  test('addOns.heygen.active=true sets heygen_ext.ordered=true', () => {
    const spec = createJobSpec({
      customerId: 'c0',
      contentType: 'news',
      addOns: { heygen: { active: true, avatarId: 'av_123', voiceId: 'vc_456' } },
    });
    expect(spec.extensions.heygen_ext.ordered).toBe(true);
    expect(spec.extensions.heygen_ext.avatarId).toBe('av_123');
    expect(spec.extensions.heygen_ext.voiceId).toBe('vc_456');
  });

  test('addOns.heygen.active=false leaves heygen_ext.ordered=false', () => {
    const spec = createJobSpec({
      customerId: 'c0',
      contentType: 'news',
      addOns: { heygen: { active: false } },
    });
    expect(spec.extensions.heygen_ext.ordered).toBe(false);
  });

  test('no addOns leaves heygen_ext.ordered=false', () => {
    const spec = createJobSpec({ customerId: 'c0', contentType: 'news' });
    expect(spec.extensions.heygen_ext.ordered).toBe(false);
  });

  test('addOns mirrors into jobSpec.addOns', () => {
    const spec = createJobSpec({
      customerId: 'c0',
      contentType: 'news',
      addOns: { heygen: { active: true, avatarId: 'av_x' } },
    });
    expect(spec.addOns.heygen.active).toBe(true);
    expect(spec.addOns.heygen.avatarId).toBe('av_x');
  });
});

// ── runPortalSequence extension injection ─────────────────────────────────────

function makeJobSpecWithExtension(activePortals = ['portal0', 'portal1', 'portal2']) {
  const portals = {};
  for (const key of activePortals) {
    portals[key] = { key, label: key, active: true, skippable: false, provider: 'test' };
  }
  return {
    jobId: 'test_heygen_ext_001',
    portals,
    extensions: {
      heygen_ext: { key: 'heygen_ext', ordered: true, provider: 'heygen', avatarId: 'av_1' },
      shoppable_ext: { key: 'shoppable_ext', ordered: false },
    },
  };
}

function passingWorker() {
  return {
    runWorker: async () => ({ passed: true, outcome: 'pass', score: 95 }),
    isPass: (r) => !!r?.passed,
  };
}

describe('runPortalSequence — extension injection (CPD-68)', () => {
  test('heygen_ext runs between portal1 and portal2 when ordered', async () => {
    const executed = [];
    const jobSpec = makeJobSpecWithExtension(['portal0', 'portal1', 'portal2']);
    const workers = {
      portal0: { runWorker: async () => { executed.push('portal0'); return { passed: true }; }, isPass: (r) => r?.passed },
      portal1: { runWorker: async () => { executed.push('portal1'); return { passed: true }; }, isPass: (r) => r?.passed },
      portal2: { runWorker: async () => { executed.push('portal2'); return { passed: true }; }, isPass: (r) => r?.passed },
    };
    const extWorkers = {
      heygen_ext: {
        runWorker: async () => { executed.push('heygen_ext'); return { passed: true, outcome: 'submitted' }; },
        isPass: (r) => r?.passed,
      },
    };

    const result = await runPortalSequence({ jobSpec, portalWorkers: workers, extensionWorkers: extWorkers });

    expect(result.passed).toBe(true);
    expect(executed).toEqual(['portal0', 'portal1', 'heygen_ext', 'portal2']);
  });

  test('heygen_ext failure halts pipeline before portal2', async () => {
    const jobSpec = makeJobSpecWithExtension(['portal0', 'portal1', 'portal2']);
    const workers = {
      portal0: passingWorker(),
      portal1: passingWorker(),
      portal2: passingWorker(),
    };
    const extWorkers = {
      heygen_ext: {
        runWorker: async () => ({ passed: false, outcome: 'hard_fail' }),
        isPass: (r) => !!r?.passed,
      },
    };

    const result = await runPortalSequence({ jobSpec, portalWorkers: workers, extensionWorkers: extWorkers });

    expect(result.passed).toBe(false);
    expect(result.failedAt).toBe('heygen_ext');
    expect(result.portalResults.portal2).toBeUndefined();
  });

  test('heygen_ext skipped when no worker registered', async () => {
    const executed = [];
    const jobSpec = makeJobSpecWithExtension(['portal0', 'portal1', 'portal2']);
    const workers = {
      portal0: { runWorker: async () => { executed.push('portal0'); return { passed: true }; }, isPass: (r) => r?.passed },
      portal1: { runWorker: async () => { executed.push('portal1'); return { passed: true }; }, isPass: (r) => r?.passed },
      portal2: { runWorker: async () => { executed.push('portal2'); return { passed: true }; }, isPass: (r) => r?.passed },
    };

    const result = await runPortalSequence({ jobSpec, portalWorkers: workers, extensionWorkers: {} });

    expect(result.passed).toBe(true);
    expect(result.portalResults.heygen_ext).toMatchObject({ skipped: true });
    expect(executed).toEqual(['portal0', 'portal1', 'portal2']);
  });

  test('heygen_ext not injected when ordered=false', async () => {
    const executed = [];
    const jobSpec = makeJobSpecWithExtension(['portal0', 'portal1', 'portal2']);
    jobSpec.extensions.heygen_ext.ordered = false;
    const workers = {
      portal0: { runWorker: async () => { executed.push('portal0'); return { passed: true }; }, isPass: (r) => r?.passed },
      portal1: { runWorker: async () => { executed.push('portal1'); return { passed: true }; }, isPass: (r) => r?.passed },
      portal2: { runWorker: async () => { executed.push('portal2'); return { passed: true }; }, isPass: (r) => r?.passed },
    };
    const extWorkers = {
      heygen_ext: { runWorker: async () => { executed.push('heygen_ext'); return { passed: true }; }, isPass: (r) => r?.passed },
    };

    const result = await runPortalSequence({ jobSpec, portalWorkers: workers, extensionWorkers: extWorkers });

    expect(result.passed).toBe(true);
    expect(executed).toEqual(['portal0', 'portal1', 'portal2']);
    expect(executed).not.toContain('heygen_ext');
  });
});

// ── portal_heygen_ext worker unit tests ─────────────────────────────────────────

describe('portal_heygen_ext worker (CPD-68)', () => {
  let runWorker, isPass;

  beforeEach(() => {
    jest.resetModules();
    process.env.HEYGEN_API_KEY = 'test-heygen-key'; // required for avatar.heygen feature gate
    ({ runWorker, isPass } = require('../lib/portals/portal_heygen_ext'));
  });

  afterEach(() => {
    delete process.env.HEYGEN_API_KEY;
  });

  test('returns skip when plan tier is too low (diy)', async () => {
    const result = await runWorker({
      jobSpec: { jobId: 'test', planTier: 'diy', addOns: { heygen: { active: true } }, extensions: { heygen_ext: { ordered: true } } },
    });
    expect(result.passed).toBe(false);
    expect(result.outcome).toBe('skip');
  });

  test('returns skip when not ordered', async () => {
    const result = await runWorker({
      jobSpec: { jobId: 'test', planTier: 'dfy', addOns: { heygen: { active: false } } },
    });
    expect(result.passed).toBe(false);
    expect(result.outcome).toBe('skip');
  });

  test('returns hard_fail when no avatarId', async () => {
    const result = await runWorker({
      jobSpec: {
        jobId:       'test',
        planTier:    'dfy',
        addOns:      { heygen: { active: true, avatarId: null } },
        extensions:  { heygen_ext: { ordered: true } },
      },
    });
    expect(result.passed).toBe(false);
    expect(result.outcome).toBe('hard_fail');
  });

  test('returns hard_fail when no script', async () => {
    const result = await runWorker({
      jobSpec: {
        jobId:       'test',
        planTier:    'dfy',
        addOns:      { heygen: { active: true, avatarId: 'av_1' } },
        extensions:  { heygen_ext: { ordered: true, avatarId: 'av_1' } },
        script:      null,
      },
    });
    expect(result.passed).toBe(false);
    expect(result.outcome).toBe('hard_fail');
  });

  test('isPass returns true for submitted outcome', () => {
    expect(isPass({ passed: true, outcome: 'submitted' })).toBe(true);
  });

  test('isPass returns false for hard_fail', () => {
    expect(isPass({ passed: false, outcome: 'hard_fail' })).toBe(false);
  });
});
