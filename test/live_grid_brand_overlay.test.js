'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  gridFrameMetrics,
  cellBlockOrigin,
  buildFrameOverlayFilters,
  frameHgutterEnabled,
} = require('../lib/live_grid/brand_overlay');

const esc = (s) => s;

test('horizontal gold row gutter off by default', () => {
  delete process.env.LIVE_GRID_FRAME_HGUTTER;
  assert.equal(frameHgutterEnabled(), false);
  const m = gridFrameMetrics(1920, 1080);
  assert.equal(m.rowGap, 0);
  const f = buildFrameOverlayFilters(m, 0, { muted: false, fallbackMusicActive: false }, esc);
  assert.doesNotMatch(f, /drawbox@hgutter/);
});

test('horizontal gold row gutter when LIVE_GRID_FRAME_HGUTTER=on', () => {
  process.env.LIVE_GRID_FRAME_HGUTTER = 'on';
  try {
    assert.equal(frameHgutterEnabled(), true);
    const m = gridFrameMetrics(1920, 1080);
    assert.equal(m.rowGap, 8);
    const f = buildFrameOverlayFilters(m, 0, { muted: false, fallbackMusicActive: false }, esc);
    assert.match(f, /drawbox@hgutter=x=8:y=562:w=1904:h=8/);
    assert.doesNotMatch(f, /drawbox@vgutter/);
  } finally {
    delete process.env.LIVE_GRID_FRAME_HGUTTER;
  }
});

test('flush rows — no vertical gold gutter', () => {
  delete process.env.LIVE_GRID_FRAME_HGUTTER;
  const m = gridFrameMetrics(1920, 1080);
  const f = buildFrameOverlayFilters(m, 0, { muted: false, fallbackMusicActive: false }, esc);
  assert.doesNotMatch(f, /drawbox@vgutter/);
  assert.equal(m.innerY + m.stripH + 2 * m.rowBlockH + m.rowGap, m.innerY + m.innerH);
});

test('name plates full-width navy row bands', () => {
  const m = gridFrameMetrics(1920, 1080);
  const f = buildFrameOverlayFilters(m, 0, { muted: false, fallbackMusicActive: false }, esc);
  assert.match(f, /drawbox@labelrow0=x=8:y=\d+:w=1904:h=52/);
  assert.match(f, /drawbox@labelrow1=x=8:y=\d+:w=1904:h=52/);
  for (let q = 0; q < 4; q++) {
    const b = cellBlockOrigin(q, m);
    assert.equal(b.labelY + m.stripH, b.y + m.rowBlockH);
  }
});
