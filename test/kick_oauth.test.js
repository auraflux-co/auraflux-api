'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { isRetryableKickTokenError, parseKickProfile } = require('../lib/publish/adapters/kick_oauth');

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

describe('kick_oauth parseKickProfile', () => {
  it('reads slug from GET /channels payload', () => {
    const parsed = parseKickProfile({
      data: [{ slug: 'clipzworldnews', broadcaster_user_id: 12345 }],
    });
    assert.equal(parsed.platformHandle, 'clipzworldnews');
    assert.equal(parsed.platformUserId, '12345');
  });

  it('falls back to user name from GET /users payload', () => {
    const parsed = parseKickProfile({
      data: [{ name: 'ClipzWorld', user_id: 99 }],
    });
    assert.equal(parsed.platformHandle, 'ClipzWorld');
    assert.equal(parsed.platformUserId, '99');
  });
});
