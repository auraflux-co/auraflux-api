'use strict';

const {
  operatorAuthorized,
  operatorAuthRequired,
  createOAuthState,
  consumeOAuthState,
} = require('../lib/broadcast/operator_auth');

function mockReq({ auth, query = {}, headers = {} } = {}) {
  return {
    headers: auth ? { authorization: `Bearer ${auth}`, ...headers } : headers,
    query,
  };
}

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(o) { this.body = o; return this; },
    send(s) { this.body = s; return this; },
  };
}

describe('operator_auth', () => {
  beforeEach(() => {
    delete process.env.BROADCAST_OPERATOR_SECRET;
    delete process.env.BROADCAST_OPERATOR_AUTH;
    delete process.env.RENDER;
  });

  test('local dev allows when secret unset and not on Render', () => {
    expect(operatorAuthRequired()).toBe(false);
    expect(operatorAuthorized(mockReq())).toBe(true);
  });

  test('Render requires secret', () => {
    process.env.RENDER = 'true';
    expect(operatorAuthRequired()).toBe(true);
    expect(operatorAuthorized(mockReq())).toBe(false);
  });

  test('bearer token matches secret', () => {
    process.env.BROADCAST_OPERATOR_SECRET = 'test-secret';
    process.env.RENDER = 'true';
    expect(operatorAuthorized(mockReq({ auth: 'test-secret' }))).toBe(true);
    expect(operatorAuthorized(mockReq({ auth: 'wrong' }))).toBe(false);
  });

  test('OAuth state single use', () => {
    const state = createOAuthState();
    expect(consumeOAuthState(state)).toBe(true);
    expect(consumeOAuthState(state)).toBe(false);
  });
});
