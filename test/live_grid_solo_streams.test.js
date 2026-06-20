describe('live_grid solo streams (CPD-1047)', () => {
  const orig = {};

  beforeEach(() => {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('LIVE_GRID_SOLO')) orig[k] = process.env[k];
    }
    delete process.env.LIVE_GRID_SOLO_1_BROADCAST_ID;
    delete process.env.LIVE_GRID_SOLO_1_RTMP_URL;
    delete process.env.LIVE_GRID_SOLO_STREAMS;
    jest.resetModules();
  });

  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('LIVE_GRID_SOLO') && !(k in orig)) delete process.env[k];
    }
    for (const [k, v] of Object.entries(orig)) process.env[k] = v;
    jest.resetModules();
  });

  test('soloIndex maps quadrant 0-3 to seat 1-4', () => {
    const { soloIndex } = require('../lib/live_grid/solo_listings_env');
    expect(soloIndex(0)).toBe(1);
    expect(soloIndex(3)).toBe(4);
    expect(soloIndex(4)).toBeNull();
  });

  test('readSoloListingForQuadrant returns watch URL from broadcast id', () => {
    process.env.LIVE_GRID_SOLO_2_RTMP_URL = 'rtmp://a.rtmp.youtube.com/live2/key2';
    process.env.LIVE_GRID_SOLO_2_BROADCAST_ID = 'abc123XYZ';
    jest.resetModules();
    const { readSoloListingForQuadrant } = require('../lib/live_grid/solo_listings_env');
    const row = readSoloListingForQuadrant(1);
    expect(row.quadrant).toBe(2);
    expect(row.watchUrl).toBe('https://youtube.com/live/abc123XYZ');
    expect(row.rtmpUrl).toContain('key2');
  });

  test('soloStreamsConfigured requires at least one RTMP URL', () => {
    const { soloStreamsConfigured } = require('../lib/live_grid/solo_listings_env');
    expect(soloStreamsConfigured()).toBe(false);
    process.env.LIVE_GRID_SOLO_1_RTMP_URL = 'rtmp://x/live2/k';
    jest.resetModules();
    expect(require('../lib/live_grid/solo_listings_env').soloStreamsConfigured()).toBe(true);
  });

  test('buildLineupMessage lists main and solo seat URLs', () => {
    const { buildLineupMessage } = require('../lib/live_grid/solo_announce');
    const text = buildLineupMessage({
      mainWatchUrl: 'https://youtube.com/live/main',
      assignments: ['xqc', null, 'shroud', 'pokimane'],
      solos: [
        { quadrant: 1, watchUrl: 'https://youtube.com/live/s1' },
        { quadrant: 3, watchUrl: 'https://youtube.com/live/s3' },
      ],
    });
    expect(text).toContain('Main 2×2: https://youtube.com/live/main');
    expect(text).toContain('Q1 xqc → https://youtube.com/live/s1');
    expect(text).toContain('Q2 slate');
    expect(text).toContain('Q3 shroud → https://youtube.com/live/s3');
    expect(text).not.toContain('twitch.tv');
  });

  test('soloOutputDims defaults to 720p', () => {
    delete process.env.LIVE_GRID_SOLO_OUTPUT_W;
    delete process.env.LIVE_GRID_SOLO_OUTPUT_H;
    delete process.env.LIVE_GRID_SOLO_BITRATE_K;
    jest.resetModules();
    const { soloOutputDims } = require('../lib/live_grid/solo_publishers');
    expect(soloOutputDims()).toEqual(expect.objectContaining({ w: 1280, h: 720, bitrateK: 1500 }));
  });
});
