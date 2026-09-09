'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isYoutubeUrl, extractYoutubeVideoId, heatmapToSegments } = require('../lib/content_library/youtube_heatmap');
const { COMPOSE_PRESETS } = require('../lib/routes/content_library');

test('youtube url helpers', () => {
  assert.equal(isYoutubeUrl('https://www.youtube.com/watch?v=abc123'), true);
  assert.equal(extractYoutubeVideoId('https://youtu.be/abc123'), 'abc123');
});

test('heatmapToSegments finds local maxima', () => {
  const heat = [];
  for (let t = 0; t < 300; t += 5) {
    const value = t === 120 ? 1 : (t === 240 ? 0.8 : 0.05);
    heat.push({ start_time: t, end_time: t + 5, value });
  }
  const segs = heatmapToSegments(heat, { clipSec: 45, maxPeaks: 3, durationSec: 300 });
  assert.ok(segs.length >= 1);
  assert.ok(segs[0].start_sec <= 120);
  assert.ok(segs[0].end_sec > segs[0].start_sec);
});

test('compose presets include C9–C11', () => {
  const keys = COMPOSE_PRESETS.map((p) => p.key);
  assert.ok(keys.includes('fableflow_speed'));
  assert.ok(keys.includes('reaction_short'));
  assert.ok(keys.includes('dual_source_stack'));
});
