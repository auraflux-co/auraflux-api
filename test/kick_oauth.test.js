'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { isRetryableKickTokenError } = require('../lib/publish/adapters/kick_oauth');

describe('kick_oauth token retry', () => {
  it('retries only transient network errors, not HTTP auth failures', () => {
    assert.equal(isRetryableKickTokenError(new Error('Premature close')), true);
    assert.equal(isRetryableKickTokenError(new Error('read ECONNRESET')), true);
    assert.equal(isRetryableKickTokenError(new Error('Kick token request timeout')), true);
    assert.equal(isRetryableKickTokenError(new Error('Kick token exchange failed (400): invalid_grant')), false);
    assert.equal(isRetryableKickTokenError(new Error('Kick authorization code invalid or already used')), false);
    assert.equal(isRetryableKickTokenError(new Error('Kick token exchange unauthorized (401)')), false);
  });
});
