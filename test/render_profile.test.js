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

  test('applyYoutubeOutputDims sets square canvas from probe', () => {
    jest.doMock('child_process', () => ({
      execFileSync: () => JSON.stringify({ width: 1080, height: 1080, formats: [{ vcodec: 'avc1', height: 1080, width: 1080 }] }),
    }));
    process.env.RENDER = 'true';
    const { applyYoutubeOutputDims } = require('../lib/live_grid/render_profile');
    const r = applyYoutubeOutputDims('https://youtube.com/live/test');
    expect(r.applied).toBe(true);
    expect(process.env.LIVE_GRID_OUTPUT_W).toBe('1080');
    expect(process.env.LIVE_GRID_OUTPUT_H).toBe('1080');
  });
});
