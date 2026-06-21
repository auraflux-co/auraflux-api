'use strict';

const { kickStreamlinkIngestEnabled, kickPageUrl } = require('../lib/live_grid/kick_config');
const { streamlinkProbeArgs } = require('../lib/live_grid/stream_probe');

describe('kick_config', () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    process.env = { ...envBackup };
  });

  test('kickPageUrl builds channel page', () => {
    expect(kickPageUrl('deenthegreat')).toBe('https://kick.com/deenthegreat');
  });

  test('streamlink ingest default on Render', () => {
    delete process.env.LIVE_GRID_KICK_INGEST;
    delete process.env.RENDER;
    expect(kickStreamlinkIngestEnabled()).toBe(false);
    process.env.RENDER = 'true';
    expect(kickStreamlinkIngestEnabled()).toBe(true);
  });

  test('explicit hls disables streamlink even on Render', () => {
    process.env.RENDER = 'true';
    process.env.LIVE_GRID_KICK_INGEST = 'hls';
    expect(kickStreamlinkIngestEnabled()).toBe(false);
  });
});

describe('stream_probe kick args', () => {
  test('streamlinkProbeArgs adds kick-low-latency for kick.com', () => {
    expect(streamlinkProbeArgs('https://kick.com/xqc')).toEqual([
      '--kick-low-latency', '--stream-url', 'https://kick.com/xqc', 'best',
    ]);
  });

  test('streamlinkProbeArgs adds twitch flags for twitch', () => {
    expect(streamlinkProbeArgs('twitch.tv/xqc')).toEqual([
      '--twitch-disable-ads', '--twitch-low-latency', '--stream-url', 'twitch.tv/xqc', 'best',
    ]);
  });
});
