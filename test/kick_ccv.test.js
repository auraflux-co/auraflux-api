'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  formatKickTimestamp,
  formatOffset,
  vodUrlAtPeak,
  buildVodUrl,
} = require('../lib/kick_ccv');

test('formatKickTimestamp is integer seconds only', () => {
  assert.equal(formatKickTimestamp(0), '0');
  assert.equal(formatKickTimestamp(65), '65');
  assert.equal(formatKickTimestamp(3600), '3600');
  assert.equal(formatKickTimestamp(4520.9), '4520');
  assert.equal(formatKickTimestamp(null), null);
});

test('formatOffset clocks peak position', () => {
  assert.equal(formatOffset(65), '1:05');
  assert.equal(formatOffset(3723), '1:02:03');
});

test('buildVodUrl uses channel/videos/uuid path', () => {
  assert.equal(
    buildVodUrl('xqc', '01a08187-d570-7940-9f3f-d5cd8c8cdabc'),
    'https://kick.com/xqc/videos/01a08187-d570-7940-9f3f-d5cd8c8cdabc',
  );
  assert.equal(buildVodUrl(null, 'abc'), null);
});

test('vodUrlAtPeak appends integer ?t= (not Twitch 1h2m3s)', () => {
  const base = 'https://kick.com/xqc/videos/01a08187-d570-7940-9f3f-d5cd8c8cdabc';
  assert.equal(vodUrlAtPeak(base, 3600), `${base}?t=3600`);
  assert.equal(vodUrlAtPeak(`${base}?foo=1`, 30), `${base}?foo=1&t=30`);
  assert.equal(vodUrlAtPeak(null, 10), null);
  assert.equal(vodUrlAtPeak(base, null), base);
});

test('peakWindow pads around CCV peak for compose', () => {
  const { peakWindow } = require('../lib/kick_ccv');
  assert.deepEqual(peakWindow(100), { start_sec: 80, end_sec: 125, peak_sec: 100 });
  assert.deepEqual(peakWindow(5), { start_sec: 0, end_sec: 30, peak_sec: 5 });
});
