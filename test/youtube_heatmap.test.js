'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  isYoutubeUrl,
  extractYoutubeVideoId,
  findHeatmapPeaks,
  heatmapToSegments,
} = require('../lib/content_library/youtube_heatmap');

describe('youtube_heatmap CPD-1268', () => {
  it('detects YouTube URLs and extracts video ids', () => {
    assert.equal(isYoutubeUrl('https://www.youtube.com/watch?v=FcbbYyYvneg'), true);
    assert.equal(isYoutubeUrl('https://www.twitch.tv/videos/1'), false);
    assert.equal(extractYoutubeVideoId('https://www.youtube.com/watch?v=FcbbYyYvneg&t=10'), 'FcbbYyYvneg');
    assert.equal(extractYoutubeVideoId('https://youtu.be/FcbbYyYvneg'), 'FcbbYyYvneg');
  });

  it('picks spaced local maxima from heatmap', () => {
    const heatmap = [];
    for (let i = 0; i < 20; i++) {
      heatmap.push({
        start_time: i * 100,
        end_time: (i + 1) * 100,
        value: i === 5 ? 1 : (i === 12 ? 0.8 : (i === 6 || i === 4 ? 0.4 : 0.05)),
      });
    }
    const peaks = findHeatmapPeaks(heatmap, { maxPeaks: 5, minGapSec: 200, minValue: 0.1 });
    assert.ok(peaks.length >= 1);
    assert.equal(peaks.some((p) => p.value === 1), true);
    // gaps enforced
    for (let i = 1; i < peaks.length; i++) {
      assert.ok(Math.abs(peaks[i].start_time - peaks[i - 1].start_time) >= 200);
    }
  });

  it('maps peaks to short clip windows biased before climax', () => {
    const heatmap = [
      { start_time: 0, end_time: 100, value: 0.1 },
      { start_time: 100, end_time: 200, value: 0.2 },
      { start_time: 200, end_time: 300, value: 1.0 },
      { start_time: 300, end_time: 400, value: 0.3 },
      { start_time: 400, end_time: 500, value: 0.15 },
    ];
    const segs = heatmapToSegments(heatmap, { clipSec: 45, maxPeaks: 3, durationSec: 500 });
    assert.ok(segs.length >= 1);
    const top = segs.find((s) => s.peak_value === 1) || segs[0];
    assert.equal(top.end_sec - top.start_sec, 45);
    assert.equal(top.source, 'youtube_heatmap');
    assert.ok(top.start_sec <= 250);
    assert.ok(top.end_sec >= 250);
  });
});
