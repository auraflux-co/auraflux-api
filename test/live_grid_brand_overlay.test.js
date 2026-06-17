'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  audioBadgeXY,
  audioBadgeText,
  audioBadgeZmqCommands,
} = require('../lib/live_grid/brand_overlay');

test('audioBadgeXY places badge top-right per quadrant', () => {
  const cellW = 960;
  const cellH = 540;
  assert.deepEqual(audioBadgeXY(0, cellW, cellH), { ax: 0, ay: 0, x: 838, y: 14 });
  assert.deepEqual(audioBadgeXY(1, cellW, cellH), { ax: 960, ay: 0, x: 1798, y: 14 });
  assert.deepEqual(audioBadgeXY(2, cellW, cellH), { ax: 0, ay: 540, x: 838, y: 554 });
  assert.deepEqual(audioBadgeXY(3, cellW, cellH), { ax: 960, ay: 540, x: 1798, y: 554 });
});

test('audioBadgeText hides on mute, shows bed label', () => {
  assert.equal(audioBadgeText({}), 'AUDIO');
  assert.equal(audioBadgeText({ muted: true }), '');
  assert.equal(audioBadgeText({ fallbackMusicActive: true }), 'MUSIC BED');
});

test('audioBadgeZmqCommands moves badge and mute pill', () => {
  const cmds = audioBadgeZmqCommands(1, 960, 540, { muted: false });
  assert.match(cmds, /cdrawtext@audiobadge -1 x 1798/);
  assert.match(cmds, /cdrawtext@audiobadge -1 text AUDIO/);
  const muted = audioBadgeZmqCommands(0, 960, 540, { muted: true });
  assert.match(muted, /cdrawtext@mutestatus -1 text AUDIO MUTED/);
});
