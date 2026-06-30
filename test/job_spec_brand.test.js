'use strict';

jest.mock('../lib/db', () => ({
  saveJob: jest.fn().mockResolvedValue(undefined),
  updateJobSpec: jest.fn().mockResolvedValue(undefined),
}));

const { createJobSpec } = require('../lib/job_spec');

describe('createJobSpec brand context (CPD-1185)', () => {
  test('persists brandId and brandName on jobSpec', () => {
    const spec = createJobSpec({
      customerId: 'cust_abc',
      contentType: 'clips-short',
      brandId: 'brand_natashaughey',
      brandName: 'natashaughey',
    });

    expect(spec.brandId).toBe('brand_natashaughey');
    expect(spec.brandName).toBe('natashaughey');
  });

  test('brandId defaults to null when omitted', () => {
    const spec = createJobSpec({
      customerId: 'cust_abc',
      contentType: 'news',
    });

    expect(spec.brandId).toBeNull();
    expect(spec.brandName).toBeNull();
  });
});
