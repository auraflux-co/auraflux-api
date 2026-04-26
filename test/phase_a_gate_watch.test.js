'use strict';

const { summarizeGates, GATE_ORDER } = require('../scripts/phase_a_gate_watch.cjs');

describe('phase_a_gate_watch summarizeGates', () => {
  test('lists every gate in order with pending for missing', () => {
    const s = summarizeGates({});
    expect(GATE_ORDER.every((g) => s.includes(`${g}:pending`))).toBe(true);
  });

  test('shows ok with score and outcome', () => {
    const s = summarizeGates({
      gate0: { passed: true },
      gate1: { passed: true, score: 100, outcome: 'pass' }
    });
    expect(s).toContain('gate0:ok');
    expect(s).toContain('gate1:ok(100:pass)');
    expect(s).toContain('gate2:pending');
  });

  test('shows fail with outcome', () => {
    const s = summarizeGates({
      gate1: { passed: false, outcome: 'hard_fail' }
    });
    expect(s).toContain('gate1:fail(hard_fail)');
  });
});
