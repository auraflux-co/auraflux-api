'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  formatOffset,
  formatTwitchTimestamp,
  vodUrlAtPeak,
} = require('../lib/twitch_ccv');

test('formatOffset clocks peak position', () => {
  assert.equal(formatOffset(0), '0:00');
  assert.equal(formatOffset(65), '1:05');
  assert.equal(formatOffset(3723), '1:02:03');
  assert.equal(formatOffset(null), null);
});

test('formatTwitchTimestamp for player ?t=', () => {
  assert.equal(formatTwitchTimestamp(0), '0s');
  assert.equal(formatTwitchTimestamp(65), '1m5s');
  assert.equal(formatTwitchTimestamp(3723), '1h2m3s');
  assert.equal(formatTwitchTimestamp(null), null);
});

test('vodUrlAtPeak appends seek query', () => {
  assert.equal(
    vodUrlAtPeak('https://www.twitch.tv/videos/123', 125),
    'https://www.twitch.tv/videos/123?t=2m5s',
  );
  assert.equal(
    vodUrlAtPeak('https://www.twitch.tv/videos/123?foo=1', 30),
    'https://www.twitch.tv/videos/123?foo=1&t=30s',
  );
  assert.equal(vodUrlAtPeak(null, 10), null);
  assert.equal(vodUrlAtPeak('https://www.twitch.tv/videos/123', null), 'https://www.twitch.tv/videos/123');
});
