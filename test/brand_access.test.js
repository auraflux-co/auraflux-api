'use strict';
/**
 * test/brand_access.test.js — Unit tests for lib/auth/brand_access.js (CPD-863)
 *
 * Tests resolveBrandContext middleware: brand ownership validation,
 * fallback behaviour, and non-fatal error handling.
 */

jest.mock('../lib/db/postgres', () => ({
  getBrand: jest.fn(),
  getBrandsForAccount: jest.fn(),
  getClientPlanByBrand: jest.fn(),
}));

jest.mock('../lib/error_logger', () => ({
  logError: jest.fn(),
}));

const { getBrand, getBrandsForAccount, getClientPlanByBrand } = require('../lib/db/postgres');
const { logError } = require('../lib/error_logger');
const { resolveBrandContext } = require('../lib/auth/brand_access');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeReq(opts = {}) {
  return {
    user: 'user' in opts ? opts.user : { id: 'acct-1' },
    headers: opts.headers ?? {},
    brandId: undefined,
    brandPlan: undefined,
  };
}

function makeRes() {
  const res = { _status: null, _body: null };
  res.status = (code) => { res._status = code; return res; };
  res.json   = (body)  => { res._body  = body;  return res; };
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── No authenticated user ────────────────────────────────────────────────────

describe('resolveBrandContext — no authenticated user', () => {
  it('calls next() immediately when req.user is absent', async () => {
    const req  = makeReq({ user: null });
    const res  = makeRes();
    const next = jest.fn();

    await resolveBrandContext(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(getBrand).not.toHaveBeenCalled();
    expect(getBrandsForAccount).not.toHaveBeenCalled();
  });
});

// ─── Explicit X-Brand-Id header ───────────────────────────────────────────────

describe('resolveBrandContext — explicit X-Brand-Id header', () => {
  it('sets req.brandId and req.brandPlan when brand ownership is valid', async () => {
    const brand = { id: 'brand-42' };
    const plan  = { plan_tier: 'guided' };
    getBrand.mockResolvedValue(brand);
    getClientPlanByBrand.mockResolvedValue(plan);

    const req  = makeReq({ headers: { 'x-brand-id': 'brand-42' } });
    const res  = makeRes();
    const next = jest.fn();

    await resolveBrandContext(req, res, next);

    expect(getBrand).toHaveBeenCalledWith('brand-42', 'acct-1');
    expect(getClientPlanByBrand).toHaveBeenCalledWith('brand-42');
    expect(req.brandId).toBe('brand-42');
    expect(req.brandPlan).toBe(plan);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('returns 403 when brand does not belong to the account', async () => {
    getBrand.mockResolvedValue(null);

    const req  = makeReq({ headers: { 'x-brand-id': 'brand-other' } });
    const res  = makeRes();
    const next = jest.fn();

    await resolveBrandContext(req, res, next);

    expect(res._status).toBe(403);
    expect(res._body).toMatchObject({ ok: false, error: 'brand_access_denied' });
    expect(next).not.toHaveBeenCalled();
  });
});

// ─── No header — fallback behaviour ──────────────────────────────────────────

describe('resolveBrandContext — no header (fallback)', () => {
  it('falls back to first brand when account has brands', async () => {
    const brands = [{ id: 'brand-1' }, { id: 'brand-2' }];
    const plan   = { plan_tier: 'operate' };
    getBrandsForAccount.mockResolvedValue(brands);
    getClientPlanByBrand.mockResolvedValue(plan);

    const req  = makeReq();
    const res  = makeRes();
    const next = jest.fn();

    await resolveBrandContext(req, res, next);

    expect(getBrandsForAccount).toHaveBeenCalledWith('acct-1');
    expect(getClientPlanByBrand).toHaveBeenCalledWith('brand-1');
    expect(req.brandId).toBe('brand-1');
    expect(req.brandPlan).toBe(plan);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('sets brandId/brandPlan to null for legacy accounts with no brand rows', async () => {
    getBrandsForAccount.mockResolvedValue([]);

    const req  = makeReq();
    const res  = makeRes();
    const next = jest.fn();

    await resolveBrandContext(req, res, next);

    expect(req.brandId).toBeNull();
    expect(req.brandPlan).toBeNull();
    expect(next).toHaveBeenCalledTimes(1);
  });
});

// ─── DB error — non-fatal ─────────────────────────────────────────────────────

describe('resolveBrandContext — DB error', () => {
  it('calls next() and logs error when DB throws — middleware is non-fatal', async () => {
    const boom = new Error('db timeout');
    getBrandsForAccount.mockRejectedValue(boom);

    const req  = makeReq();
    const res  = makeRes();
    const next = jest.fn();

    await resolveBrandContext(req, res, next);

    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining('[brand_access]'),
      boom,
    );
    expect(next).toHaveBeenCalledTimes(1);
    expect(res._status).toBeNull();
  });
});
