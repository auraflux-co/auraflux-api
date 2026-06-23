'use strict';

const {
  soloBrandFrameEnabled,
  soloFrameMetrics,
  buildSoloBrandVideoFilter,
} = require('../lib/live_grid/solo_brand_frame');

describe('solo_brand_frame', () => {
  test('solo brand frame on by default', () => {
    delete process.env.LIVE_GRID_SOLO_BRAND_FRAME;
    expect(soloBrandFrameEnabled()).toBe(true);
    process.env.LIVE_GRID_SOLO_BRAND_FRAME = 'off';
    expect(soloBrandFrameEnabled()).toBe(false);
    delete process.env.LIVE_GRID_SOLO_BRAND_FRAME;
  });

  test('soloFrameMetrics insets video inside gold gutter', () => {
    const m = soloFrameMetrics(1920, 1080);
    expect(m.innerW).toBeLessThan(1920);
    expect(m.innerW).toBe(1920 - m.borderW * 2);
  });

  test('buildSoloBrandVideoFilter includes outer drawbox and optional logo overlay', () => {
    const f = buildSoloBrandVideoFilter({ w: 1920, h: 1080, fps: 30 });
    if (f.mode === 'vf') {
      expect(f.vf).toMatch(/drawbox=x=0:y=0:w=1920:h=1080/);
    } else {
      expect(f.filterComplex).toMatch(/drawbox=x=0:y=0:w=1920:h=1080/);
      expect(f.filterComplex).toMatch(/overlay=W-w-/);
      expect(f.mapVideo).toBe('[vout]');
    }
  });
});
