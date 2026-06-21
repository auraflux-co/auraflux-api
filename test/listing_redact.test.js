'use strict';

const {
  redactRtmpUrl,
  redactListing,
  redactSoloListings,
  protectYtRtmpEnabled,
} = require('../lib/broadcast/listing_redact');

describe('listing_redact', () => {
  const full = 'rtmp://a.rtmp.youtube.com/live2/secret-stream-key-xyz';

  beforeEach(() => {
    delete process.env.LIVE_GRID_PROTECT_YT_RTMP;
  });

  test('redactRtmpUrl masks stream key', () => {
    expect(redactRtmpUrl(full)).toBe('rtmp://a.rtmp.youtube.com/live2/…');
  });

  test('redactListing when protect on', () => {
    const row = { poolSlot: 1, rtmpUrl: full, watchUrl: 'https://youtube.com/live/abc' };
    expect(redactListing(row).rtmpUrl).toBe('rtmp://a.rtmp.youtube.com/live2/…');
  });

  test('redactListing passes through when protect off', () => {
    process.env.LIVE_GRID_PROTECT_YT_RTMP = 'off';
    const row = { rtmpUrl: full };
    expect(redactListing(row).rtmpUrl).toBe(full);
  });

  test('redactSoloListings maps array', () => {
    expect(protectYtRtmpEnabled()).toBe(true);
    const out = redactSoloListings([{ rtmpUrl: full }]);
    expect(out[0].rtmpUrl).toContain('/live2/…');
  });
});
