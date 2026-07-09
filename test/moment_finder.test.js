'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { rankMoments, buildHeuristicMoments, normalizeMoment } = require('../lib/moment_finder/scoring');
const { momentsToCompositionClips } = require('../lib/moment_finder');
const { clampRange, detectPlatform } = require('../lib/moment_finder/util');

describe('moment_finder', () => {
  it('detects youtube and twitch platforms', () => {
    assert.equal(detectPlatform('https://www.youtube.com/watch?v=abc'), 'youtube');
    assert.equal(detectPlatform('https://www.twitch.tv/videos/123'), 'twitch');
  });

  it('clamps analysis range inside duration', () => {
    const r = clampRange(0, 500, 300);
    assert.equal(r.start, 0);
    assert.equal(r.end, 300);
  });

  it('ranks moments by score descending', () => {
    const ranked = rankMoments([
      { start_sec: 10, end_sec: 40, score: 70, title: 'A' },
      { start_sec: 50, end_sec: 90, score: 95, title: 'B' },
    ]);
    assert.equal(ranked[0].title, 'B');
    assert.equal(ranked[0].score, 95);
    assert.ok(ranked[0].hook_score >= 1);
  });

  it('builds heuristic moments in range', () => {
    const moments = buildHeuristicMoments({
      rangeStart: 0,
      rangeEnd: 300,
      maxCandidates: 5,
    });
    assert.ok(moments.length >= 1);
    assert.ok(moments.length <= 5);
    assert.ok(moments[0].end_sec > moments[0].start_sec);
  });

  it('maps moments to composition clips', () => {
    const m = normalizeMoment({ start_sec: 120, end_sec: 180, score: 88, title: 'Epic' }, 0);
    const clips = momentsToCompositionClips([m], 'https://youtube.com/watch?v=x', 'ClipzWorld');
    assert.equal(clips.length, 1);
    assert.equal(clips[0].trimStart, 120);
    assert.equal(clips[0].trimEnd, 180);
    assert.equal(clips[0].viralityScore, 88);
  });
});
