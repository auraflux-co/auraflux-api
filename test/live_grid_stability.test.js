describe('youtube_go_live (CPD-1047)', () => {
  beforeEach(() => {
    jest.resetModules();
    delete process.env.LIVE_GRID_YOUTUBE_GO_LIVE_WAIT;
    delete process.env.LIVE_GRID_YOUTUBE_GO_LIVE_WAIT_MS;
    delete process.env.LIVE_GRID_YOUTUBE_GO_LIVE_POLL_MS;
  });

  test('goLiveWaitEnabled defaults on', () => {
    const { goLiveWaitEnabled } = require('../lib/live_grid/youtube_go_live');
    expect(goLiveWaitEnabled()).toBe(true);
    process.env.LIVE_GRID_YOUTUBE_GO_LIVE_WAIT = 'off';
    jest.resetModules();
    expect(require('../lib/live_grid/youtube_go_live').goLiveWaitEnabled()).toBe(false);
  });

  test('waitForYoutubeLive resolves when status is live', async () => {
    jest.doMock('../lib/services/youtube_direct', () => ({
      isConnected: () => true,
      getBroadcastStatus: async () => ({ lifeCycleStatus: 'live', title: 't' }),
    }));
    const { waitForYoutubeLive } = require('../lib/live_grid/youtube_go_live');
    const r = await waitForYoutubeLive('abc123', { pollMs: 10, timeoutMs: 500 });
    expect(r.live).toBe(true);
    expect(r.lifeCycleStatus).toBe('live');
    jest.dontMock('../lib/services/youtube_direct');
  });

  test('waitForYoutubeLive times out on ready', async () => {
    jest.doMock('../lib/services/youtube_direct', () => ({
      isConnected: () => true,
      getBroadcastStatus: async () => ({ lifeCycleStatus: 'ready' }),
    }));
    const { waitForYoutubeLive } = require('../lib/live_grid/youtube_go_live');
    const r = await waitForYoutubeLive('abc123', { pollMs: 20, timeoutMs: 60 });
    expect(r.live).toBe(false);
    expect(r.reason).toBe('timeout');
    jest.dontMock('../lib/services/youtube_direct');
  });
});

describe('live_grid resume_state env fallback', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-resume-'));
    process.env.LIVE_GRID_RESUME_DIR = tmpDir;
    process.env.LIVE_GRID_BROADCAST_ID = 'TestBroadcast1';
    process.env.LIVE_GRID_WATCH_URL = 'https://youtube.com/live/TestBroadcast1';
    process.env.LIVE_GRID_RTMP_URL = 'rtmp://a.rtmp.youtube.com/live2/key';
    jest.resetModules();
  });

  afterEach(() => {
    delete process.env.LIVE_GRID_RESUME_DIR;
    delete process.env.LIVE_GRID_BROADCAST_ID;
    delete process.env.LIVE_GRID_WATCH_URL;
    delete process.env.LIVE_GRID_RTMP_URL;
    delete process.env.LIVE_GRID_WAS_LIVE;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  test('buildEnvResumeFallback returns null without was_live flag', () => {
    const { buildEnvResumeFallback } = require('../lib/live_grid/resume_state');
    expect(buildEnvResumeFallback()).toBeNull();
  });

  test('buildEnvResumeFallback builds start opts when was_live set', () => {
    const { markWasLive } = require('../lib/live_grid/was_live_env');
    markWasLive();
    const { buildEnvResumeFallback } = require('../lib/live_grid/resume_state');
    const snap = buildEnvResumeFallback();
    expect(snap?.shouldResume).toBe(true);
    expect(snap?.startOpts?.broadcastId).toBe('TestBroadcast1');
    expect(snap?.startOpts?._rtmpGo).toBe(true);
  });
});

describe('solo_publishers UDP defaults (CPD-1047)', () => {
  test('soloUdpInputEnabled follows UDP relay', () => {
    delete process.env.LIVE_GRID_SOLO_UDP_INPUT;
    process.env.LIVE_GRID_UDP_RELAY = 'on';
    jest.resetModules();
    const { soloUdpInputEnabled } = require('../lib/live_grid/solo_publishers');
    expect(soloUdpInputEnabled()).toBe(true);
  });

  test('soloOutputDims defaults to 720p 1500k', () => {
    delete process.env.LIVE_GRID_SOLO_OUTPUT_W;
    delete process.env.LIVE_GRID_SOLO_OUTPUT_H;
    delete process.env.LIVE_GRID_SOLO_BITRATE_K;
    jest.resetModules();
    const { soloOutputDims } = require('../lib/live_grid/solo_publishers');
    expect(soloOutputDims()).toEqual(expect.objectContaining({ w: 1280, h: 720, bitrateK: 1500 }));
  });
});
