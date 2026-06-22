'use strict';

jest.mock('../lib/clients/kick_live_resolver', () => ({
  fetchKickChannelApi: jest.fn(),
}));

const { fetchKickChannelApi } = require('../lib/clients/kick_live_resolver');
const { kickChannelLive } = require('../lib/live_grid/stream_probe');

describe('kickChannelLive', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test('returns true when Kick API reports livestream', async () => {
    fetchKickChannelApi.mockResolvedValue({
      livestream: { session_title: 'live' },
      playback_url: 'https://x.m3u8',
    });
    await expect(kickChannelLive('deenthegreat')).resolves.toBe(true);
    expect(fetchKickChannelApi).toHaveBeenCalledWith('deenthegreat');
  });

  test('returns false when Kick API reports channel offline', async () => {
    fetchKickChannelApi.mockResolvedValue({ slug: 'neon', livestream: null });
    await expect(kickChannelLive('neon')).resolves.toBe(false);
  });

  test('returns false for empty slug without calling API', async () => {
    await expect(kickChannelLive('')).resolves.toBe(false);
    expect(fetchKickChannelApi).not.toHaveBeenCalled();
  });
});
