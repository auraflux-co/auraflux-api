'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PUB_BANDS,
  resolvePubWindow,
  inPubBand,
  filterVodsByPubWindow,
  filterVodsByDuration,
  sortVods,
  applyVodDiscoveryFilters,
  parseVodListQuery,
} = require('../lib/content_library/pub_window');

test('PUB_BANDS includes C0 window keys', () => {
  for (const k of ['last24h', 'last7d', 'last30d', '7d', '30d', 'all', 'any']) {
    assert.ok(PUB_BANDS[k], `missing band ${k}`);
  }
});

test('resolvePubWindow last7d sets startedAt ~7d ago', () => {
  const band = resolvePubWindow('last7d');
  assert.equal(band.pubWindow, 'last7d');
  assert.equal(band.minHours, 0);
  assert.equal(band.maxHours, 168);
  const ageMs = Date.now() - new Date(band.startedAt).getTime();
  assert.ok(ageMs > 167 * 3600000 && ageMs < 169 * 3600000);
  assert.ok(band.publishedAfter);
});

test('inPubBand 7d excludes last 24h and older than 7d', () => {
  const band = resolvePubWindow('7d');
  const now = Date.now();
  const h12 = new Date(now - 12 * 3600000).toISOString();
  const h48 = new Date(now - 48 * 3600000).toISOString();
  const h200 = new Date(now - 200 * 3600000).toISOString();
  assert.equal(inPubBand(h12, band), false);
  assert.equal(inPubBand(h48, band), true);
  assert.equal(inPubBand(h200, band), false);
});

test('filterVodsByDuration respects min and max', () => {
  const vods = [
    { title: 'a', duration: 60 },
    { title: 'b', duration: 200 },
    { title: 'c', duration: 4000 },
  ];
  const mid = filterVodsByDuration(vods, { minDurationSec: 180, maxDurationSec: 3600 });
  assert.deepEqual(mid.map((v) => v.title), ['b']);
});

test('sortVods popular vs recent', () => {
  const vods = [
    { title: 'old-hot', views: 9000, createdAt: '2020-01-01T00:00:00Z' },
    { title: 'new-cold', views: 10, createdAt: '2026-09-01T00:00:00Z' },
  ];
  assert.equal(sortVods(vods, 'popular')[0].title, 'old-hot');
  assert.equal(sortVods(vods, 'recent')[0].title, 'new-cold');
});

test('applyVodDiscoveryFilters combines window, duration, sort, limit', () => {
  const now = Date.now();
  const vods = [
    { title: 'short', duration: 30, views: 99, createdAt: new Date(now - 2 * 3600000).toISOString() },
    { title: 'keep-a', duration: 600, views: 50, createdAt: new Date(now - 3 * 3600000).toISOString() },
    { title: 'keep-b', duration: 900, views: 200, createdAt: new Date(now - 5 * 3600000).toISOString() },
    { title: 'old', duration: 900, views: 500, createdAt: new Date(now - 400 * 3600000).toISOString() },
  ];
  const band = resolvePubWindow('last7d');
  const out = applyVodDiscoveryFilters(vods, {
    band,
    minDurationSec: 180,
    maxDurationSec: null,
    sort: 'popular',
    limit: 10,
  });
  assert.deepEqual(out.map((v) => v.title), ['keep-b', 'keep-a']);
});

test('parseVodListQuery defaults', () => {
  const q = parseVodListQuery({});
  assert.equal(q.band.pubWindow, 'last7d');
  assert.equal(q.minDurationSec, 180);
  assert.equal(q.maxDurationSec, null);
  assert.equal(q.sort, 'recent');
  assert.equal(q.limit, 40);
});

test('filterVodsByPubWindow any keeps all dated', () => {
  const band = resolvePubWindow('any');
  const vods = [
    { createdAt: new Date(Date.now() - 1000).toISOString() },
    { createdAt: new Date(Date.now() - 800 * 3600000).toISOString() },
  ];
  assert.equal(filterVodsByPubWindow(vods, band).length, 2);
});
