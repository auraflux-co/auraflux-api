'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createBasicAuthMiddleware,
  createBasicAuthFromEnv,
  basicAuthEnabled,
  isExemptPath,
  parseBasicAuth,
  parseExemptPaths,
  DEFAULT_EXEMPT,
} = require('../lib/basic_auth_middleware');
const { c0AuthHeaders, withC0Auth } = require('../lib/c0_internal_fetch');

function mockRes() {
  const r = {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    type() { return this; },
    send(b) { this.body = b; return this; },
  };
  return r;
}

describe('basic_auth_middleware', () => {
  it('parses Basic credentials', () => {
    const tok = Buffer.from('rob:secret', 'utf8').toString('base64');
    assert.deepEqual(parseBasicAuth(`Basic ${tok}`), { user: 'rob', pass: 'secret' });
    assert.equal(parseBasicAuth(null), null);
  });

  it('exempts /health and OAuth callbacks', () => {
    assert.equal(isExemptPath('/health', DEFAULT_EXEMPT), true);
    assert.equal(isExemptPath('/connect/youtube/callback', DEFAULT_EXEMPT), true);
    assert.equal(isExemptPath('/jobs', DEFAULT_EXEMPT), false);
  });

  it('returns 401 without auth when enabled', () => {
    const mw = createBasicAuthMiddleware({ user: 'rob', pass: 'x' });
    const req = { method: 'GET', path: '/', headers: {} };
    const res = mockRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.ok(String(res.headers['WWW-Authenticate'] || '').includes('Basic'));
  });

  it('allows valid Basic credentials', () => {
    const mw = createBasicAuthMiddleware({ user: 'rob', pass: 'x' });
    const tok = Buffer.from('rob:x', 'utf8').toString('base64');
    const req = { method: 'GET', path: '/', headers: { authorization: `Basic ${tok}` } };
    const res = mockRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, 200);
  });

  it('skips /health without credentials', () => {
    const mw = createBasicAuthMiddleware({ user: 'rob', pass: 'x' });
    const req = { method: 'GET', path: '/health', headers: {} };
    const res = mockRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
  });

  it('skips auth for localhost Host (operator machine)', () => {
    const mw = createBasicAuthMiddleware({ user: 'rob', pass: 'x' });
    const req = { method: 'GET', path: '/', headers: { host: 'localhost:3000' } };
    const res = mockRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
  });

  it('requires auth for tunnel Host', () => {
    const mw = createBasicAuthMiddleware({ user: 'rob', pass: 'x' });
    const req = {
      method: 'GET',
      path: '/',
      headers: { host: 'supported-bundle-blowing-clothing.trycloudflare.com' },
    };
    const res = mockRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
  });

  it('rejects wrong password', () => {
    const mw = createBasicAuthMiddleware({ user: 'rob', pass: 'x' });
    const tok = Buffer.from('rob:wrong', 'utf8').toString('base64');
    const req = { method: 'GET', path: '/', headers: { authorization: `Basic ${tok}` } };
    const res = mockRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
  });

  it('createBasicAuthFromEnv is null when unset', () => {
    const prevU = process.env.BASIC_AUTH_USER;
    const prevP = process.env.BASIC_AUTH_PASS;
    delete process.env.BASIC_AUTH_USER;
    delete process.env.BASIC_AUTH_PASS;
    assert.equal(basicAuthEnabled(), false);
    assert.equal(createBasicAuthFromEnv(), null);
    if (prevU != null) process.env.BASIC_AUTH_USER = prevU;
    if (prevP != null) process.env.BASIC_AUTH_PASS = prevP;
  });

  it('parseExemptPaths honors custom list', () => {
    assert.deepEqual(parseExemptPaths('/a,/b'), ['/a', '/b']);
  });
});

describe('c0_internal_fetch', () => {
  it('c0AuthHeaders empty when auth off', () => {
    const prevU = process.env.BASIC_AUTH_USER;
    const prevP = process.env.BASIC_AUTH_PASS;
    delete process.env.BASIC_AUTH_USER;
    delete process.env.BASIC_AUTH_PASS;
    assert.deepEqual(c0AuthHeaders(), {});
    if (prevU != null) process.env.BASIC_AUTH_USER = prevU;
    if (prevP != null) process.env.BASIC_AUTH_PASS = prevP;
  });

  it('c0AuthHeaders sets Basic when enabled', () => {
    const prevU = process.env.BASIC_AUTH_USER;
    const prevP = process.env.BASIC_AUTH_PASS;
    process.env.BASIC_AUTH_USER = 'u1';
    process.env.BASIC_AUTH_PASS = 'p1';
    const h = c0AuthHeaders();
    assert.ok(h.Authorization);
    assert.equal(h.Authorization, 'Basic ' + Buffer.from('u1:p1').toString('base64'));
    const cfg = withC0Auth({ timeout: 1, headers: { 'X-A': '1' } });
    assert.equal(cfg.headers['X-A'], '1');
    assert.ok(cfg.headers.Authorization);
    if (prevU != null) process.env.BASIC_AUTH_USER = prevU; else delete process.env.BASIC_AUTH_USER;
    if (prevP != null) process.env.BASIC_AUTH_PASS = prevP; else delete process.env.BASIC_AUTH_PASS;
  });
});
