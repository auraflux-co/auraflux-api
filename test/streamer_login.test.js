'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { resolveTwitchLogin, resetStreamerLoginIndexForTests } = require('../lib/streamer_login');

describe('streamer_login', () => {
  it('maps on-air Yonna to yonnajay not yonna', () => {
    resetStreamerLoginIndexForTests();
    assert.equal(resolveTwitchLogin('Yonna'), 'yonnajay');
    assert.equal(resolveTwitchLogin('yonna'), 'yonnajay');
    assert.equal(resolveTwitchLogin('yonnajay'), 'yonnajay');
    assert.equal(resolveTwitchLogin('@YonnaJay'), 'yonnajay');
  });

  it('maps Ron to stableronaldo', () => {
    resetStreamerLoginIndexForTests();
    assert.equal(resolveTwitchLogin('Ron'), 'stableronaldo');
  });
});
