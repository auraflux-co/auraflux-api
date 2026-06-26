'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('listUsedClipIds', () => {
  it('returns clip ids and urls from store', () => {
    const { upsertLibraryClip, markClipsUsedForJob, listUsedClipIds } = require('../lib/content_library/store');
    upsertLibraryClip({
      platform: 'twitch',
      streamer: 'tester',
      clip_id: 'UsedClipSlug123',
      url: 'https://clips.twitch.tv/UsedClipSlug123',
      title: 'Used clip',
      views: 100,
      duration_sec: 30,
      ingest_date: '2026-06-25',
    });
    markClipsUsedForJob('job-used-1', ['https://clips.twitch.tv/UsedClipSlug123']);
    const out = listUsedClipIds();
    assert.ok(out.clipIds.includes('UsedClipSlug123'));
    assert.ok(out.urls.some((u) => u.includes('UsedClipSlug123')));
  });
});
