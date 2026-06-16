'use strict';

const { assertPublishReadiness } = require('../lib/services/approve_publish');

describe('assertPublishReadiness (CPD-1045)', () => {
  const goodSpec = {
    status: 'complete',
    grade: 100,
    gradeResult: { passed: true },
    state: { chromeApplied: true },
    processingManifest: { featuresOrdered: ['captions'], featuresApplied: ['captions'] },
  };

  test('passes when chrome and features OK', () => {
    const r = assertPublishReadiness(goodSpec);
    expect(r.ok).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  test('blocks when chrome required but chromeApplied false', () => {
    const r = assertPublishReadiness({
      ...goodSpec,
      brandId: 'test-brand',
      state: { chromeApplied: false },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('chromeApplied'))).toBe(true);
  });

  test('allows chromeSkipped clip path', () => {
    const r = assertPublishReadiness({
      ...goodSpec,
      productionPath: 'short_compile_clips',
      state: { chromeApplied: false, chromeSkipped: true },
    });
    expect(r.ok).toBe(true);
  });

  test('allows operator_review status — approve-publish is the review action', () => {
    const r = assertPublishReadiness({ ...goodSpec, status: 'operator_review', grade: 90, gradeResult: { passed: false } });
    expect(r.ok).toBe(true);
  });

  test('blocks grade below 75 without force', () => {
    const r = assertPublishReadiness({ ...goodSpec, grade: 60, gradeResult: { passed: false } });
    expect(r.ok).toBe(false);
  });

  test('matches feature base keys (captions:animated vs captions)', () => {
    const r = assertPublishReadiness({
      ...goodSpec,
      processingManifest: { featuresOrdered: ['captions:animated'], featuresApplied: ['captions'] },
    });
    expect(r.ok).toBe(true);
  });

  test('operator forceApprove bypasses grade hold', () => {
    const r = assertPublishReadiness(
      { ...goodSpec, grade: 40, gradeResult: { passed: false } },
      { forceApprove: true }
    );
    expect(r.ok).toBe(true);
  });
});
