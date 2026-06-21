const { seatsFromSidecarStatus, syncSoloListingsFromGrid } = require('../lib/live_grid/solo_listing_sync');

describe('solo_listing_sync', () => {
  test('seatsFromSidecarStatus prefers quadrant feeder login over stale solo seat login', () => {
    const status = {
      broadcast: { watchUrl: 'https://youtube.com/live/main' },
      quadrants: [
        { quadrant: 4, login: 'alveussanctuary', channelSlug: 'alveussanctuary' },
      ],
      soloStreams: {
        seats: [{
          quadrant: 4,
          login: 'oldschoolrs',
          broadcastId: 'damkiUux4F0',
          watchUrl: 'https://youtube.com/live/damkiUux4F0',
          configured: true,
        }],
      },
    };
    const seats = seatsFromSidecarStatus(status);
    expect(seats).toHaveLength(1);
    expect(seats[0].login).toBe('alveussanctuary');
    expect(seats[0].broadcastId).toBe('damkiUux4F0');
  });

  test('syncSoloListingsFromGrid dry-run builds SEO title from grid login', async () => {
    const status = {
      broadcast: { watchUrl: 'https://youtube.com/live/main' },
      quadrants: [{ quadrant: 4, login: 'alveussanctuary' }],
      soloStreams: {
        seats: [{
          quadrant: 4,
          broadcastId: 'damkiUux4F0',
          configured: true,
        }],
      },
    };
    const yt = {
      isConnected: () => true,
      updateBroadcastListingLite: jest.fn(),
    };
    const result = await syncSoloListingsFromGrid({
      status,
      discovered: { soloBroadcastIds: { 4: 'damkiUux4F0' } },
      yt,
      quadrants: [4],
      dryRun: true,
    });
    expect(result.ok).toBe(true);
    expect(result.results[0].login).toBe('alveussanctuary');
    expect(result.results[0].title).toMatch(/alveussanctuary/i);
    expect(yt.updateBroadcastListingLite).not.toHaveBeenCalled();
  });

  test('syncSoloListingsFromGrid discoverable mode applies tags playlist path', async () => {
    const status = {
      broadcast: { watchUrl: 'https://youtube.com/live/main' },
      quadrants: [{ quadrant: 4, login: 'alveussanctuary' }],
      soloStreams: {
        seats: [{ quadrant: 4, broadcastId: 'damkiUux4F0', configured: true }],
      },
    };
    const yt = {
      isConnected: () => true,
      sanitizeChannelKeywords: jest.fn().mockResolvedValue({ changed: false }),
      applyLiveBroadcastSeoDiscoverable: jest.fn().mockResolvedValue({ ok: true, tags: true, playlist: true }),
      updateBroadcastListingLite: jest.fn(),
    };
    const result = await syncSoloListingsFromGrid({
      status,
      discovered: { soloBroadcastIds: { 4: 'damkiUux4F0' } },
      yt,
      quadrants: [4],
      seatDelayMs: 0,
    });
    expect(result.mode).toBe('discoverable');
    expect(result.ok).toBe(true);
    expect(yt.applyLiveBroadcastSeoDiscoverable).toHaveBeenCalled();
  });

  test('syncSoloListingsFromGrid updates slate seat with generic Screen title', async () => {
    const status = {
      broadcast: { watchUrl: 'https://youtube.com/live/main' },
      quadrants: [{ quadrant: 1, login: null, kind: 'slate' }],
      soloStreams: {
        seats: [{ quadrant: 1, broadcastId: 'bid1', configured: true }],
      },
    };
    const yt = { isConnected: () => true, updateBroadcastListingLite: jest.fn().mockResolvedValue({ ok: true }) };
    const result = await syncSoloListingsFromGrid({
      status,
      discovered: { soloBroadcastIds: { 1: 'bid1' } },
      yt,
      quadrants: [1],
      mode: 'lite',
      seatDelayMs: 0,
    });
    expect(result.ok).toBe(true);
    expect(result.results[0].title).toMatch(/Screen 1/i);
    expect(yt.updateBroadcastListingLite).toHaveBeenCalled();
  });
});
