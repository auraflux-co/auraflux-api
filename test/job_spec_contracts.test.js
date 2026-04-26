'use strict';

const mockSpecStore = {};

function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function mockDeepMerge(target, source) {
  if (!isObject(source)) return source;
  const out = isObject(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(source)) {
    if (isObject(v)) out[k] = mockDeepMerge(out[k], v);
    else out[k] = v;
  }
  return out;
}

jest.mock('../lib/job_spec', () => ({
  getJobSpec: (jobId) => mockSpecStore[jobId] || null,
  updateJobSpec: (jobId, patch) => {
    const current = mockSpecStore[jobId] || { jobId, state: { gateResults: {}, savedOutputs: {} } };
    const next = mockDeepMerge(current, patch || {});
    mockSpecStore[jobId] = next;
    return next;
  }
}));

const {
  persistJobSpecGateContracts,
  preflightGateExecution,
  auditAndRecordGateResult
} = require('../lib/job_spec_contracts');

function seedSpec(overrides = {}) {
  const jobId = overrides.jobId || 'job_contract_test_1';
  mockSpecStore[jobId] = mockDeepMerge({
    jobId,
    customerId: 'c0',
    templateId: 'long-form',
    contentType: 'news',
    order: {
      inputs: {
        sourceType: 'url_list',
        items: [],
        itemCount: 0
      },
      output: {
        aspectRatio: '16:9',
        resolution: { width: 1920, height: 1080 }
      }
    },
    designSpec: {
      expectedClipCount: 3,
      chrome: { skin: 'news' },
      qaThresholds: { gate1: { pass: 90 } },
      sceneStructure: {
        items: [
          { label: 'Story A', data: { title: 'Story A' } },
          { label: 'Story B', data: { title: 'Story B' } }
        ]
      }
    },
    deliverySpec: { platforms: ['youtube'] },
    state: {
      gateResults: {},
      savedOutputs: {}
    }
  }, overrides);
  return jobId;
}

describe('job_spec_contracts (offline artifact simulation)', () => {
  beforeEach(() => {
    Object.keys(mockSpecStore).forEach((k) => delete mockSpecStore[k]);
  });

  test('persists baseline and per-gate worker contracts from a sample artifact', () => {
    const jobId = seedSpec();
    const updated = persistJobSpecGateContracts(mockSpecStore[jobId], {
      gate0: { ready: true, commitment: { summary: 'source confirmed' } },
      gate1: { ready: true, commitment: { summary: 'script qa ready' } }
    });

    expect(updated.state.gateContracts).toBeTruthy();
    expect(updated.state.gateContracts.baseline.ordered.aspectRatio).toBe('16:9');
    expect(updated.state.gateContracts.gates.gate0.signedOffReady).toBe(true);
    expect(updated.state.gateContracts.gates.gate1.commitSummary).toBe('script qa ready');
  });

  test('gate preflight soft-heals missing ordered items and enforces prerequisites', () => {
    const jobId = seedSpec();
    persistJobSpecGateContracts(mockSpecStore[jobId], {});

    // Gate 1 only requires gate0; with no gate0 result this is a prereq warning.
    const g1 = preflightGateExecution({ jobId, gate: 'gate1' });
    expect(g1.softHeals.length).toBeGreaterThan(0);
    expect(g1.reasons.join(';')).toContain('prerequisite gate0');
    expect(mockSpecStore[jobId].order.inputs.items.length).toBeGreaterThan(0);

    // Mark gate0 pass and then gate2 should block on missing gate1.
    mockSpecStore[jobId].state.gateResults.gate0 = { passed: true, outcome: 'pass' };
    const g2 = preflightGateExecution({ jobId, gate: 'gate2' });
    expect(g2.ready).toBe(false);
    expect(g2.reasons.join(';')).toContain('prerequisite gate1');
  });

  test('end-of-gate QA audit records cumulative fail when final-output prereqs missing', () => {
    const jobId = seedSpec({
      state: {
        gateResults: {
          gate0: { passed: true, outcome: 'pass' },
          gate1: { passed: true, outcome: 'pass' },
          gate2: { passed: true, outcome: 'pass' },
          gate3a: { passed: true, outcome: 'pass' },
          gate3b: { passed: true, outcome: 'pass' }
        },
        savedOutputs: {}
      }
    });
    persistJobSpecGateContracts(mockSpecStore[jobId], {});

    const r = auditAndRecordGateResult({
      jobId,
      gate: 'gate4',
      result: { gate: 'gate4', passed: false, outcome: 'hard_fail' }
    });

    expect(r.status).toBe('fail');
    expect(r.issues.join(';')).toContain('assembled output path missing');
    expect(mockSpecStore[jobId].state.gateContracts.cumulative.status).toBe('fail');
  });

  test('happy path: sequential gate audits with assembled file → cumulative pass', () => {
    const jobId = seedSpec({
      jobId: 'job_happy_path',
      order: {
        inputs: { sourceType: 'url_list', items: [{ title: 'T1' }], itemCount: 1 },
        output: { aspectRatio: '16:9', resolution: { width: 1920, height: 1080 } }
      },
      state: {
        savedOutputs: { assembledPath: '/tmp/out/final.mp4' },
        gateResults: {}
      }
    });
    persistJobSpecGateContracts(mockSpecStore[jobId], {});

    const chain = ['gate0', 'gate1', 'gate2', 'gate3a', 'gate3b', 'gate4', 'gate5'];
    for (const g of chain) {
      mockSpecStore[jobId].state.gateResults[g] = { passed: true, outcome: 'pass' };
      auditAndRecordGateResult({
        jobId,
        gate: g,
        result: { gate: g, passed: true, outcome: 'pass', score: 95 }
      });
    }

    expect(mockSpecStore[jobId].state.gateContracts.cumulative.status).toBe('pass');
    expect(mockSpecStore[jobId].state.gateContracts.qaByGate.gate5.status).toBe('pass');
  });

  test('online-style drift: delivery platforms change after baseline → gate5 audit warns', () => {
    const jobId = seedSpec({
      jobId: 'job_platform_drift',
      state: {
        savedOutputs: { assembledPath: '/tmp/assembled.mp4' },
        gateResults: {
          gate0: { passed: true, outcome: 'pass' },
          gate1: { passed: true, outcome: 'pass' },
          gate2: { passed: true, outcome: 'pass' },
          gate3a: { passed: true, outcome: 'pass' },
          gate3b: { passed: true, outcome: 'pass' },
          gate4: { passed: true, outcome: 'pass' }
        }
      }
    });
    persistJobSpecGateContracts(mockSpecStore[jobId], {});
    mockSpecStore[jobId].deliverySpec = { platforms: ['youtube', 'tiktok'] };

    const r = auditAndRecordGateResult({
      jobId,
      gate: 'gate5',
      result: { gate: 'gate5', passed: true, outcome: 'pass' }
    });

    expect(r.status).toBe('warn');
    expect(r.issues.some(i => i.includes('platforms drifted'))).toBe(true);
    expect(mockSpecStore[jobId].state.gateContracts.cumulative.status).toBe('warn');
  });

  test('no soft-heal: empty order items and empty sceneStructure → nothing to hydrate', () => {
    const jobId = seedSpec({
      jobId: 'job_no_heal',
      designSpec: {
        expectedClipCount: 1,
        chrome: { skin: 'news' },
        qaThresholds: {},
        sceneStructure: { items: [] }
      },
      order: {
        inputs: { sourceType: 'url_list', items: [], itemCount: 0 },
        output: { aspectRatio: '16:9', resolution: { width: 1920, height: 1080 } }
      }
    });
    persistJobSpecGateContracts(mockSpecStore[jobId], {});

    const g1 = preflightGateExecution({ jobId, gate: 'gate1' });
    expect(g1.softHeals.length).toBe(0);
    expect(g1.reasons.join(';')).toContain('prerequisite gate0');
  });

  test('recovery scenario: first gate4 audit fails missing file; after write, gate5 passes clean', () => {
    const jobId = seedSpec({
      jobId: 'job_recovery',
      state: {
        gateResults: {
          gate0: { passed: true, outcome: 'pass' },
          gate1: { passed: true, outcome: 'pass' },
          gate2: { passed: true, outcome: 'pass' },
          gate3a: { passed: true, outcome: 'pass' },
          gate3b: { passed: true, outcome: 'pass' }
        },
        savedOutputs: {}
      }
    });
    persistJobSpecGateContracts(mockSpecStore[jobId], {});

    auditAndRecordGateResult({
      jobId,
      gate: 'gate4',
      result: { gate: 'gate4', passed: false, outcome: 'hard_fail' }
    });
    expect(mockSpecStore[jobId].state.gateContracts.cumulative.status).toBe('fail');

    mockSpecStore[jobId].state.savedOutputs.assembledPath = '/tmp/recovered_final.mp4';
    mockSpecStore[jobId].state.gateResults.gate4 = { passed: true, outcome: 'pass' };

    auditAndRecordGateResult({
      jobId,
      gate: 'gate5',
      result: { gate: 'gate5', passed: true, outcome: 'pass' }
    });

    expect(mockSpecStore[jobId].state.gateContracts.qaByGate.gate5.status).toBe('pass');
    expect(mockSpecStore[jobId].state.gateContracts.cumulative.status).not.toBe('pass');
    expect(mockSpecStore[jobId].state.gateContracts.cumulative.issues.length).toBeGreaterThan(0);
  });

  test('offline vs online: contract layer reasons we compare artifacts to prod', () => {
    const offlineAssumptions = [
      'JSON jobSpec is self-consistent (no partial DB rows or stale PM2 memory)',
      'No concurrent writers mutating jobSpec between gates',
      'No external APIs (Gemini/Claude/HeyGen/ffprobe) — scores and paths are injected',
      'Soft-heal only covers known gaps (e.g. items vs sceneStructure), not CDN or auth failures'
    ];
    const onlineRiskFactors = [
      'Race: script job vs semantic job id handoff can desync gateResults visibility',
      'Env: AUTO_PUBLISH_PLATFORMS or similar can change deliverySpec after baseline',
      'Flaky vision QA: same pixel output can score differently across model calls',
      'Assembly continues on some gate2 hard-fails — audit warns while video still renders'
    ];
    expect(offlineAssumptions.length).toBeGreaterThan(0);
    expect(onlineRiskFactors.length).toBeGreaterThan(0);
  });

  test('script/semantic id desync simulation: semantic job preflight blocks until gate history is copied', () => {
    const scriptJobId = seedSpec({
      jobId: 'script_1001',
      state: {
        gateResults: {
          gate0: { passed: true, outcome: 'pass' },
          gate1: { passed: true, outcome: 'pass' }
        },
        savedOutputs: {}
      }
    });
    const semanticJobId = seedSpec({
      jobId: 'c0_COMPACT_FETCH_news_1001',
      state: {
        gateResults: {},
        savedOutputs: {}
      }
    });

    persistJobSpecGateContracts(mockSpecStore[semanticJobId], {});
    const beforeCopy = preflightGateExecution({ jobId: semanticJobId, gate: 'gate2' });
    expect(beforeCopy.ready).toBe(false);
    expect(beforeCopy.reasons.join(';')).toContain('prerequisite gate1');

    mockSpecStore[semanticJobId].state.gateResults = { ...mockSpecStore[scriptJobId].state.gateResults };
    const afterCopy = preflightGateExecution({ jobId: semanticJobId, gate: 'gate2' });
    expect(afterCopy.ready).toBe(true);
    expect(afterCopy.reasons.length).toBe(0);
  });
});

