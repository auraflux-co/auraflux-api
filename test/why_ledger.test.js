'use strict';

const { inferFailureClass, FAILURE_CLASS } = require('../lib/why_ledger');

describe('why_ledger inferFailureClass', () => {
  test('production defects from infra / API wording', () => {
    expect(inferFailureClass({ reason: 'ffmpeg timeout ECONNRESET' }))
      .toBe(FAILURE_CLASS.PRODUCTION_DEFECT);
    expect(inferFailureClass({ reason: 'HeyGen 503 unavailable' }))
      .toBe(FAILURE_CLASS.PRODUCTION_DEFECT);
  });

  test('QA input defects when evidence chain is named', () => {
    expect(inferFailureClass({
      deductions: [{ reason: 'Score cannot be verified against clip analysis' }]
    })).toBe(FAILURE_CLASS.QA_INPUT_DEFECT);
    expect(inferFailureClass({ reason: 'authorized facts missing for story' }))
      .toBe(FAILURE_CLASS.QA_INPUT_DEFECT);
  });

  test('spec violations for voice / structure wording', () => {
    expect(inferFailureClass({ deductions: [{ reason: 'Locked intro text incorrect' }] }))
      .toBe(FAILURE_CLASS.SPEC_VIOLATION);
    expect(inferFailureClass({ concerns: ['fabrication in recap'] }))
      .toBe(FAILURE_CLASS.SPEC_VIOLATION);
  });

  test('unknown when nothing matches', () => {
    expect(inferFailureClass({ reason: 'Something went wrong' }))
      .toBe(FAILURE_CLASS.UNKNOWN);
  });
});
