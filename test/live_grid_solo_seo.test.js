const { buildSoloLiveSeo } = require('../lib/live_grid/solo_seo');
const { buildYoutubeTags } = require('../lib/live_grid/seo');
const { isBlockedTag, _ytTags, resolveLivePlaylistIdFromConfig } = require('../lib/services/youtube_direct');

describe('live_grid solo SEO (CPD-1047)', () => {
  test('buildSoloLiveSeo produces title, tags, description with cross-links', () => {
    const seo = buildSoloLiveSeo({
      login: 'xqc',
      quadrant: 0,
      mainWatchUrl: 'https://youtube.com/live/main123',
      gridLogins: ['xqc', 'shroud', 'pokimane', 'ludwig'],
    });
    expect(seo.title).toMatch(/^🔴 LIVE:/);
    expect(seo.title).toContain('#xqc');
    expect(seo.title.length).toBeLessThanOrEqual(100);
    expect(seo.description).toContain('MAIN 2×2 GRID: https://youtube.com/live/main123');
    expect(seo.description).toContain('twitch.tv/xqc');
    expect(seo.description).toContain('#ClipzWorldNews');
    expect(seo.tags.length).toBeGreaterThan(5);
    expect(seo.thumbnailSubline).toContain('Screen 1');
  });

  test('buildYoutubeTags solo mode adds solo-specific pool tags', () => {
    const tags = buildYoutubeTags([{ login: 'xqc', displayName: 'Xqc' }], { mode: 'solo' });
    expect(tags.some((t) => /solo/i.test(t))).toBe(true);
    expect(tags).not.toContain('robert@businessrocket.ai');
  });

  test('blocked tags strip email and businessrocket from tag sets', () => {
    expect(isBlockedTag('robert@businessrocket.ai')).toBe(true);
    expect(isBlockedTag('businessrocket')).toBe(true);
    expect(isBlockedTag('contact@example.com')).toBe(true);
    expect(isBlockedTag('twitch')).toBe(false);
    const out = _ytTags(['twitch', 'robert@businessrocket.ai', 'gaming', 'businessrocket.ai']);
    expect(out).toEqual(['twitch', 'gaming']);
  });

  test('buildSoloLiveTitle matches main grid hashtag format with Screen suffix', () => {
    const { buildSoloLiveTitle } = require('../lib/live_grid/solo_seo');
    const title = buildSoloLiveTitle('hasanabi', 1, new Date('2026-06-20T18:00:00Z'));
    expect(title).toMatch(/^🔴 LIVE: 06\.20\.26 \| #hasanabi #twitch \| Screen 2$/);
    expect(title.length).toBeLessThanOrEqual(100);
  });

  test('normalizeSoloLogin rejects generic Screen N labels', () => {
    const { normalizeSoloLogin } = require('../lib/live_grid/solo_seo');
    expect(normalizeSoloLogin('Screen 1')).toBe('');
    expect(normalizeSoloLogin('eliasn97')).toBe('eliasn97');
  });
});
