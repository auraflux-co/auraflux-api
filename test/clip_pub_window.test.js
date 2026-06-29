'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveClipPubWindow, clipInPubBand, PUB_BANDS } = require('../lib/pickers/streamers/clip_pub_window');

test('24h band is 0–24h exclusive upper bound at 168h', () => {
  const band = resolveClipPubWindow({ pubWindow: '24h' });
  assert.equal(band.minHours, 0);
  assert.equal(band.maxHours, 24);
  const now = Date.now();
  assert.equal(clipInPubBand(new Date(now - 12 * 3600000).toISOString(), band), true);
  assert.equal(clipInPubBand(new Date(now - 25 * 3600000).toISOString(), band), false);
});

test('7d band is 24h–7d non-overlapping', () => {
  const band = resolveClipPubWindow({ pubWindow: '7d' });
  const now = Date.now();
  assert.equal(clipInPubBand(new Date(now - 12 * 3600000).toISOString(), band), false);
  assert.equal(clipInPubBand(new Date(now - 48 * 3600000).toISOString(), band), true);
  assert.equal(clipInPubBand(new Date(now - 169 * 3600000).toISOString(), band), false);
});

test('30d band is 7d–30d', () => {
  const band = resolveClipPubWindow({ pubWindow: '30d' });
  const now = Date.now();
  assert.equal(clipInPubBand(new Date(now - 169 * 3600000).toISOString(), band), true);
  assert.equal(clipInPubBand(new Date(now - 48 * 3600000).toISOString(), band), false);
});

test('all band is 30d+', () => {
  const band = resolveClipPubWindow({ pubWindow: 'all' });
  const now = Date.now();
  assert.equal(clipInPubBand(new Date(now - 800 * 3600000).toISOString(), band), true);
  assert.equal(clipInPubBand(new Date(now - 169 * 3600000).toISOString(), band), false);
});

test('resolveClipPubWindow sets helix started_at older than ended_at for 7d band', () => {
  const band = resolveClipPubWindow({ pubWindow: '7d' });
  assert.ok(band.startedAt && band.endedAt);
  assert.ok(new Date(band.startedAt) < new Date(band.endedAt));
});

test('PUB_BANDS covers library window keys', () => {
  for (const k of ['24h', '7d', '30d', 'all']) {
    assert.ok(PUB_BANDS[k], k);
  }
});
