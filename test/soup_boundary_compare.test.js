'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  boundariesFromRundown,
  parseArgs,
  formatTs,
} = require('../lib/soup_boundary_compare');

describe('soup_boundary_compare', () => {
  it('parseArgs reads baseline, candidate, job-id', () => {
    const a = parseArgs([
      'node', 'script',
      '--baseline', '/a.mp4',
      '--candidate', '/b.mp4',
      '--job-id', 'script_twitch_x',
      '--window', '0.4',
    ]);
    assert.equal(a.baseline, '/a.mp4');
    assert.equal(a.candidate, '/b.mp4');
    assert.equal(a.jobId, 'script_twitch_x');
    assert.equal(a.windowSec, 0.4);
  });

  it('formatTs renders mm:ss', () => {
    assert.equal(formatTs(125), '2:05');
    assert.equal(formatTs(0), '0:00');
  });

  it('boundariesFromRundown builds joins from entry endSec', () => {
    const rundown = {
      entries: [
        { startSec: 0, endSec: 18, endTimestamp: '0:18', durationSec: 18, feature: 'cold_open', label: 'Cold open' },
        { startSec: 18, endSec: 30, endTimestamp: '0:30', durationSec: 12, feature: 'bobby_intro', label: 'INTRO' },
        { startSec: 30, endSec: 42, endTimestamp: '0:42', durationSec: 12, feature: 'avatar_segment', label: 'LACY_INTRO' },
        { startSec: 42, endSec: 55, endTimestamp: '0:55', durationSec: 13, feature: 'twitch_clip', label: 'CLIP1' },
        { startSec: 55, endSec: 68, endTimestamp: '1:08', durationSec: 13, feature: 'bobby_reaction', label: 'LACY_REACTION' },
        { startSec: 400, endSec: 412, endTimestamp: '6:52', durationSec: 12, feature: 'credits_outro', label: 'Credits' },
      ],
    };
    const bounds = boundariesFromRundown(rundown, { allBoundaries: true });
    assert.equal(bounds.length, 4);
    assert.equal(bounds[0].atSec, 30);
    assert.equal(bounds[0].fromFeature, 'bobby_intro');
    assert.equal(bounds[1].fromFeature, 'avatar_segment');
    assert.equal(bounds[1].toFeature, 'twitch_clip');
  });

  it('boundariesFromRundown skips clip-to-clip when not allBoundaries', () => {
    const rundown = {
      entries: [
        { endSec: 10, feature: 'twitch_clip', label: 'A' },
        { endSec: 20, feature: 'twitch_clip', label: 'B' },
        { endSec: 30, feature: 'avatar_segment', label: 'C' },
      ],
    };
    const bounds = boundariesFromRundown(rundown, { allBoundaries: false });
    assert.equal(bounds.length, 1);
    assert.equal(bounds[0].atSec, 20);
  });
});
