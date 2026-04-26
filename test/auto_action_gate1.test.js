'use strict';

const { autoAction } = require('../lib/qa');

describe('autoAction gate 1', () => {
  test('proceeds when gate1Passed even if score < 90', () => {
    const r = autoAction(1, 72, { gate1Passed: true });
    expect(r.action).toBe('proceed');
  });

  test('regenerate when not passed and score < 90', () => {
    const r = autoAction(1, 72, { gate1Passed: false, retryCount: 0 });
    expect(r.action).toBe('regenerate_script');
  });

  test('proceed when score >= 90 without gate1Passed', () => {
    const r = autoAction(1, 92, { gate1Passed: false });
    expect(r.action).toBe('proceed');
  });
});
