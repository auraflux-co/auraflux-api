'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  filterVodsByPubWindow,
  parseTwitchDuration,
} = require('../lib/pickers/streamers/vods');
const { resolveClipPubWindow } = require('../lib/pickers/streamers/clip_pub_window');

test('parseTwitchDuration handles h/m/s', () => {
  assert.equal(parseTwitchDuration('1h2m3s'), 3723);
  assert.equal(parseTwitchDuration('45m'), 2700);
  assert.equal(parseTwitchDuration(90), 90);
});

test('filterVodsByPubWindow any/all-time keeps entire set', () => {
  const now = Date.now();
  const vods = [
    { createdAt: new Date(now - 2 * 3600000).toISOString(), title: 'new' },
    { createdAt: new Date(now - 40 * 24 * 3600000).toISOString(), title: 'old' },
  ];
  const anyBand = resolveClipPubWindow({ pubWindow: 'any' });
  assert.equal(filterVodsByPubWindow(vods, anyBand).length, 2);
});

test('filterVodsByPubWindow all (30d+) drops last 30 days', () => {
  const now = Date.now();
  const vods = [
    { createdAt: new Date(now - 2 * 24 * 3600000).toISOString(), title: 'recent' },
    { createdAt: new Date(now - 40 * 24 * 3600000).toISOString(), title: 'archive' },
  ];
  const band = resolveClipPubWindow({ pubWindow: 'all' });
  const kept = filterVodsByPubWindow(vods, band);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].title, 'archive');
});
