const {
  isFeedUrlAllowed,
  assertFeedUrlAllowed,
  feedSpecForEvent,
  loadFeedSources,
} = require('../lib/live_grid/feed_allowlist');
const { scoreFeed, pickEventFeed, clearEventFeedCache } = require('../lib/live_grid/event_feed_picker');
const { buildQuadrantSources, loadPrograms } = require('../lib/live_grid/program_director');

describe('live_grid event feed', () => {
  test('isFeedUrlAllowed permits YouTube and blocks ESPN wire paths', () => {
    expect(isFeedUrlAllowed('https://www.youtube.com/watch?v=abc123')).toBe(true);
    expect(isFeedUrlAllowed('https://www.twitch.tv/eslcs')).toBe(true);
    expect(isFeedUrlAllowed('https://kick.com/xqc')).toBe(true);
    expect(isFeedUrlAllowed('https://trovo.live/s/Shroud')).toBe(true);
    expect(isFeedUrlAllowed('https://dlive.tv/IcePoseidon')).toBe(true);
    expect(isFeedUrlAllowed('https://rumble.com/c/Timcast')).toBe(true);
    expect(isFeedUrlAllowed('https://chzzk.naver.com/live/abc123')).toBe(true);
    expect(isFeedUrlAllowed('https://www.nimo.tv/live/foo')).toBe(true);
    expect(isFeedUrlAllowed('https://www.espn.com/watch/player?id=123')).toBe(false);
    expect(isFeedUrlAllowed('https://www.reuters.com/video/foo')).toBe(false);
  });

  test('assertFeedUrlAllowed throws on blocked URL', () => {
    expect(() => assertFeedUrlAllowed('https://www.espn.com/live/stuff')).toThrow(/not allowlisted/);
  });

  test('feedSpecForEvent loads sports_watchalong pins', () => {
    const spec = feedSpecForEvent('sports_watchalong', loadFeedSources());
    expect(spec?.twitchPins?.length).toBeGreaterThan(0);
    expect(spec?.youtubeQueries?.length).toBeGreaterThan(0);
  });

  test('scoreFeed boosts space titles for space_launch', () => {
    const generic = scoreFeed({ viewers: 100, title: 'random', channel: 'x' }, 'space_launch');
    const space = scoreFeed({ viewers: 100, title: 'SpaceX Starship launch', channel: 'NASASpaceflight' }, 'space_launch');
    expect(space).toBeGreaterThan(generic);
  });

  test('buildQuadrantSources event_night prefers feed over file', () => {
    const config = loadPrograms();
    const poller = ['a', 'b', 'c', 'd'];
    const tmpFeed = {
      url: 'https://www.youtube.com/watch?v=live123',
      title: 'Live Match',
      channel: 'Test',
    };
    const { sources } = buildQuadrantSources('event_night', config, poller, {}, { event_feed: tmpFeed });
    expect(sources[0]).toEqual({
      type: 'url',
      url: tmpFeed.url,
      label: 'EVENT',
      title: 'Live Match',
    });
    expect(sources.slice(1)).toEqual(['b', 'c', 'd']);
  });

  test('buildQuadrantSources event_night falls back to file when no feed', () => {
    const config = loadPrograms();
    const tmp = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'lg-feed-'));
    const event = require('path').join(tmp, 'event.mp4');
    require('fs').writeFileSync(event, 'x');
    const { sources } = buildQuadrantSources('event_night', config, ['a', 'b', 'c', 'd'], { event_primary: event }, {});
    expect(sources[0]).toEqual({ type: 'file', path: event, label: 'EVENT' });
    require('fs').rmSync(tmp, { recursive: true, force: true });
  });

  test('pickEventFeed uses LIVE_GRID_EVENT_FEED_URL when set', async () => {
    const prev = process.env.LIVE_GRID_EVENT_FEED_URL;
    clearEventFeedCache();
    process.env.LIVE_GRID_EVENT_FEED_URL = 'https://www.youtube.com/watch?v=envtest';
    const feed = await pickEventFeed({ eventId: 'sports_watchalong' });
    expect(feed?.url).toContain('envtest');
    if (prev === undefined) delete process.env.LIVE_GRID_EVENT_FEED_URL;
    else process.env.LIVE_GRID_EVENT_FEED_URL = prev;
    clearEventFeedCache();
  });
});
