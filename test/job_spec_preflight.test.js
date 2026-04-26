'use strict';

const { validateForScriptPipeline } = require('../lib/job_spec_preflight');

describe('job_spec_preflight', () => {
  test('accepts minimal valid spec', () => {
    const r = validateForScriptPipeline({
      jobId: 'script_test_1',
      customerId: 'c0',
      contentType: 'news',
      order: { inputs: { items: [{ title: 'a' }] } }
    });
    expect(r.ok).toBe(true);
    expect(r.errors.length).toBe(0);
  });

  test('rejects empty items', () => {
    const r = validateForScriptPipeline({
      jobId: 'x',
      customerId: 'c0',
      contentType: 'news',
      order: { inputs: { items: [] } }
    });
    expect(r.ok).toBe(false);
  });
});
