'use strict';

const {
  upsertCreator,
  recordLiveGridStream,
  getStreamerRosterLogins,
  seedFromStreamerSources,
  resolveForPicker,
  loadRegistry,
} = require('../lib/creator_registry');
const { parseInput } = require('../lib/creator_registry/resolve');

describe('creator_registry', () => {
  beforeAll(() => {
    seedFromStreamerSources();
  });

  test('upsertCreator adds twitch streamer', () => {
    const { creator, created } = upsertCreator({
      id: 'teststreamer_xyz',
      displayName: 'Test',
      platform: 'twitch',
      platformData: { login: 'teststreamer_xyz' },
      source: 'unit_test',
    });
    expect(created).toBe(true);
    expect(creator.platforms.twitch.login).toBe('teststreamer_xyz');
  });

  test('recordLiveGridStream increments seen count', () => {
    recordLiveGridStream('testgrid_user', { reason: 'live_poll', viewers: 100 });
    const c = loadRegistry().creators.testgrid_user;
    expect(c).toBeTruthy();
    expect(c.liveGridSeenCount).toBeGreaterThan(0);
    expect(c.sources).toContain('live_grid');
  });

  test('parseInput detects platforms', () => {
    expect(parseInput('https://twitch.tv/ninja').platform).toBe('twitch');
    expect(parseInput('https://kick.com/xqc').platform).toBe('kick');
    expect(parseInput('@SomeChannel').platform).toBe('youtube');
  });

  test('resolveForPicker returns platform from registry', () => {
    upsertCreator({
      id: 'kickuser_test',
      platform: 'kick',
      platformData: { slug: 'kickuser_test' },
      source: 'unit_test',
    });
    const r = resolveForPicker('kickuser_test');
    expect(r.platform).toBe('kick');
  });

  test('getStreamerRosterLogins includes seeded and added', () => {
    const roster = getStreamerRosterLogins();
    expect(roster.length).toBeGreaterThan(0);
    expect(roster).toContain('teststreamer_xyz');
  });
});
