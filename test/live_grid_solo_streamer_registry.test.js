'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

describe('solo_streamer_registry (CPD-1064)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solo-reg-'));
  const env = { ...process.env };

  beforeEach(() => {
    process.env = {
      ...env,
      LIVE_GRID_SOLO_STREAMS: 'on',
      LIVE_GRID_SOLO_STREAMER_LOCK: 'on',
      LIVE_GRID_RESUME_DIR: tmpDir,
    };
    for (let i = 1; i <= 4; i++) {
      process.env[`LIVE_GRID_SOLO_${i}_RTMP_URL`] = `rtmp://a.rtmp.youtube.com/live2/key${i}`;
      process.env[`LIVE_GRID_SOLO_${i}_BROADCAST_ID`] = `bid${i}`;
      process.env[`LIVE_GRID_SOLO_${i}_WATCH_URL`] = `https://youtube.com/live/bid${i}`;
    }
    jest.resetModules();
  });

  afterEach(() => {
    process.env = env;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    jest.resetModules();
  });

  test('assigns stable watch URL per login until they leave the grid', () => {
    const reg = require('../lib/live_grid/solo_streamer_registry');
    reg.syncBindingsForAssignments(['maya', 'ludwig', null, null]);
    expect(reg.watchUrlForLogin('maya')).toBe('https://youtube.com/live/bid1');
    expect(reg.watchUrlForLogin('ludwig')).toBe('https://youtube.com/live/bid2');

    reg.syncBindingsForAssignments([null, null, 'maya', 'ludwig']);
    expect(reg.watchUrlForLogin('maya')).toBe('https://youtube.com/live/bid1');
    expect(reg.watchUrlForLogin('ludwig')).toBe('https://youtube.com/live/bid2');
    expect(reg.getBinding('maya').currentQuadrant).toBe(3);
  });

  test('releases slot when streamer leaves grid', () => {
    const reg = require('../lib/live_grid/solo_streamer_registry');
    reg.syncBindingsForAssignments(['maya', null, null, null]);
    expect(reg.getBinding('maya')).toBeTruthy();
    reg.syncBindingsForAssignments([null, null, null, null]);
    expect(reg.getBinding('maya')).toBeNull();
  });

  test('resolveRtmpForQuadrant uses login binding not quadrant env after swap', () => {
    const reg = require('../lib/live_grid/solo_streamer_registry');
    reg.syncBindingsForAssignments(['maya', null, null, null]);
    expect(reg.resolveRtmpForQuadrant(0, 'maya')).toContain('key1');
    reg.syncBindingsForAssignments([null, null, 'maya', null]);
    expect(reg.resolveRtmpForQuadrant(2, 'maya')).toContain('key1');
    expect(reg.resolveRtmpForQuadrant(0, 'maya')).toContain('key1');
  });

  test('buildSoloLiveTitle omits Screen N when streamer lock on', () => {
    const { buildSoloLiveTitle } = require('../lib/live_grid/solo_seo');
    const title = buildSoloLiveTitle('maya', 2, new Date(), { streamerLock: true });
    expect(title.toLowerCase()).toContain('maya');
    expect(title).not.toContain('Screen 3');
  });

  test('buildLineupMessage uses stable streamer URLs when locked', () => {
    const reg = require('../lib/live_grid/solo_streamer_registry');
    reg.syncBindingsForAssignments(['maya', 'ludwig', null, null]);
    const { buildLineupMessage } = require('../lib/live_grid/solo_announce');
    const text = buildLineupMessage({
      mainWatchUrl: 'https://youtube.com/live/main',
      assignments: [null, null, 'maya', 'ludwig'],
    });
    expect(text).toContain('@maya full-screen (Screen 3): https://youtube.com/live/bid1');
    expect(text).toContain('@ludwig full-screen (Screen 4): https://youtube.com/live/bid2');
  });

  test('applyLoginSlotMap hotswaps pool slots for active streamers', () => {
    const reg = require('../lib/live_grid/solo_streamer_registry');
    reg.syncBindingsForAssignments(['maya', 'ludwig', null, null]);
    expect(reg.getBinding('maya').slot).toBe(1);
    reg.applyLoginSlotMap({ maya: 3, ludwig: 1 }, ['maya', 'ludwig', null, null]);
    expect(reg.getBinding('maya').slot).toBe(3);
    expect(reg.getBinding('maya').watchUrl).toBe('https://youtube.com/live/bid3');
    expect(reg.getBinding('ludwig').slot).toBe(1);
    expect(reg.getBinding('maya').pinned).toBe(true);
  });
});
