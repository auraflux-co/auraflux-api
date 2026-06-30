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

  it('videoEffectivePublishAt prefers future Studio schedule over upload receipt time', () => {
    const { videoEffectivePublishAt, calendarStatusFromVideo } = require('../lib/calendar/youtube_studio_sync');
    const video = {
      id: 'qABi0SM3AnI',
      status: { publishAt: '2099-06-30T18:00:00.000Z', privacyStatus: 'private' },
      snippet: { publishedAt: '2026-06-30T00:33:50.000Z', title: 'Scheduled short' },
    };
    assert.equal(videoEffectivePublishAt(video), '2099-06-30T18:00:00.000Z');
    assert.equal(calendarStatusFromVideo(video, videoEffectivePublishAt(video)), 'scheduled');
  });

  it('excludes active grid watch party from content calendar', () => {
    const { videoToCalendarItem, isOperationalGridStream } = require('../lib/calendar/youtube_studio_sync');
    const gridLive = {
      id: '8B7KFJDYzjs',
      snippet: {
        title: '06.17.26: YouTube ClipzWorld Watch Party: #cinna',
        publishedAt: '2026-06-30T15:21:03Z',
        liveBroadcastContent: 'upcoming',
      },
      contentDetails: { duration: 'P0D' },
      status: { privacyStatus: 'public' },
      liveStreamingDetails: { activeLiveChatId: 'abc123' },
    };
    assert.equal(isOperationalGridStream(gridLive), true);
    assert.equal(videoToCalendarItem(gridLive, '2026-06-01', '2026-06-30'), null);
  });

  it('classifies active live as live format, not longform', () => {
    const { inferContentKind, calendarStatusFromVideo } = require('../lib/calendar/youtube_studio_sync');
    const live = {
      snippet: { liveBroadcastContent: 'live', title: 'Tonight stream' },
      contentDetails: { duration: 'P0D' },
      liveStreamingDetails: { activeLiveChatId: 'x', actualStartTime: '2026-06-30T20:00:00Z' },
      status: { privacyStatus: 'public' },
    };
    assert.equal(inferContentKind(live.contentDetails, live.snippet, live.liveStreamingDetails), 'live');
    assert.equal(calendarStatusFromVideo(live, '2026-06-30T20:00:00Z'), 'live');
  });
});
