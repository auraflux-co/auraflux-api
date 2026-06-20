const { readYoutubeListing, loadDeadBroadcastIds } = require('../lib/live_grid/youtube_listing_env');

describe('youtube listing env', () => {
  const origBid = process.env.LIVE_GRID_BROADCAST_ID;

  afterEach(() => {
    if (origBid === undefined) delete process.env.LIVE_GRID_BROADCAST_ID;
    else process.env.LIVE_GRID_BROADCAST_ID = origBid;
  });

  test('loadDeadBroadcastIds includes known dead listing from go_live config', () => {
    const dead = loadDeadBroadcastIds();
    expect(dead.has('07nAcIokb6Y')).toBe(true);
  });

  test('readYoutubeListing marks stale when id is in dead list', () => {
    process.env.LIVE_GRID_BROADCAST_ID = '07nAcIokb6Y';
    const listing = readYoutubeListing();
    expect(listing.stale).toBe(true);
  });
});
