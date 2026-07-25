'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveClipPubWindow } = require('../lib/pickers/streamers/clip_pub_window');
const { filterVodsByPubWindow } = require('../lib/pickers/streamers/vods');

function hoursAgoIso(h) {
  return new Date(Date.now() - h * 3600000).toISOString();
}

test('filterVodsByPubWindow keeps last7d and drops older (CPD-1288)', () => {
  const band = resolveClipPubWindow({ pubWindow: 'last7d' });
  const vods = [
    { title: 'fresh', createdAt: hoursAgoIso(24) },
    { title: 'week', createdAt: hoursAgoIso(100) },
    { title: 'old', createdAt: hoursAgoIso(200) },
  ];
  const kept = filterVodsByPubWindow(vods, band).map((v) => v.title);
  assert.deepEqual(kept, ['fresh', 'week']);
});

test('filterVodsByPubWindow last30d includes 2-week-old VOD', () => {
  const band = resolveClipPubWindow({ pubWindow: 'last30d' });
  const vods = [
    { title: '2w', createdAt: hoursAgoIso(14 * 24) },
    { title: 'old', createdAt: hoursAgoIso(40 * 24) },
  ];
  const kept = filterVodsByPubWindow(vods, band).map((v) => v.title);
  assert.deepEqual(kept, ['2w']);
});

test('filterVodsByPubWindow null band keeps all', () => {
  const vods = [{ title: 'a', createdAt: hoursAgoIso(9000) }];
  assert.equal(filterVodsByPubWindow(vods, null).length, 1);
});
