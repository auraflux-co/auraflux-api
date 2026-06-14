const { applyClipFilters, sortSportsClips, listSources, normalizeCategoryIds, discovery } = require('../lib/sports');
const { extractHlsUrl } = require('../lib/sports/adapters/espn');
const { resolveEspnLeagueKey, parseWebSegments } = require('../lib/sports/adapters/espn_discovery');

describe('lib/sports', () => {
  test('listSources includes discovered ESPN leagues', async () => {
    await discovery.getEspnRegistry(true);
    const { espnLeagues, bbcCategories, probeWindowHours, espnLeagueCount } = listSources();
    expect(espnLeagueCount).toBeGreaterThan(50);
    expect(espnLeagues.find(l => l.id === 'nba')).toBeTruthy();
    expect(espnLeagues.find(l => l.id === 'fifa.world')).toBeTruthy();
    expect(bbcCategories.find(c => c.id === 'football')).toBeTruthy();
    expect(probeWindowHours).toBe(48);
  });

  test('worldcup URL segment resolves to fifa.world', async () => {
    const reg = await discovery.getEspnRegistry(true);
    expect(resolveEspnLeagueKey('worldcup', reg)).toBe('fifa.world');
    expect(parseWebSegments('https://www.espn.com/soccer/worldcup/', 'soccer')).toContain('worldcup');
  });

  test('normalizeCategoryIds resolves legacy aliases', async () => {
    await discovery.getEspnRegistry(true);
    const ids = normalizeCategoryIds(['worldcup', 'nba', 'epl']);
    expect(ids).toContain('fifa.world');
    expect(ids).toContain('nba');
    expect(ids).toContain('eng.1');
  });

  test('applyClipFilters duration + pub window', () => {
    const now = Date.now();
    const videos = [
      { duration: 30, publishedAt: new Date(now - 3600000).toISOString() },
      { duration: 120, publishedAt: new Date(now - 3600000).toISOString() },
      { duration: 28, publishedAt: new Date(now - 9 * 86400000).toISOString() },
    ];
    const out = applyClipFilters(videos, { durMin: 20, durMax: 60, pubHours: 24 });
    expect(out).toHaveLength(1);
    expect(out[0].duration).toBe(30);
  });

  test('sortSportsClips prefers ~30s', () => {
    const sorted = sortSportsClips([
      { duration: 90, publishedAt: '2026-06-14T12:00:00Z' },
      { duration: 32, publishedAt: '2026-06-14T10:00:00Z' },
      { duration: 28, publishedAt: '2026-06-14T11:00:00Z' },
    ]);
    expect(sorted[0].duration).toBe(28);
  });
});

describe('espn adapter', () => {
  test('extractHlsUrl prefers HLS HD', () => {
    const url = extractHlsUrl({
      links: { source: { HLS: { HD: { href: 'https://example.com/v.m3u8' } } } },
    });
    expect(url).toContain('.m3u8');
  });
});
