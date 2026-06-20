'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  gridFrameMetrics,
  cellBlockOrigin,
  nameStripFlankPositions,
  nameStripTextX,
  nameClusterHalfWidth,
  audioFrameZmqCommands,
  buildFrameOverlayFilters,
  frameHgutterEnabled,
  nameStripImageOverlays,
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

test('short names tighten flank cluster around label', () => {
  const m = gridFrameMetrics(1920, 1080);
  const short = nameClusterHalfWidth('arky', m);
  const long = nameClusterHalfWidth('STABLERONALDO', m);
  assert.ok(short < long);
  const flank = nameStripFlankPositions(3, m, 'arky');
  const b = cellBlockOrigin(3, m);
  const centerX = b.x + Math.floor(m.cellW / 2);
  assert.ok(flank.avatarX + flank.avatarSize + m.nameFlankGap < centerX);
  assert.ok(flank.badgeX > centerX);
});

test('single on-air avatar overlay — no per-quad ghost overlays', () => {
  const m = gridFrameMetrics(1920, 1080);
  const chain = nameStripImageOverlays(m, 3, { muted: false, fallbackMusicActive: false }, esc, {
    avatar: 4,
    badge: 8,
  });
  assert.match(chain, /overlay@onairav=/);
  assert.match(chain, /overlay@onairbadge=/);
  assert.doesNotMatch(chain, /onairav0/);
  assert.doesNotMatch(chain, /onairav1/);
  assert.match(chain, /\[7:v\].*\[avpic\]/);
});

test('audioFrameZmqCommands uses single on-air overlay pair', () => {
  const m = gridFrameMetrics(1920, 1080);
  const cmds = audioFrameZmqCommands(3, m, { muted: false });
  assert.match(cmds, /coverlay@onairav -1 x \d+/);
  assert.match(cmds, /coverlay@onairbadge -1 x \d+/);
  assert.doesNotMatch(cmds, /coverlay@onairav0/);
  assert.match(cmds, /cdrawtext@name3 -1 x \d+\+\(\d+-text_w\)\/2/);
});

test('on-air name text centers in flank safe zone', () => {
  const m = gridFrameMetrics(1920, 1080);
  const flank = nameStripFlankPositions(3, m, 'arky');
  const nameX = nameStripTextX(3, m, 3, 'arky');
  assert.match(nameX, new RegExp(`^${flank.nameZoneLeft}\\+\\(`));
});
