'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildArgs } = require('../lib/live_grid/compositor');
const {
  twitchWatchUrl,
  rtspQuadUrl,
  resolveLocalPreviewConfig,
} = require('../lib/live_grid/local_preview');

describe('local_preview', () => {
  it('builds twitch watch URLs', () => {
    assert.equal(twitchWatchUrl('hasanabi'), 'https://www.twitch.tv/hasanabi');
    assert.equal(twitchWatchUrl(null), null);
  });

  it('builds rtsp quad URLs', () => {
    assert.equal(rtspQuadUrl('rtsp://localhost:8554', 2), 'rtsp://localhost:8554/quad2');
  });

  it('resolveLocalPreviewConfig includes hls and watch page', () => {
    const cfg = resolveLocalPreviewConfig();
    assert.ok(cfg.hlsUrl.includes('/broadcast/preview-hls/'));
    assert.ok(cfg.watchPageUrl.includes('/broadcast/local-watch'));
  });
});

describe('compositor local output', () => {
  it('uses tee when RTMP + local HLS path', () => {
    const args = buildArgs({
      output: 'rtmp://a/live/x',
      localHlsPath: '/tmp/preview/index.m3u8',
      audioQuad: 1,
    });
    const teeIdx = args.indexOf('tee');
    assert.ok(teeIdx >= 0);
    assert.ok(args[teeIdx + 1].includes('flv'));
    assert.ok(args[teeIdx + 1].includes('hls'));
  });

  it('uses hls format for local-only output', () => {
    const args = buildArgs({
      output: '/tmp/preview/index.m3u8',
      audioQuad: 0,
    });
    assert.ok(args.includes('hls'));
    assert.ok(args.includes('/tmp/preview/index.m3u8'));
  });
});

describe('relay audio copy', () => {
  it('copies audio when relay transcodes video', () => {
    const prev = process.env.LIVE_GRID_RELAY_TRANSCODE;
    process.env.LIVE_GRID_RELAY_TRANSCODE = 'on';
    delete require.cache[require.resolve('../lib/live_grid/relays')];
    const { relayOutputArgs } = require('../lib/live_grid/relays');
    const args = relayOutputArgs();
    assert.ok(args.includes('-c:a'));
    assert.ok(args.includes('copy'));
    assert.ok(!args.some((a) => String(a).includes('aresample')));
    process.env.LIVE_GRID_RELAY_TRANSCODE = prev;
    delete require.cache[require.resolve('../lib/live_grid/relays')];
  });
});
