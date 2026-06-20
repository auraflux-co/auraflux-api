'use strict';

describe('live_grid studio_dual', () => {
  const orig = { ...process.env };

  afterEach(() => {
    process.env = { ...orig };
    jest.resetModules();
  });

  test('holds RTMP when native dual + studio-first enabled', () => {
    process.env.LIVE_GRID_YOUTUBE_DUAL_STREAM = 'on';
    process.env.LIVE_GRID_STUDIO_DUAL_FIRST = 'on';
    const { shouldHoldRtmpForStudio } = require('../lib/live_grid/studio_dual');
    expect(shouldHoldRtmpForStudio({}, {
      broadcast: { broadcastId: 'abc', watchUrl: 'https://youtube.com/live/abc' },
    })).toBe(true);
  });

  test('skips hold when rtmpGo set', () => {
    process.env.LIVE_GRID_YOUTUBE_DUAL_STREAM = 'on';
    process.env.LIVE_GRID_STUDIO_DUAL_FIRST = 'on';
    const { shouldHoldRtmpForStudio } = require('../lib/live_grid/studio_dual');
    expect(shouldHoldRtmpForStudio({ _rtmpGo: true }, {
      broadcast: { broadcastId: 'abc' },
    })).toBe(false);
  });

  test('skips hold when native dual disabled', () => {
    process.env.LIVE_GRID_YOUTUBE_DUAL_STREAM = 'off';
    process.env.LIVE_GRID_STUDIO_DUAL_FIRST = 'on';
    const { shouldHoldRtmpForStudio } = require('../lib/live_grid/studio_dual');
    expect(shouldHoldRtmpForStudio({}, {
      broadcast: { broadcastId: 'abc' },
    })).toBe(false);
  });
});
