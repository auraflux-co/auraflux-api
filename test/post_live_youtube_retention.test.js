'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  findRetentionPeaks,
  filterPeaksForAnalyzableWindows,
  formatRetentionPromptBlock,
  boostCandidatesNearRetentionPeaks,
} = require('../lib/post_live/youtube_retention');

test('findRetentionPeaks finds local maxima', () => {
  const curve = [];
  for (let i = 0; i <= 100; i++) {
    const ratio = i / 100;
    let watch = 0.25;
    if (i >= 28 && i <= 32) watch = 0.95;
    if (i >= 68 && i <= 72) watch = 0.88;
    curve.push({ elapsedVideoTimeRatio: ratio, audienceWatchRatio: watch, relativeRetentionPerformance: 1 });
  }
  const peaks = findRetentionPeaks(curve, 3600, { maxPeaks: 5, minGapSec: 300 });
  assert.ok(peaks.length >= 1);
  assert.ok(peaks.some((p) => p.start_s >= 960 && p.start_s <= 1200));
});

test('filterPeaksForAnalyzableWindows removes excluded peaks', () => {
  const peaks = [{ start_s: 100 }, { start_s: 700 }, { start_s: 1500 }];
  const filtered = filterPeaksForAnalyzableWindows(peaks, 3600, [{ start: 650, end: 800, action: 'exclude' }]);
  assert.ok(filtered.some((p) => p.start_s === 100));
  assert.ok(!filtered.some((p) => p.start_s === 700));
});

test('boostCandidatesNearRetentionPeaks tags aligned candidates', () => {
  const out = boostCandidatesNearRetentionPeaks(
    [{ start_s: 200, score: 0.7, title: 'A' }],
    [{ start_s: 210, score: 1 }],
    20,
  );
  assert.equal(out[0].retentionAligned, true);
});

test('formatRetentionPromptBlock lists peaks', () => {
  const block = formatRetentionPromptBlock([{ start_s: 200, audienceWatchRatio: 0.8, relativeRetentionPerformance: 1.2 }]);
  assert.match(block, /3:20/);
  assert.match(block, /validate/i);
});
