'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeCompCreative, PRESET_DEFAULTS, getCompCreativeCatalogList } = require('../lib/clip_comp_creative');

test('mergeCompCreative applies fableflow_speed (C9)', () => {
  const c = mergeCompCreative({ preset: 'fableflow_speed' });
  assert.equal(c.preset, 'fableflow_speed');
  assert.ok(PRESET_DEFAULTS.fableflow_speed);
});

test('catalog lists C1–C11 class presets', () => {
  const list = getCompCreativeCatalogList();
  assert.ok(list.length >= 10);
  const keys = list.map((p) => p.id || p.preset || p.key);
  assert.ok(keys.includes('reaction_short'));
  assert.ok(keys.includes('dual_source_stack'));
  assert.ok(keys.includes('fableflow_speed'));
});
