'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  extractTwitchVodId,
  chatHeatmapToSegments,
} = require('../lib/content_library/twitch_chat_heatmap');

describe('twitch_chat_heatmap CPD-1275', () => {
  it('extracts VOD ids', () => {
    assert.equal(extractTwitchVodId('https://www.twitch.tv/videos/1234567890'), '1234567890');
    assert.equal(extractTwitchVodId('https://youtube.com/watch?v=x'), null);
  });

  it('maps chat density curve to peak windows', () => {
    const heatmap = [];
    for (let t = 0; t < 600; t += 20) {
      heatmap.push({
        start_time: t,
        end_time: t + 20,
        value: t === 200 ? 1 : (t === 400 ? 0.8 : 0.1),
      });
    }
    const segs = chatHeatmapToSegments(heatmap, { clipSec: 45, maxPeaks: 3, durationSec: 600 });
    assert.ok(segs.length >= 1);
    assert.ok(segs[0].end_sec - segs[0].start_sec <= 45);
  });
});
