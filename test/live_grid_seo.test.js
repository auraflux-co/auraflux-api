const {
  buildLiveDescription,
  appendChannelHashtag,
  fallbackSeo,
  displayName,
  AUDIO_INSTRUCTIONS,
} = require('../lib/live_grid/seo');

describe('live_grid seo', () => {
  test('chat announce lines fit YouTube 200-char cap', () => {
    for (const line of AUDIO_INSTRUCTIONS) {
      expect(line.length).toBeLessThanOrEqual(200);
    }
  });

  test('appendChannelHashtag adds ClipzWorldNews within 100 chars', () => {
    const t = appendChannelHashtag('🔴 LIVE: Brazil vs Morocco | Watch Party');
    expect(t).toContain('#ClipzWorldNews');
    expect(t.length).toBeLessThanOrEqual(100);
  });

  test('buildLiveDescription includes member perks and streamers', () => {
    const desc = buildLiveDescription({
      hookLine: '⚽ LIVE NOW: Brazil vs Morocco',
      streamers: [{ login: 'lacy' }, { login: 'ishowspeed' }],
      tags: ['Brazil vs Morocco', 'World Cup'],
      hashtags: ['WorldCup', 'ClipzWorldNews'],
    });
    expect(desc).toContain('!listen 1-4');
    expect(desc).toContain('🔥 Lacy');
    expect(desc).toContain('Tags:');
    expect(desc).toContain('#ClipzWorldNews');
  });

  test('fallbackSeo produces title and tags without OpenAI', () => {
    const seo = fallbackSeo({
      headline: 'Brazil vs Morocco',
      streamers: [{ login: 'lacy' }, { login: 'extraemily' }],
    });
    expect(seo.title).toMatch(/^🔴 LIVE:/);
    expect(seo.tags.length).toBeGreaterThan(2);
    expect(seo.thumbnailHeadline).toBeTruthy();
  });

  test('displayName formats logins', () => {
    expect(displayName('ow_esports')).toBe('OwEsports');
    expect(displayName('ishowspeed')).toBe('Ishowspeed');
  });
});
