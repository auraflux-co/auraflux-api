'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  normalizeListingId,
  persistYoutubeListing,
} = require('../lib/live_grid/youtube_listing_env');

describe('youtube_listing_env', () => {
  let tmpDir;
  let envPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-listing-'));
    envPath = path.join(tmpDir, '.env');
    fs.writeFileSync(envPath, 'LIVE_GRID_RTMP_URL=rtmp://test/live2/key\n');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('normalizeListingId accepts id or URL', () => {
    expect(normalizeListingId('abc123XYZ01')).toBe('abc123XYZ01');
    expect(normalizeListingId('https://youtube.com/live/abc123XYZ01')).toBe('abc123XYZ01');
  });

  test('persistYoutubeListing writes broadcast id and watch url', () => {
    const r = persistYoutubeListing({
      envPath,
      broadcastId: 'abc123XYZ01',
    });
    expect(r.broadcastId).toBe('abc123XYZ01');
    expect(fs.readFileSync(envPath, 'utf8')).toMatch(/LIVE_GRID_BROADCAST_ID=abc123XYZ01/);
    expect(process.env.LIVE_GRID_BROADCAST_ID).toBe('abc123XYZ01');
  });
});
