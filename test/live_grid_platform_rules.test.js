const { mergePlatformBench } = require('../lib/live_grid/discovery');
const { isTwitchTvPlayable, eventAllowed } = require('../lib/live_grid/rights_registry');
const { aggregateByHour, recommendGridWindow } = require('../lib/live_grid/hourly_analytics');
const { parseWindow } = require('../lib/services/stream_scheduler');

describe('live_grid platform bench', () => {
  test('mergePlatformBench dedupes roster and ranks platform by viewers', () => {
    const bench = mergePlatformBench({
      roster: ['a', 'b'],
      follows: ['c', 'd'],
      platform: [{ login: 'e', viewers: 5000 }, { login: 'c', viewers: 100 }, { login: 'a', viewers: 9999 }],
    });
    expect(bench).toContain('c');
    expect(bench).toContain('d');
    expect(bench).toContain('e');
    expect(bench.indexOf('e')).toBeLessThan(bench.indexOf('d'));
    expect(bench).not.toContain('a');
  });
});

describe('live_grid rights / twitch tv', () => {
  test('allows produced news vod on twitch loop', () => {
    expect(isTwitchTvPlayable('cwn_22clips_script_news_1778523540964.mp4', 5_000_000)).toBe(true);
  });
  test('blocks grid recording and raw clip comp', () => {
    expect(isTwitchTvPlayable('live_grid_recording.mp4', 5_000_000)).toBe(false);
    expect(isTwitchTvPlayable('clips_comp_foo.mp4', 5_000_000)).toBe(false);
  });
  test('trial events exist on allowlist', () => {
    expect(eventAllowed('sports_watchalong')?.tier).toBe('yellow');
    expect(eventAllowed('breaking_news_wall')?.tier).toBe('green');
  });
});

describe('live_grid hourly schedule recommend', () => {
  test('parseWindow accepts 00:00-24:00 full day', () => {
    const w = parseWindow('00:00-24:00', null);
    expect(w.start).toBe(0);
    expect(w.end).toBe(1440);
  });
  test('recommendGridWindow picks a window', () => {
    const hourly = aggregateByHour([
      { hour: 20, views: 10, estimatedMinutesWatched: 100 },
      { hour: 21, views: 10, estimatedMinutesWatched: 200 },
      { hour: 22, views: 10, estimatedMinutesWatched: 150 },
    ]);
    const rec = recommendGridWindow(hourly, { minHours: 3, maxHours: 3 });
    expect(rec.windowEt).toMatch(/\d{2}:00-\d{2}:00/);
  });
});
