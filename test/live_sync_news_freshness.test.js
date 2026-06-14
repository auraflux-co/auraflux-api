jest.mock('axios');

const { effectiveYoutubeMode } = require('../lib/calendar/live_sync');

describe('effectiveYoutubeMode news freshness gate', () => {
  const origMax = process.env.NEWS_DESK_MAX_AGE_HOURS;

  afterEach(() => {
    if (origMax === undefined) delete process.env.NEWS_DESK_MAX_AGE_HOURS;
    else process.env.NEWS_DESK_MAX_AGE_HOURS = origMax;
  });

  test('returns grid when news_desk requested but no fresh VOD', () => {
    process.env.NEWS_DESK_MAX_AGE_HOURS = '24';
    expect(effectiveYoutubeMode('news_desk')).toBe('grid');
  });

  test('passes through non-news modes unchanged', () => {
    expect(effectiveYoutubeMode('grid')).toBe('grid');
    expect(effectiveYoutubeMode('event_night')).toBe('event_night');
  });
});
