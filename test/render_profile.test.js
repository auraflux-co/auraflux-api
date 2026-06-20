'use strict';

describe('live_grid render_profile', () => {
  const orig = { ...process.env };

  afterEach(() => {
    process.env = { ...orig };
    jest.resetModules();
  });

  test('applyRenderProfile sets locked encode vars on Render', () => {
    process.env.RENDER = 'true';
    const { applyRenderProfile, loadRenderProfileFile } = require('../lib/live_grid/render_profile');
    const profile = loadRenderProfileFile();
    expect(profile).toBeTruthy();
    expect(profile.LIVE_GRID_OUTPUT_MIDDLEWARE).toBe('off');

    const r = applyRenderProfile();
    expect(r.applied).toBe(true);
    expect(process.env.LIVE_GRID_LOCAL_HLS).toBe('off');
    expect(process.env.LIVE_GRID_OUTPUT_MIDDLEWARE).toBe('off');
  });

  test('applyYoutubeOutputDims forces landscape when dual stream off', () => {
    process.env.RENDER = 'true';
    process.env.LIVE_GRID_YOUTUBE_DUAL_STREAM = 'off';
    const { applyYoutubeOutputDims } = require('../lib/live_grid/render_profile');
    const r = applyYoutubeOutputDims('https://youtube.com/live/test');
    expect(r.applied).toBe(true);
    expect(r.mode).toBe('landscape_forced');
    expect(process.env.LIVE_GRID_OUTPUT_W).toBe('1920');
    expect(process.env.LIVE_GRID_OUTPUT_H).toBe('1080');
  });

  test('applyYoutubeOutputDims uses landscape dual ingest when dual stream on', () => {
    process.env.RENDER = 'true';
    process.env.LIVE_GRID_YOUTUBE_DUAL_STREAM = 'on';
    const { applyYoutubeOutputDims } = require('../lib/live_grid/render_profile');
    const r = applyYoutubeOutputDims('https://youtube.com/live/test');
    expect(r.applied).toBe(true);
    expect(r.mode).toBe('landscape_dual_ingest');
    expect(process.env.LIVE_GRID_OUTPUT_W).toBe('1920');
    expect(process.env.LIVE_GRID_OUTPUT_H).toBe('1080');
  });
});
