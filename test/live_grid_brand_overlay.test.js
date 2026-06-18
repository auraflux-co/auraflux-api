'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  gridFrameMetrics,
  cellBlockOrigin,
  audioFrameZmqCommands,
  onAirVideoCropRect,
  buildFrameOverlayFilters,
} = require('../lib/live_grid/brand_overlay');

const esc = (s) => s;

test('gridFrameMetrics insets content inside uniform border', () => {
  const m = gridFrameMetrics(1920, 1080);
  assert.equal(m.borderW, 8);
  assert.equal(m.innerX, 8);
  assert.equal(m.innerY, 8);
  assert.equal(m.innerW, 1904);
  assert.equal(m.innerH, 1064);
  assert.equal(m.stripH, 52);
  assert.equal(m.innerY + m.stripH + 2 * m.rowBlockH + m.borderW, m.innerY + m.innerH);
});

test('all name strips same height as title strip', () => {
  const m = gridFrameMetrics(1920, 1080);
  for (let q = 0; q < 4; q++) {
    const b = cellBlockOrigin(q, m);
    assert.equal(b.labelY + m.stripH, b.y + m.rowBlockH);
  }
});

test('name plates always navy — on-air uses stroke only', () => {
  const m = gridFrameMetrics(1920, 1080);
  const f = buildFrameOverlayFilters(m, 0, { muted: false, fallbackMusicActive: false }, esc);
  assert.match(f, /drawbox@labelbg0=.*color=0x22304b@1/);
  assert.match(f, /drawbox@labelbg3=.*color=0x22304b@1/);
  assert.doesNotMatch(f, /drawbox@onair=.*t=8/);
});

test('vertical gutter starts below title strip (does not cut through title)', () => {
  const m = gridFrameMetrics(1920, 1080);
  const f = buildFrameOverlayFilters(m, 0, { muted: false, fallbackMusicActive: false }, esc);
  assert.match(f, /drawbox@titlebg=x=8:y=8:w=1904:h=52/);
  assert.match(f, /drawbox@vgutter=x=956:y=60:w=8:h=1012/);
  assert.doesNotMatch(f, /drawbox@titlebgL/);
});

test('outer border drawn after labels so bottom row strips stay visible', () => {
  const m = gridFrameMetrics(1920, 1080);
  const f = buildFrameOverlayFilters(m, 0, { muted: false, fallbackMusicActive: false }, esc);
  const labelPos = f.indexOf('drawbox@labelbg3');
  const outerPos = f.lastIndexOf('drawbox=x=0:y=0:w=1920');
  assert.ok(labelPos < outerPos);
});

test('audioFrameZmqCommands keeps name centered and moves flank overlays', () => {
  const m = gridFrameMetrics(1920, 1080);
  const cmds = audioFrameZmqCommands(1, m, { muted: false });
  assert.match(cmds, /cdrawtext@name1 -1 x 964\+\(948-text_w\)\/2/);
  assert.match(cmds, /coverlay@onairavatar -1 x /);
  assert.match(cmds, /coverlay@onairbadge -1 x /);
  assert.match(cmds, /cdrawtext@name1 -1 fontcolor 0xc7af4f/);
});

test('xstackFilter pads canvas to full output size', () => {
  const m = gridFrameMetrics(1920, 1080);
  const { xstackFilter } = require('../lib/live_grid/brand_overlay');
  const f = xstackFilter(['[q1]', '[q2]', '[q3]', '[q4]'], m);
  assert.match(f, /xstack=inputs=4:layout=/);
  assert.match(f, /pad=1920:1080:0:0/);
});

test('onAirVideoCropRect is video area only', () => {
  const m = gridFrameMetrics(1920, 1080);
  const c = onAirVideoCropRect(0, m);
  assert.equal(c.h, m.cellVideoH);
  assert.equal(c.y, cellBlockOrigin(0, m).videoY);
});
