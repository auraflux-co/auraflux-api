const {
  detectPlatform,
  parseKickClipRef,
} = require('../lib/pickers/streamers/clip_resolve');

describe('clip_url resolve helpers', () => {
  test('detectPlatform maps hosts', () => {
    expect(detectPlatform('https://clips.twitch.tv/Foo')).toBe('twitch');
    expect(detectPlatform('https://kick.com/lacy/clips/clip_abc')).toBe('kick');
    expect(detectPlatform('https://www.youtube.com/watch?v=abc')).toBe('youtube');
  });

  test('parseKickClipRef extracts channel and clip id', () => {
    expect(parseKickClipRef('https://kick.com/lacy/clips/clip_01ABC')).toEqual({
      channel: 'lacy',
      clipId: 'clip_01ABC',
    });
    expect(parseKickClipRef('https://kick.com/clip/clip_legacy')).toEqual({
      channel: null,
      clipId: 'clip_legacy',
    });
  });
});
