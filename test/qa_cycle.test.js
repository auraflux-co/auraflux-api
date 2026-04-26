'use strict';

const qaCycle = require('../lib/qa_cycle');

describe('qa_cycle describeFromSendbackIndex', () => {
  const prevWorker = process.env.QA_MAX_WORKER_SENDBACKS;
  const prevInt = process.env.QA_MAX_INTERVENTION_ATTEMPTS;

  afterEach(() => {
    process.env.QA_MAX_WORKER_SENDBACKS = prevWorker;
    process.env.QA_MAX_INTERVENTION_ATTEMPTS = prevInt;
  });

  test('defaults 3+3: worker 1→3, intervention 4→5, kill on 6', () => {
    delete process.env.QA_MAX_WORKER_SENDBACKS;
    delete process.env.QA_MAX_INTERVENTION_ATTEMPTS;

    expect(qaCycle.describeFromSendbackIndex(1).phase).toBe('worker');
    expect(qaCycle.describeFromSendbackIndex(3).phase).toBe('worker');
    expect(qaCycle.describeFromSendbackIndex(4).phase).toBe('intervention');
    expect(qaCycle.describeFromSendbackIndex(4).interventionAttempt).toBe(1);
    expect(qaCycle.describeFromSendbackIndex(5).shouldKill).toBe(false);
    expect(qaCycle.describeFromSendbackIndex(6).shouldKill).toBe(true);
  });

  test('limits() reads env', () => {
    process.env.QA_MAX_WORKER_SENDBACKS = '2';
    process.env.QA_MAX_INTERVENTION_ATTEMPTS = '2';
    const L = qaCycle.limits();
    expect(L.worker).toBe(2);
    expect(L.intervention).toBe(2);
    expect(L.maxTotal).toBe(4);
  });
});

describe('qa_cycle gateKey', () => {
  test('normalizes gate labels', () => {
    expect(qaCycle.gateKey('gate1')).toBe('1');
    expect(qaCycle.gateKey(1)).toBe('1');
    expect(qaCycle.gateKey(3)).toBe('3');
  });
});

describe('qa_cycle tier constants', () => {
  test('Tier 1 / Tier 2 numeric ids', () => {
    expect(qaCycle.QA_TIER_REVIEW).toBe(1);
    expect(qaCycle.QA_TIER_OPS).toBe(2);
  });
});
