'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  isPublishedLongFormJob,
  getRepurposeMode,
  parseTimeSec,
  buildManualClipCandidate,
  mergeClipCandidates,
  summarizePublishedJob,
} = require('../lib/post_live/repurpose');

describe('repurpose', () => {
  it('isPublishedLongFormJob accepts any published non-short job with YouTube URL', () => {
    assert.equal(isPublishedLongFormJob({
      contentType: 'twitch',
      stage: 'published',
      publishRecord: { youtubeUrl: 'https://www.youtube.com/watch?v=abc12345678' },
    }), true);
    assert.equal(isPublishedLongFormJob({
      contentType: 'news',
      publishedAt: '2026-06-01',
      driveUrl: 'https://www.youtube.com/watch?v=abc12345678',
    }), true);
    assert.equal(isPublishedLongFormJob({ contentType: 'twitch-short', stage: 'published' }), false);
    assert.equal(isPublishedLongFormJob({ contentType: 'twitch', clipsOnly: true, stage: 'published' }), false);
  });

  it('getRepurposeMode prefers scene when rundown exists', () => {
    assert.equal(getRepurposeMode({
      postAssemblyRundown: { entries: [{ segmentLabel: 'INTRO', durationSec: 10 }] },
    }), 'scene');
    assert.equal(getRepurposeMode({ script: { raw: '=== INTRO ===\nHi' } }), 'scene');
    assert.equal(getRepurposeMode({ title: 'Live only' }), 'timestamp');
  });

  it('buildManualClipCandidate parses M:SS', () => {
    const c = buildManualClipCandidate({ start_s: '1:30', end_s: '2:00', title: 'Moment' });
    assert.equal(c.start_s, 90);
    assert.equal(c.end_s, 120);
    assert.equal(c.durationSec, 30);
    assert.equal(c.source, 'manual_timestamp');
  });

  it('mergeClipCandidates dedupes identical windows', () => {
    const a = buildManualClipCandidate({ start_s: 0, end_s: 30, title: 'A' });
    const merged = mergeClipCandidates([a], [a]);
    assert.equal(merged.length, 1);
  });

  it('summarizePublishedJob includes show and mode', () => {
    const s = summarizePublishedJob('job1', {
      contentType: 'twitch',
      title: 'Soup',
      stage: 'published',
      publishRecord: { youtubeUrl: 'https://youtu.be/dQw4w9WgXcQ' },
      postAssemblyRundown: { entries: [{ segmentLabel: 'CLIP1', durationSec: 20 }] },
    });
    assert.equal(s.repurposeMode, 'scene');
    assert.equal(s.showLabel, 'Talk Soup');
  });
});
