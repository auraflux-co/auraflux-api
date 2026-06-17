const {
  buildLiveDescription,
  buildGridLiveDescription,
  buildYoutubeTags,
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

  test('withLiveTitleDate inserts ET date after LIVE without duplicating', () => {
    const { withLiveTitleDate, liveTitleDateEt } = require('../lib/live_grid/seo');
    const stamp = liveTitleDateEt(new Date('2026-06-16T20:00:00Z'));
    const t = withLiveTitleDate('🔴 LIVE: Twitch Multiview Grid | Lacy, Emily', new Date('2026-06-16T20:00:00Z'));
    expect(t).toMatch(new RegExp(`^🔴 LIVE: ${stamp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\|`));
    expect(withLiveTitleDate(t)).toBe(t);
  });

  test('withLiveTitleDate replaces stale GPT dates (e.g. Oct 5, 2023 Mario Kart)', () => {
    const { withLiveTitleDate, liveTitleDateEt } = require('../lib/live_grid/seo');
    const stamp = liveTitleDateEt(new Date('2026-06-16T20:00:00Z'));
    const t = withLiveTitleDate(
      '🔴 LIVE: Oct 5, 2023 | Mario Kart Party | Cinna, Jason',
      new Date('2026-06-16T20:00:00Z'),
    );
    expect(t).toContain(stamp);
    expect(t).not.toContain('2023');
    expect(t).not.toMatch(/Mario Kart/i);
  });

  test('appendChannelHashtag adds ClipzWorldNews within 100 chars', () => {
    const t = appendChannelHashtag('🔴 LIVE: Brazil vs Morocco | Watch Party');
    expect(t).toContain('#ClipzWorldNews');
    expect(t.length).toBeLessThanOrEqual(100);
  });

  test('buildGridLiveDescription lists quadrants and member commands', () => {
    const desc = buildGridLiveDescription({
      streamers: [
        { login: 'lacy' },
        { login: 'arky' },
        { login: 'clix' },
        { login: 'chosen_ow' },
      ],
    });
    expect(desc).toContain('Q1 — Lacy');
    expect(desc).toContain('2×2 multiview');
    expect(desc).toContain('!listen 1-4');
    expect(desc).toContain('#ClipzWorldNews');
    expect(desc).not.toContain('\n\nTags:\n');
  });

  test('buildYoutubeTags includes streamer names and discovery terms', () => {
    const tags = buildYoutubeTags(
      [{ login: 'lacy' }, { login: 'arky' }],
      { mode: 'grid' },
    );
    expect(tags).toContain('lacy');
    expect(tags).toContain('arky');
    expect(tags).toContain('twitch live');
    expect(tags).toContain('twitch multistream');
    const total = tags.reduce((n, t) => n + t.length + (t.includes(' ') ? 2 : 0) + 1, 0);
    expect(total).toBeLessThanOrEqual(450);
  });

  test('fallbackSeo grid mode uses rich description and tags', () => {
    const seo = fallbackSeo({
      programMode: 'grid',
      streamers: [{ login: 'lacy' }, { login: 'extraemily' }],
    });
    expect(seo.title).toMatch(/^🔴 LIVE:/);
    expect(seo.description).toContain('ON SCREEN NOW');
    expect(seo.tags).toContain('lacy');
    expect(seo.tags).toContain('twitch live');
    expect(seo.thumbnailHeadline).toBe('Twitch Multiview');
  });

  test('buildLiveDescription includes member perks and streamers', () => {
    const desc = buildLiveDescription({
      hookLine: '⚽ LIVE NOW: Brazil vs Morocco',
      streamers: [{ login: 'lacy' }, { login: 'ishowspeed' }],
      hashtags: ['WorldCup', 'ClipzWorldNews'],
      skipTagLine: true,
    });
    expect(desc).toContain('!listen 1-4');
    expect(desc).toContain('🔥 Lacy');
    expect(desc).toContain('#ClipzWorldNews');
    expect(desc).not.toContain('Tags:');
  });

  test('displayName formats logins', () => {
    expect(displayName('ow_esports')).toBe('OwEsports');
    expect(displayName('ishowspeed')).toBe('Ishowspeed');
  });
});
