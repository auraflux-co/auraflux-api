'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  getCompCreativeCatalogList,
  getCompCreativeCatalogEntry,
  formatCompCreativeSelectLabel,
} = require('../lib/clip_comp_creative');

describe('COMP_CREATIVE_CATALOG labels', () => {
  it('lists C1–C7 with codes and select labels', () => {
    const list = getCompCreativeCatalogList();
    assert.equal(list.length, 7);
    const codes = list.map((e) => e.code).sort();
    assert.deepEqual(codes, ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7']);
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
});
