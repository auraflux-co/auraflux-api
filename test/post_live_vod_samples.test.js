'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pickVodSampleWindows, sampleConfig } = require('../lib/post_live/vod_samples');

test('pickVodSampleWindows spreads samples across clean windows', () => {
  const samples = pickVodSampleWindows(3600, [{ start: 600, end: 900, action: 'exclude' }], {
    count: 4,
    sampleSec: 60,
  });
  assert.ok(samples.length >= 2);
  for (const s of samples) {
    assert.ok(s.start_s >= 0);
    assert.ok(s.end_s - s.start_s === 60);
    assert.ok(s.start_s < 600 || s.start_s >= 900, `sample ${s.start_s} inside excluded range`);
  }
});

test('sampleConfig respects bounds', () => {
  const prev = process.env.POST_LIVE_VOD_SAMPLE_COUNT;
  process.env.POST_LIVE_VOD_SAMPLE_COUNT = '99';
  const cfg = sampleConfig();
  assert.equal(cfg.count, 10);
  process.env.POST_LIVE_VOD_SAMPLE_COUNT = prev;
});
