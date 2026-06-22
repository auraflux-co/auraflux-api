'use strict';

const {
  kickPlaylistKey,
  kickPlaylistUrlsEquivalent,
  isKickFeed,
  kickHlsTranscodeEnabled,
  hlsFfmpegArgs,
  kickStreamlinkIngestEnabled,
  kickStreamlinkFfmpegEncodeArgs,
  kickHlsFfmpegSpawnEnv,
  KICK_CDN_HTTP_HEADERS,
} = require('../lib/live_grid/kick_ingest');

describe('kick_ingest', () => {
  test('kickPlaylistKey ignores token query', () => {
    const base = 'https://fa723fc1b171.us-west-2.playback.live-video.net/api/video/v1/us-west-2.196233775518.channel.nnDwHw8EOliy.m3u8';
    const a = `${base}?token=aaa`;
    const b = `${base}?token=bbb`;
    expect(kickPlaylistKey(a)).toBe(kickPlaylistKey(b));
    expect(kickPlaylistUrlsEquivalent(a, b)).toBe(true);
  });

  test('isKickFeed detects slug and playback url', () => {
    expect(isKickFeed({ kickSlug: 'deenthegreat' })).toBe(true);
    expect(isKickFeed({ url: 'https://kick.com/x' })).toBe(false);
    expect(isKickFeed({
      url: 'https://x.playback.live-video.net/v1/playlist/foo.m3u8',
    })).toBe(true);
  });

  test('hlsFfmpegArgs transcodes Kick by default', () => {
    const prev = process.env.LIVE_GRID_KICK_HLS_TRANSCODE;
    delete process.env.LIVE_GRID_KICK_HLS_TRANSCODE;
    expect(kickHlsTranscodeEnabled()).toBe(true);
    const args = hlsFfmpegArgs('https://x.playback.live-video.net/v1/a.m3u8', { kickSlug: 'x' });
    expect(args).toContain('libx264');
    expect(args).not.toContain('copy');
    expect(args).toContain('-headers');
    expect(args).toContain(KICK_CDN_HTTP_HEADERS);
    if (prev) process.env.LIVE_GRID_KICK_HLS_TRANSCODE = prev;
  });

  test('hlsFfmpegArgs copy for non-Kick HLS', () => {
    const args = hlsFfmpegArgs('https://example.com/live.m3u8', {});
    expect(args).toContain('-c');
    expect(args).toContain('copy');
  });

  test('kickStreamlinkIngestEnabled reads LIVE_GRID_KICK_INGEST', () => {
    const prev = process.env.LIVE_GRID_KICK_INGEST;
    delete process.env.LIVE_GRID_KICK_INGEST;
    expect(kickStreamlinkIngestEnabled()).toBe(false);
    process.env.LIVE_GRID_KICK_INGEST = 'streamlink';
    expect(kickStreamlinkIngestEnabled()).toBe(true);
    if (prev) process.env.LIVE_GRID_KICK_INGEST = prev;
    else delete process.env.LIVE_GRID_KICK_INGEST;
  });

  test('kickStreamlinkFfmpegEncodeArgs transcodes from pipe', () => {
    const args = kickStreamlinkFfmpegEncodeArgs();
    expect(args).toContain('pipe:0');
    expect(args).toContain('libx264');
  });

  test('kickHlsFfmpegSpawnEnv sets proxy on Render when configured', () => {
    const prev = {
      RENDER: process.env.RENDER,
      NODE_ENV: process.env.NODE_ENV,
      KICK_PROXY_URL: process.env.KICK_PROXY_URL,
      APIFY_PROXY_PASSWORD: process.env.APIFY_PROXY_PASSWORD,
    };
    process.env.RENDER = 'true';
    delete process.env.NODE_ENV;
    process.env.KICK_PROXY_URL = 'http://proxy.test:8000';
    delete process.env.APIFY_PROXY_PASSWORD;
    const env = kickHlsFfmpegSpawnEnv();
    expect(env.HTTP_PROXY).toBe('http://proxy.test:8000');
    expect(env.HTTPS_PROXY).toBe('http://proxy.test:8000');
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test('kickHlsFfmpegInputEncodeArgs adds -http_proxy on Render', () => {
    const prev = { RENDER: process.env.RENDER, KICK_PROXY_URL: process.env.KICK_PROXY_URL };
    process.env.RENDER = 'true';
    process.env.KICK_PROXY_URL = 'http://proxy.test:8000';
    const args = require('../lib/live_grid/kick_ingest').kickHlsFfmpegInputEncodeArgs(
      'https://x.playback.live-video.net/v1/a.m3u8',
    );
    expect(args).toContain('-http_proxy');
    expect(args).toContain('http://proxy.test:8000');
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
});
