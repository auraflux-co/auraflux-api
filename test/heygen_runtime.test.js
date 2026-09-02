'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

describe('heygen_runtime', () => {
  let prev;
  before(() => {
    prev = process.env.HEYGEN_LIVE;
  });
  after(() => {
    if (prev === undefined) delete process.env.HEYGEN_LIVE;
    else process.env.HEYGEN_LIVE = prev;
  });

  it('defaults to live OFF', () => {
    delete process.env.HEYGEN_LIVE;
    const { isHeyGenLiveEnabled, heygenLiveDisabledReason } = require('../lib/heygen_runtime');
    assert.equal(isHeyGenLiveEnabled(), false);
    assert.match(heygenLiveDisabledReason(), /HEYGEN_LIVE/);
  });

  it('enables when HEYGEN_LIVE=on', () => {
    process.env.HEYGEN_LIVE = 'on';
    // clear require cache so env is re-read (module is pure functions — no cache needed)
    const { isHeyGenLiveEnabled } = require('../lib/heygen_runtime');
    assert.equal(isHeyGenLiveEnabled(), true);
  });
});
