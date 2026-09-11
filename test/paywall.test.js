'use strict';
/**
 * Paywall helper unit tests (no DB) — module shape + export contract.
 */
const assert = require('assert');
const path = require('path');

describe('paywall module', () => {
  it('exports lookup and paid helpers', () => {
    const paywall = require(path.join(__dirname, '../lib/auth/paywall'));
    assert.strictEqual(typeof paywall.findUnclaimedPendingBySession, 'function');
    assert.strictEqual(typeof paywall.findUnclaimedPendingByEmail, 'function');
    assert.strictEqual(typeof paywall.hasPaidSubscription, 'function');
  });
});
