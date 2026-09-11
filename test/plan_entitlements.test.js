'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  getPlanDefaults,
  queuePriorityForTier,
  exportProfileForTier,
} = require('../lib/services/plan_entitlements');
const { hoursFromDurationSecs } = require('../lib/services/vod_hours');

test('Growth entitlements match marketing claims', () => {
  const g = getPlanDefaults('growth');
  assert.equal(g.vod_hours_included, 40);
  assert.equal(g.max_channels, 3);
  assert.equal(g.export_vertical_w, 1080);
  assert.equal(g.export_vertical_h, 1920);
  assert.equal(g.export_fps, 60);
  assert.equal(g.caption_font_upload, false);
});

test('Operate/Pro is unlimited VOD + fonts + priority', () => {
  const o = getPlanDefaults('operate');
  assert.equal(o.vod_hours_included, null);
  assert.equal(o.max_channels, null);
  assert.equal(o.caption_font_upload, true);
  assert.equal(o.has_account_manager, true);
  assert.ok(queuePriorityForTier('operate') < queuePriorityForTier('growth'));
});

test('export profile is 1080p60', () => {
  const p = exportProfileForTier('growth');
  assert.deepEqual(p, { width: 1080, height: 1920, fps: 60 });
});

test('hoursFromDurationSecs floors at 1 minute', () => {
  assert.ok(hoursFromDurationSecs(0) >= 1 / 60);
  assert.equal(hoursFromDurationSecs(3600), 1);
  assert.equal(hoursFromDurationSecs(7200), 2);
});
