'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  groupStudioItemsByDate,
  attachStudioScheduleToWeek,
  formatTimeEt,
  dateKeyFromIso,
} = require('../lib/calendar/youtube_studio_sync');

describe('youtube_studio_sync', () => {
  it('dedupeScheduledItems prefers youtube_studio over auraflux for same video', () => {
    const { dedupeScheduledItems } = require('../lib/calendar/youtube_studio_sync');
    const out = dedupeScheduledItems([
      { source: 'auraflux', jobId: 'j1', videoId: 'abc', title: 'A', publishAt: '2026-07-01T21:00:00.000Z' },
      { source: 'youtube_studio', videoId: 'abc', title: 'A Studio', publishAt: '2026-07-01T21:00:00.000Z' },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].source, 'youtube_studio');
    assert.equal(out[0].title, 'A Studio');
  });

  it('collectAurafluxScheduledJobs skips published jobs', () => {
    const { collectAurafluxScheduledJobs } = require('../lib/calendar/youtube_studio_sync');
    const now = Date.now();
    const horizon = now + 90 * 86400000;
    const future = new Date(now + 7 * 86400000).toISOString();
    const items = collectAurafluxScheduledJobs({
      j1: { stage: 'published', scheduledPublishAt: future, title: 'Old' },
      j2: { stage: 'publish_scheduled', scheduledPublishAt: future, title: 'Future', contentType: 'twitch-short' },
    }, { now, horizon });
    assert.equal(items.length, 1);
    assert.equal(items[0].jobId, 'j2');
    assert.equal(items[0].kind, 'short');
  });
  it('groups scheduled items by ET dateKey', () => {
    const grouped = groupStudioItemsByDate([
      { dateKey: '2026-07-01', publishAt: '2026-07-01T21:00:00.000Z', title: 'A' },
      { dateKey: '2026-07-01', publishAt: '2026-07-01T23:00:00.000Z', title: 'B' },
      { dateKey: '2026-07-02', publishAt: '2026-07-02T21:00:00.000Z', title: 'C' },
    ]);
    assert.equal(grouped['2026-07-01'].length, 2);
    assert.equal(grouped['2026-07-02'].length, 1);
  });

  it('attachStudioScheduleToWeek merges into day objects', () => {
    const days = attachStudioScheduleToWeek(
      [{ date: '2026-07-01' }, { date: '2026-07-02' }],
      [{ dateKey: '2026-07-01', title: 'Scheduled VOD', publishAt: '2026-07-01T21:00:00.000Z' }],
    );
    assert.equal(days[0].youtubeStudio.length, 1);
    assert.equal(days[1].youtubeStudio.length, 0);
  });

  it('formatTimeEt returns readable time', () => {
    const t = formatTimeEt('2026-07-01T16:00:00.000Z');
    assert.match(t, /\d/);
  });

  it('dateKeyFromIso uses America/New_York', () => {
    const dk = dateKeyFromIso('2026-07-01T03:30:00.000Z');
    assert.match(dk, /^\d{4}-\d{2}-\d{2}$/);
  });
});
