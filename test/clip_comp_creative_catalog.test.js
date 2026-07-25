'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  getCompCreativeCatalogList,
  getCompCreativeCatalogEntry,
  formatCompCreativeSelectLabel,
} = require('../lib/clip_comp_creative');

describe('COMP_CREATIVE_CATALOG labels', () => {
  it('lists C1–C9 with codes and select labels', () => {
    const list = getCompCreativeCatalogList();
    assert.equal(list.length, 9);
    const codes = list.map((e) => e.code).sort();
    assert.deepEqual(codes, ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9']);
    list.forEach((e) => {
      assert.ok(e.selectLabel.startsWith(e.code), e.id + ' selectLabel must start with code');
      assert.ok(e.name, e.id + ' must have name');
      assert.ok(Array.isArray(e.buttons) && e.buttons.length, e.id + ' must list buttons');
    });
  });

  it('C3 serpent ranked is Comp-only', () => {
    const e = getCompCreativeCatalogEntry('serpent_ranked');
    assert.equal(e.code, 'C3');
    assert.deepEqual(e.buttons, ['Comp']);
    assert.match(formatCompCreativeSelectLabel('serpent_ranked'), /C3/);
  });

  it('C9 FableFlow Speed is Short-only editor-less recipe', () => {
    const e = getCompCreativeCatalogEntry('fableflow_speed');
    assert.equal(e.code, 'C9');
    assert.deepEqual(e.buttons, ['Short']);
    assert.match(e.tagline, /FableFlow|editor-less/i);
  });
});
