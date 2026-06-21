'use strict';

const {
  isKickPageUrl,
  isKickPlaybackUrl,
  kickSlugFromUrl,
  buildApifyProxyUrl,
  resolveKickOAuthCustomerId,
} = require('../lib/clients/kick_live_resolver');
const { kickStreamlinkIngestEnabled, kickPageUrl } = require('../lib/live_grid/kick_config');
const { isFeedUrlAllowed } = require('../lib/live_grid/feed_allowlist');

describe('kick_live_resolver', () => {
  test('isKickPageUrl detects kick.com channel pages', () => {
    expect(isKickPageUrl('https://kick.com/deenthegreat')).toBe(true);
    expect(isKickPageUrl('https://www.kick.com/xqc')).toBe(true);
    expect(isKickPageUrl('https://twitch.tv/xqc')).toBe(false);
  });

  test('kickSlugFromUrl extracts slug', () => {
    expect(kickSlugFromUrl('https://kick.com/deenthegreat')).toBe('deenthegreat');
  });

  test('isKickPlaybackUrl detects CDN HLS', () => {
    expect(isKickPlaybackUrl('https://fa723fc1b171.use15.playlist.live-video.net/v1/playlist/foo.m3u8')).toBe(true);
    expect(isKickPlaybackUrl('https://kick.com/deenthegreat')).toBe(false);
  });

  test('buildApifyProxyUrl uses KICK_PROXY_URL when set', () => {
    const prevUrl = process.env.KICK_PROXY_URL;
    const prevPwd = process.env.APIFY_PROXY_PASSWORD;
    process.env.KICK_PROXY_URL = 'http://proxy.test:8000';
    delete process.env.APIFY_PROXY_PASSWORD;
    expect(buildApifyProxyUrl()).toBe('http://proxy.test:8000');
    process.env.KICK_PROXY_URL = prevUrl;
    if (prevPwd) process.env.APIFY_PROXY_PASSWORD = prevPwd;
  });

  test('Kick CDN hosts are allowlisted for live grid feeds', () => {
    expect(isFeedUrlAllowed('https://fa723fc1b171.use15.playlist.live-video.net/v1/playlist/test.m3u8')).toBe(true);
    expect(isFeedUrlAllowed('https://kick.com/deenthegreat')).toBe(true);
  });

  test('resolveKickOAuthCustomerId falls back to env chain', () => {
    const prev = [
      process.env.LIVE_GRID_KICK_OAUTH_CUSTOMER_ID,
      process.env.BROADCAST_CUSTOMER_ID,
      process.env.PRODUCTION_CRON_CUSTOMER_ID,
    ];
    delete process.env.LIVE_GRID_KICK_OAUTH_CUSTOMER_ID;
    delete process.env.BROADCAST_CUSTOMER_ID;
    process.env.PRODUCTION_CRON_CUSTOMER_ID = 'c0';
    expect(resolveKickOAuthCustomerId()).toBe('c0');
    process.env.LIVE_GRID_KICK_OAUTH_CUSTOMER_ID = prev[0] || 'clipzworld';
    expect(resolveKickOAuthCustomerId()).toBe('clipzworld');
    if (prev[0]) process.env.LIVE_GRID_KICK_OAUTH_CUSTOMER_ID = prev[0];
    else delete process.env.LIVE_GRID_KICK_OAUTH_CUSTOMER_ID;
    if (prev[1]) process.env.BROADCAST_CUSTOMER_ID = prev[1];
    else delete process.env.BROADCAST_CUSTOMER_ID;
    if (prev[2]) process.env.PRODUCTION_CRON_CUSTOMER_ID = prev[2];
    else delete process.env.PRODUCTION_CRON_CUSTOMER_ID;
  });

  test('kickPageUrl builds channel page for streamlink ingest', () => {
    const prevIngest = process.env.LIVE_GRID_KICK_INGEST;
    const prevRender = process.env.RENDER;
    process.env.LIVE_GRID_KICK_INGEST = 'streamlink';
    expect(kickStreamlinkIngestEnabled()).toBe(true);
    expect(kickPageUrl('deenthegreat')).toBe('https://kick.com/deenthegreat');
    if (prevIngest) process.env.LIVE_GRID_KICK_INGEST = prevIngest;
    else delete process.env.LIVE_GRID_KICK_INGEST;
    if (prevRender) process.env.RENDER = prevRender;
    else delete process.env.RENDER;
  });
});
