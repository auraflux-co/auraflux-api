'use strict';

describe('qa_generate_confirm', () => {
  const prev = process.env.QA_CONFIRM_ON_GENERATE;

  afterEach(() => {
    if (prev === undefined) delete process.env.QA_CONFIRM_ON_GENERATE;
    else process.env.QA_CONFIRM_ON_GENERATE = prev;
  });

  test('isPolicyEnabled follows env', () => {
    delete process.env.QA_CONFIRM_ON_GENERATE;
    const q = require('../lib/qa_generate_confirm');
    expect(q.isPolicyEnabled()).toBe(false);
    process.env.QA_CONFIRM_ON_GENERATE = 'true';
    expect(q.isPolicyEnabled()).toBe(true);
  });

  test('requestSaysConfirmed', () => {
    const q = require('../lib/qa_generate_confirm');
    expect(q.requestSaysConfirmed({})).toBe(false);
    expect(q.requestSaysConfirmed({ qaGenerateConfirmed: true })).toBe(true);
    expect(q.requestSaysConfirmed({ qaGenerateConfirm: true })).toBe(true);
  });
});
