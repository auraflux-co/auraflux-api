'use strict';

jest.mock('../lib/live_grid/stream_probe', () => ({
  twitchChannelLive: jest.fn(),
  kickChannelLive: jest.fn(),
}));

jest.mock('../lib/live_grid/rtsp_probe', () => ({
  rtspHasVideo: jest.fn().mockResolvedValue(true),
}));

jest.mock('../lib/services/youtube_direct', () => ({
  isConnected: jest.fn().mockReturnValue(true),
  endLiveBroadcast: jest.fn().mockResolvedValue({ ok: true }),
  createLiveBroadcast: jest.fn(),
}));

jest.mock('../lib/clients/kick_live_resolver', () => ({
  fetchKickChannelApi: jest.fn().mockResolvedValue({ slug: 'deenthegreat', livestream: null }),
}));

const { twitchChannelLive, kickChannelLive } = require('../lib/live_grid/stream_probe');
const yt = require('../lib/services/youtube_direct');

describe('SoloRosterOrchestrator tick', () => {
  const prev = {
    mode: process.env.LIVE_GRID_PROGRAM_MODE,
    dir: process.env.LIVE_GRID_RESUME_DIR,
    goLiveWait: process.env.LIVE_GRID_YOUTUBE_GO_LIVE_WAIT,
    fleetId: process.env.LIVE_GRID_FLEET_ID,
  };

  beforeAll(() => {
    process.env.LIVE_GRID_PROGRAM_MODE = 'solo_roster';
    process.env.LIVE_GRID_RESUME_DIR = '/tmp/cwn-fleet-test';
    process.env.LIVE_GRID_YOUTUBE_GO_LIVE_WAIT = 'off';
    process.env.LIVE_GRID_FLEET_RTSP_WAIT_MS = '100';
    process.env.LIVE_GRID_FLEET_ID = 'a';
    for (let i = 1; i <= 5; i++) {
      process.env[`LIVE_GRID_SOLO_${i}_RTMP_URL`] = `rtmp://a.rtmp.youtube.com/live2/key${i}`;
      process.env[`LIVE_GRID_SOLO_${i}_STREAM_ID`] = `stream-${i}`;
      process.env[`LIVE_GRID_SOLO_${i}_BROADCAST_ID`] = `bid-${i}`;
    }
  });

  afterAll(() => {
    for (const [k, v] of Object.entries(prev)) {
      const key = k === 'mode' ? 'LIVE_GRID_PROGRAM_MODE'
        : k === 'dir' ? 'LIVE_GRID_RESUME_DIR'
        : k === 'goLiveWait' ? 'LIVE_GRID_YOUTUBE_GO_LIVE_WAIT'
        : 'LIVE_GRID_FLEET_ID';
      if (v != null) process.env[key] = v;
      else delete process.env[key];
    }
  });

  test('starts slot when probe live and stops when offline', async () => {
    twitchChannelLive.mockResolvedValue(false);
    kickChannelLive.mockImplementation(async (slug) => slug === 'deenthegreat');

    const log = jest.fn();
    const feederStatus = () => Array.from({ length: 5 }, () => ({ kind: 'url', pids: [1] }));
    const manager = {
      log,
      feeders: {
        setQuadrant: jest.fn(),
        setQuadrantKick: jest.fn(),
        status: feederStatus,
      },
      setQuadrantKick: jest.fn().mockResolvedValue({ kind: 'url', pids: [1], locked: true }),
      soloPublishers: {
        stopped: false,
        started: false,
        start: jest.fn(),
        stopSeat: jest.fn(),
      },
      _canReuseBroadcastId: jest.fn().mockResolvedValue(true),
      _applySoloYoutubeSeo: jest.fn().mockResolvedValue({ seo: {}, result: {} }),
    };

    const { SoloRosterOrchestrator } = require('../lib/live_grid/solo_roster_orchestrator');
    const orch = new SoloRosterOrchestrator(manager, { fleetId: 'a' });

    await orch.tick();
    expect(manager.setQuadrantKick).toHaveBeenCalled();
    expect(manager.soloPublishers.start).toHaveBeenCalled();

    kickChannelLive.mockResolvedValue(false);
    await orch.tick();
    expect(manager.soloPublishers.stopSeat).toHaveBeenCalled();
    expect(yt.endLiveBroadcast).toHaveBeenCalledWith('bid-1');
    orch.stop();
  });
});
