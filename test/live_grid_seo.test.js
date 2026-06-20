const {
  buildLiveDescription,
  appendChannelHashtag,
  fallbackSeo,
  displayName,
  buildGridLiveTitleHashtag,
  liveTitleDateShort,
  buildYoutubeTags,
  AUDIO_INSTRUCTIONS,
} = require('../lib/live_grid/seo');
const { buildGoLiveSeo, loadGoLiveConfig } = require('../lib/live_grid/go_live_template');

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

  test('buildGridLiveTitleHashtag matches Studio format', () => {
    const title = buildGridLiveTitleHashtag([
      { login: 'hasanabi' },
      { login: 'maya' },
      { login: 'joe_bartolozzi' },
      { login: 'ludwig' },
    ], new Date('2026-06-20T18:00:00Z'));
    expect(title).toMatch(/^🔴 LIVE: \d{2}\.\d{2}\.\d{2} \| #hasanabi #maya #joe_bartolozzi #ludwig #twitch$/);
    expect(title.length).toBeLessThanOrEqual(100);
  });

  test('liveTitleDateShort uses MM.DD.YY', () => {
    expect(liveTitleDateShort(new Date('2026-06-20T18:00:00Z'))).toMatch(/^\d{2}\.\d{2}\.\d{2}$/);
  });

  test('buildGoLiveSeo from config uses assignments when no locks', () => {
    const cfg = loadGoLiveConfig();
    expect(cfg?.seo?.titleStyle).toBe('hashtag_short_date');
    const pack = buildGoLiveSeo({}, {
      assignments: ['hasanabi', 'maya', 'ludwig', 'joe_bartolozzi'],
    });
    expect(pack.fromTemplate).toBe(true);
    expect(pack.seo.title).toContain('#hasanabi');
    expect(pack.seo.tags.length).toBeGreaterThan(10);
    expect(pack.seo.description).toContain('ON SCREEN NOW');
  });
});
