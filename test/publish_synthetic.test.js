'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveSyntheticMediaFlags } = require('../lib/publish_synthetic');

test('twitch-short clip comp is not synthetic', () => {
  const f = resolveSyntheticMediaFlags({ jobType: 'twitch-short' });
  assert.equal(f.isAigc, false);
  assert.equal(f.containsSyntheticMedia, false);
});

test('twitch long VOD with avatar is synthetic', () => {
  const f = resolveSyntheticMediaFlags({ jobType: 'twitch' });
  assert.equal(f.isAigc, true);
});

test('explicit isAigc override wins', () => {
  assert.equal(resolveSyntheticMediaFlags({ jobType: 'twitch', isAigc: false }).isAigc, false);
  assert.equal(resolveSyntheticMediaFlags({ jobType: 'twitch-short', isAigc: true }).isAigc, true);
});

test('heygenUsed forces synthetic', () => {
  assert.equal(resolveSyntheticMediaFlags({ jobType: 'twitch-short', heygenUsed: true }).isAigc, true);
});

test('unknown type defaults to not synthetic', () => {
  assert.equal(resolveSyntheticMediaFlags({ jobType: 'custom-thing' }).isAigc, false);
});
