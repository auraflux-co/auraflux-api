'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { resolveTwitchLogin, extractStreamersFromText, resetStreamerLoginIndexForTests } = require('../lib/streamer_login');

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

  // CPD-1219 — roster-driven streamer extraction from competitor video titles
  describe('extractStreamersFromText', () => {
    it('finds a roster streamer named as one word', () => {
      resetStreamerLoginIndexForTests();
      assert.deepEqual(extractStreamersFromText('ExtraEmily FREAKS OUT on stream 😱'), ['extraemily']);
    });

    it('joins adjacent words so "Extra Emily" matches extraemily', () => {
      resetStreamerLoginIndexForTests();
      assert.ok(extractStreamersFromText('Extra Emily cannot believe this').includes('extraemily'));
    });

    it('resolves alias traps to the canonical login', () => {
      resetStreamerLoginIndexForTests();
      assert.ok(extractStreamersFromText('Jason gets caught lacking').includes('jasontheween'));
    });

    it('skips aliases under 4 chars to avoid common-word false positives', () => {
      resetStreamerLoginIndexForTests();
      assert.ok(!extractStreamersFromText('Ron grabs a TV').includes('stableronaldo'));
    });

    it('returns empty array for empty or unrelated text', () => {
      resetStreamerLoginIndexForTests();
      assert.deepEqual(extractStreamersFromText(''), []);
      assert.deepEqual(extractStreamersFromText('completely unrelated video title'), []);
    });
  });
});
