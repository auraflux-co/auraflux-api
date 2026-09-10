'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const TwitchClient = require('../lib/clients/twitch_client');
const {
  extractTwitchVodId,
  chatHeatmapToSegments,
} = require('../lib/content_library/twitch_chat_heatmap');

test('TwitchClient.parseVodDuration', () => {
  assert.equal(TwitchClient.parseVodDuration('2h3m45s'), 2 * 3600 + 3 * 60 + 45);
  assert.equal(TwitchClient.parseVodDuration('45s'), 45);
  assert.equal(TwitchClient.parseVodDuration('1h'), 3600);
  assert.equal(TwitchClient.parseVodDuration(''), 0);
});

test('extractTwitchVodId', () => {
  assert.equal(extractTwitchVodId('https://www.twitch.tv/videos/1234567890'), '1234567890');
  assert.equal(extractTwitchVodId('https://twitch.tv/videos/99?t=10s'), '99');
  assert.equal(extractTwitchVodId('https://youtube.com/watch?v=x'), null);
});

test('chatHeatmapToSegments finds dense bins', () => {
  const heatmap = [];
  for (let t = 0; t < 600; t += 20) {
    const value = t === 200 ? 1 : (t === 400 ? 0.7 : 0.05);
    heatmap.push({ start_time: t, end_time: t + 20, value });
  }
  const segs = chatHeatmapToSegments(heatmap, { clipSec: 45, maxPeaks: 3, durationSec: 600 });
  assert.ok(segs.length >= 1);
  assert.ok(segs[0].start_sec <= 200);
  assert.ok(segs[0].end_sec > segs[0].start_sec);
});
