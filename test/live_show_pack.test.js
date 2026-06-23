'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  deskFromContentType,
  recordCompClipsForLiveShow,
  loadPack,
  buildRundown,
} = require('../lib/live_show/pack');

describe('live_show pack', () => {
  const date = '2099-01-15';
  const packFile = path.join(__dirname, '..', 'tmp', 'live_show_pack', `${date}.json`);

  afterEach(() => {
    try { fs.unlinkSync(packFile); } catch (_) { /* ignore */ }
  });

  test('deskFromContentType maps news/sports/streaming', () => {
    expect(deskFromContentType('news-short')).toBe('news');
    expect(deskFromContentType('sports-short')).toBe('sports');
    expect(deskFromContentType('twitch-short')).toBe('streaming');
  });

  test('recordCompClipsForLiveShow merges desks for a date', () => {
    const realDate = Date.prototype.toISOString;
    Date.prototype.toISOString = () => `${date}T12:00:00.000Z`;

    recordCompClipsForLiveShow({
      contentType: 'news-short',
      jobId: 'job_news',
      title: 'News comp',
      clips: [{ url: 'https://example.com/a.mp4', title: 'Story A' }],
    });
    recordCompClipsForLiveShow({
      contentType: 'twitch-short',
      jobId: 'job_tw',
      title: 'Twitch comp',
      clips: [{ url: 'https://example.com/b.mp4', title: 'Clip B', streamer: 'lacy' }],
    });

    Date.prototype.toISOString = realDate;

    const rundown = buildRundown(loadPack(date));
    expect(rundown.readyDesks).toBe(2);
    expect(rundown.blocks.find((b) => b.desk === 'news').clips).toHaveLength(1);
    expect(rundown.blocks.find((b) => b.desk === 'streaming').clips[0].streamer).toBe('lacy');
    expect(rundown.blocks.find((b) => b.desk === 'sports').ready).toBe(false);
  });
});
