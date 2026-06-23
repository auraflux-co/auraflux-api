'use strict';

const {
  extractYoutubeVideoId,
  isStreamerClipJob,
} = require('../lib/services/youtube_direct');

describe('youtube streamer clip playlist helpers', () => {
  test('extractYoutubeVideoId parses watch and shorts URLs', () => {
    expect(extractYoutubeVideoId('dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(extractYoutubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(extractYoutubeVideoId('https://youtube.com/shorts/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(extractYoutubeVideoId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  test('isStreamerClipJob matches twitch comps and excludes news', () => {
    expect(isStreamerClipJob({ contentType: 'twitch-short', clipsOnly: true })).toBe(true);
    expect(isStreamerClipJob({ contentType: 'news-short' })).toBe(false);
    expect(isStreamerClipJob({ contentType: 'nba-short' })).toBe(false);
    expect(isStreamerClipJob({ contentType: 'news', streamers: ['x'] })).toBe(false);
  });
});
