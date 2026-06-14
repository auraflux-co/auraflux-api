const {
  buildPlatformChannelUrl,
  mergedPlatformPins,
  detectFeedPlatform,
  SUPPORTED_PLATFORMS,
} = require('../lib/live_grid/alt_platform_discovery');

describe('live_grid alt platform discovery', () => {
  test('SUPPORTED_PLATFORMS includes kick trovo dlive rumble chzzk nimo', () => {
    for (const p of ['kick', 'trovo', 'dlive', 'rumble', 'chzzk', 'nimo']) {
      expect(SUPPORTED_PLATFORMS).toContain(p);
    }
  });

  test('buildPlatformChannelUrl builds expected URLs', () => {
    expect(buildPlatformChannelUrl('kick', 'xqc')).toBe('https://kick.com/xqc');
    expect(buildPlatformChannelUrl('trovo', 'Shroud')).toBe('https://trovo.live/s/Shroud');
    expect(buildPlatformChannelUrl('dlive', 'IcePoseidon')).toBe('https://dlive.tv/IcePoseidon');
    expect(buildPlatformChannelUrl('rumble', 'Timcast')).toBe('https://rumble.com/c/Timcast');
    expect(buildPlatformChannelUrl('chzzk', 'abc123')).toBe('https://chzzk.naver.com/live/abc123');
    expect(buildPlatformChannelUrl('nimo', 'foo')).toBe('https://www.nimo.tv/live/foo');
  });

  test('mergedPlatformPins merges global event and legacy keys', () => {
    const config = { platformPins: { kick: ['xqc'], trovo: ['A'] } };
    const spec = { kickPins: ['lacy'], platformPins: { kick: ['ishowspeed'] } };
    const merged = mergedPlatformPins(spec, config);
    expect(merged.kick.sort()).toEqual(['ishowspeed', 'lacy', 'xqc'].sort());
    expect(merged.trovo).toEqual(['A']);
  });

  test('detectFeedPlatform maps hosts', () => {
    expect(detectFeedPlatform('https://kick.com/xqc')).toBe('kick');
    expect(detectFeedPlatform('https://trovo.live/s/x')).toBe('trovo');
    expect(detectFeedPlatform('https://www.twitch.tv/x')).toBe('twitch');
    expect(detectFeedPlatform('https://youtu.be/abc')).toBe('youtube');
  });
});
