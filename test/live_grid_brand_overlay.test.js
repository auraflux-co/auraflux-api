'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  gridFrameMetrics,
  cellBlockOrigin,
  nameStripFlankPositions,
  nameStripTextX,
  audioFrameZmqCommands,
  buildOnAirBadgeFilter,
  buildAvatarFilter,
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
  assert.equal(m.cellW, 952);
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

test('name plates always navy — full-width row bands', () => {
  const m = gridFrameMetrics(1920, 1080);
  const f = buildFrameOverlayFilters(m, 0, { muted: false, fallbackMusicActive: false }, esc);
  assert.match(f, /drawbox@labelrow0=x=8:y=510:w=1904:h=52/);
  assert.match(f, /drawbox@labelrow1=x=8:y=\d+:w=1904:h=52/);
  assert.doesNotMatch(f, /drawbox@labelbg0/);
  assert.doesNotMatch(f, /drawbox@onair=.*t=8/);
});

test('no vertical gold gutter — horizontal row divider only', () => {
  const m = gridFrameMetrics(1920, 1080);
  const f = buildFrameOverlayFilters(m, 0, { muted: false, fallbackMusicActive: false }, esc);
  assert.match(f, /drawbox@hgutter=x=8:y=562:w=1904:h=8/);
  assert.doesNotMatch(f, /drawbox@vgutter/);
});

test('outer border drawn after labels so bottom row strips stay visible', () => {
  const m = gridFrameMetrics(1920, 1080);
  const f = buildFrameOverlayFilters(m, 0, { muted: false, fallbackMusicActive: false }, esc);
  const labelPos = f.indexOf('drawbox@labelrow1');
  const outerPos = f.lastIndexOf('drawbox=x=0:y=0:w=1920');
  assert.ok(labelPos < outerPos);
});

test('audioFrameZmqCommands keeps on-air name inside flank zone', () => {
  const m = gridFrameMetrics(1920, 1080);
  const cmds = audioFrameZmqCommands(1, m, { muted: false });
  assert.match(cmds, /cdrawtext@name1 -1 x \d+\+\(\d+-text_w\)\/2/);
  assert.match(cmds, /coverlay@onairav1 -1 x \d+/);
  assert.match(cmds, /coverlay@onairav0 -1 x -400/);
  assert.match(cmds, /coverlay@onairbadge -1 x /);
});

test('on-air flanks cluster around centered name', () => {
  const m = gridFrameMetrics(1920, 1080);
  const flank = nameStripFlankPositions(0, m, 'STABLERONALDO');
  const b = cellBlockOrigin(0, m);
  const centerX = b.x + Math.floor(m.cellW / 2);
  assert.ok(flank.nameZoneRight - flank.nameZoneLeft >= 2 * m.nameClusterHalfMax - 4, 'name lane between flanks');
  assert.ok(flank.avatarX + flank.avatarSize + m.nameFlankGap < centerX);
  assert.ok(flank.badgeX > centerX);
  const nameX = nameStripTextX(0, m, 0, 'STABLERONALDO');
  assert.match(nameX, new RegExp(`^${flank.nameZoneLeft}\\+\\(`));
});

test('on-air flanks sit near centered name with outer edge padding', () => {
  const m = gridFrameMetrics(1920, 1080);
  const flank = nameStripFlankPositions(0, m, 'STABLERONALDO');
  const b = cellBlockOrigin(0, m);
  const centerX = b.x + Math.floor(m.cellW / 2);
  assert.ok(flank.avatarX > b.x + 40, 'avatar near name center not left edge');
  assert.ok(flank.badgeX + flank.badgeW < b.x + m.cellW - 40, 'badge near name center not right edge');
  assert.ok(flank.avatarY + flank.avatarSize <= b.labelY + m.stripH);
  assert.ok(flank.badgeY + flank.badgeH <= b.labelY + m.stripH);
  assert.ok(flank.avatarX + flank.avatarSize + m.nameFlankGap < centerX);
  assert.ok(flank.badgeX > centerX);
});

test('xstackFilter pads canvas to full output size', () => {
  const m = gridFrameMetrics(1920, 1080);
  const { xstackFilter } = require('../lib/live_grid/brand_overlay');
  const f = xstackFilter(['[q1]', '[q2]', '[q3]', '[q4]'], m);
  assert.match(f, /xstack=inputs=4:layout=/);
  assert.match(f, /pad=1920:1080:0:0/);
});

test('on-air badge filter letterboxes in square gold frame', () => {
  const f = buildOnAirBadgeFilter(9, 44, 44);
  assert.match(f, /force_original_aspect_ratio=decrease/);
  assert.match(f, /pad=44:44/);
  assert.match(f, /\[onairpic\]$/);
});

test('avatar filter adds gold frame pad', () => {
  const f = buildAvatarFilter(5, 44);
  assert.match(f, /pad=44:44:2:2:color=0xc7af4f/);
  assert.match(f, /\[avpic\]$/);
});

test('onAirVideoCropRect is video area only', () => {
  const m = gridFrameMetrics(1920, 1080);
  const c = onAirVideoCropRect(0, m);
  assert.equal(c.h, m.cellVideoH);
  assert.equal(c.y, cellBlockOrigin(0, m).videoY);
});
