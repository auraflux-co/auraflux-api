'use strict';

const { buildSoloLiveSeo } = require('../lib/live_grid/solo_seo');

describe('solo_seo fleet mode', () => {
  const prevMode = process.env.LIVE_GRID_PROGRAM_MODE;

  afterEach(() => {
    if (prevMode != null) process.env.LIVE_GRID_PROGRAM_MODE = prevMode;
    else delete process.env.LIVE_GRID_PROGRAM_MODE;
  });

  test('fleet slot uses dedicated slot copy and support promo', () => {
    process.env.LIVE_GRID_PROGRAM_MODE = 'solo_roster';
    const seo = buildSoloLiveSeo({ login: 'maya', fleetSlot: 8, streamerLock: true });
    expect(seo.title).toMatch(/maya/i);
    expect(seo.description).toMatch(/slot 8/i);
    expect(seo.description).toMatch(/ko-fi\.com\/clipzworldnews/);
    expect(seo.description).not.toMatch(/MAIN 2×2 GRID/);
    expect(seo.description).not.toMatch(/no minimum time/i);
  });
});
