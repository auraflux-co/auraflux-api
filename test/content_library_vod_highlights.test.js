'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildHeuristicSegments } = require('../lib/content_library/vod_highlights');

describe('vod_highlights heuristic', () => {
  it('returns ~7min window', () => {
    const segs = buildHeuristicSegments(7200, 420);
    assert.equal(segs.length, 1);
    assert.ok(segs[0].end_sec - segs[0].start_sec <= 420);
    assert.ok(segs[0].start_sec >= 0);
  });
});
