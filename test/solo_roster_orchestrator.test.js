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
    process.env.LIVE_GRID_FLEET_KICK_RTSP_WAIT_MS = '100';
    process.env.LIVE_GRID_FLEET_SOLO_WAIT_MS = '100';
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

  test('paused kick slots do not start when source is live', async () => {
    twitchChannelLive.mockResolvedValue(false);
    kickChannelLive.mockImplementation(async (slug) => slug === 'n3on');

    const manager = {
      log: jest.fn(),
      feeders: {
        setQuadrant: jest.fn(),
        setQuadrantKick: jest.fn(),
        status: () => Array.from({ length: 5 }, () => ({ kind: 'url', pids: [1] })),
      },
      setQuadrantKick: jest.fn(),
      soloPublishers: {
        stopped: false,
        started: false,
        start: jest.fn(),
        stopSeat: jest.fn(),
        procs: [{ exitCode: null, killed: false }, null, null, null, null],
      },
      _canReuseBroadcastId: jest.fn().mockResolvedValue(true),
      _applySoloYoutubeSeo: jest.fn(),
    };

    const { SoloRosterOrchestrator } = require('../lib/live_grid/solo_roster_orchestrator');
    const orch = new SoloRosterOrchestrator(manager, { fleetId: 'a' });
    orch._slotState.set(1, { phase: 'live', login: 'n3on', broadcastId: 'bid-2' });

    await orch.tick();
    expect(manager.setQuadrantKick).not.toHaveBeenCalled();
    expect(manager.soloPublishers.start).not.toHaveBeenCalled();
    expect(manager.soloPublishers.stopSeat).toHaveBeenCalledWith(1);
    expect(yt.endLiveBroadcast).toHaveBeenCalledWith('bid-2');
    orch.stop();
  });

  test('twitch slot accepts channel feeder as ingest-ready (not kick-only url)', async () => {
    twitchChannelLive.mockImplementation(async (login) => login === 'plaqueboymax');
    kickChannelLive.mockResolvedValue(false);

    const log = jest.fn();
    const feederStatus = () => [
      { kind: 'url', pids: [1] },
      { kind: 'slate', pids: [1] },
      { kind: 'channel', pids: [11, 22] },
      { kind: 'slate', pids: [1] },
      { kind: 'slate', pids: [1] },
    ];
    const manager = {
      log,
      feeders: {
        setQuadrant: jest.fn(),
        setQuadrantKick: jest.fn(),
        status: feederStatus,
      },
      setQuadrantKick: jest.fn(),
      soloPublishers: {
        stopped: false,
        started: false,
        start: jest.fn(),
        stopSeat: jest.fn(),
        procs: [null, null, { exitCode: null, killed: false }, null, null],
      },
      _canReuseBroadcastId: jest.fn().mockResolvedValue(true),
      _applySoloYoutubeSeo: jest.fn().mockResolvedValue({ seo: {}, result: {} }),
    };

    const { SoloRosterOrchestrator } = require('../lib/live_grid/solo_roster_orchestrator');
    const orch = new SoloRosterOrchestrator(manager, { fleetId: 'a' });

    await orch.tick();
    expect(manager.feeders.setQuadrant).toHaveBeenCalledWith(2, 'plaqueboymax');
    expect(manager.soloPublishers.start).toHaveBeenCalledWith(2, 'plaqueboymax');
    orch.stop();
  });
});
