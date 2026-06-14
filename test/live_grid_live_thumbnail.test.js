const { resolveCopy, MODE_DEFAULTS } = require('../lib/live_grid/live_thumbnail');

describe('live_thumbnail resolveCopy', () => {
  test('news_desk rejects hallucinated sports/apple headlines', () => {
    const r = resolveCopy({
      programMode: 'news_desk',
      headline: 'Apple iPhone 15 Event',
      subline: 'Live Reactions',
    });
    expect(r.head).toBe(MODE_DEFAULTS.news_desk.headline);
    expect(r.sub).toBe(MODE_DEFAULTS.news_desk.subline);
  });

  test('grid keeps streamer names', () => {
    const r = resolveCopy({
      programMode: 'grid',
      headline: 'Brazil vs Morocco',
      streamers: [{ login: 'ishowspeed', displayName: 'IShowSpeed' }],
    });
    expect(r.names).toContain('IShowSpeed');
  });
});
