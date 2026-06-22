'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Inline mirror of kick_oauth retry matcher (keep in sync if exported later)
function isRetryableKickTokenError(err) {
  const msg = err?.message || String(err);
  return /premature close|ECONNRESET|ETIMEDOUT|socket hang up|network timeout|fetch failed/i.test(msg);
}

describe('kick_oauth token retry', () => {
  it('retries on premature close and transient network errors', () => {
    assert.equal(isRetryableKickTokenError(new Error('Premature close')), true);
    assert.equal(isRetryableKickTokenError(new Error('read ECONNRESET')), true);
    assert.equal(isRetryableKickTokenError(new Error('Kick token exchange failed (400): invalid_grant')), false);
    assert.equal(isRetryableKickTokenError(new Error('Kick authorization code invalid or already used')), false);
  });
});
