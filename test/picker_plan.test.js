const { normalizeContentType, isSportsContentType, acceptsLegacyContentType } = require('../lib/content_type');
const { resolveStreamer, listPlatforms } = require('../lib/pickers/streamers');

describe('content_type', () => {
  test('normalizeContentType maps legacy nba aliases', () => {
    expect(normalizeContentType('nba')).toBe('sports');
    expect(normalizeContentType('nba-short')).toBe('sports-short');
    expect(normalizeContentType('twitch')).toBe('twitch');
  });

  test('isSportsContentType accepts canonical and legacy', () => {
    expect(isSportsContentType('sports')).toBe(true);
    expect(isSportsContentType('nba')).toBe(true);
    expect(isSportsContentType('sports-short')).toBe(true);
    expect(isSportsContentType('twitch')).toBe(false);
  });

  test('acceptsLegacyContentType allows nba when sports is allowed', () => {
    const allowed = ['sports', 'twitch'];
    expect(acceptsLegacyContentType('nba', allowed)).toBe(true);
    expect(acceptsLegacyContentType('news', allowed)).toBe(false);
  });
});

describe('streamer picker config', () => {
  test('resolveStreamer defaults platform to twitch', () => {
    const s = resolveStreamer('jasontheween');
    expect(s.platform).toBe('twitch');
    expect(s.displayName).toBe('Jason');
  });

  test('resolveStreamer reads kick platform from config', () => {
    const s = resolveStreamer('xqc');
    expect(s.platform).toBe('kick');
  });

  test('resolveStreamer prefers registry primaryPlatform over config seed', () => {
    const s = resolveStreamer('lacy');
    expect(s.platform).toBe('twitch');
    expect(s.displayName).toBe('Lacy');
  });

  test('listPlatforms returns enabled platforms', () => {
    const platforms = listPlatforms();
    expect(platforms.some(p => p.id === 'twitch')).toBe(true);
    expect(platforms.some(p => p.id === 'kick')).toBe(true);
  });
});
