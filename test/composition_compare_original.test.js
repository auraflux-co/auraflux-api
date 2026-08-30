'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildComparePrompt,
  DEFAULT_RATIOS,
} = require('../lib/composition_compare_original');

describe('composition_compare_original', () => {
  it('buildComparePrompt includes disclaimer and axes', () => {
    const p = buildComparePrompt({ sourceDuration: 60, shortDuration: 58 });
    assert.match(p, /NOT legal advice/i);
    assert.match(p, /look_grade/);
    assert.match(p, /crop_layout/);
    assert.match(p, /captions_hooks/);
    assert.match(p, /music_beats/);
    assert.match(p, /difference_from_source/);
    assert.match(p, /60/);
    assert.match(p, /58/);
  });

  it('DEFAULT_RATIOS covers early mid late', () => {
    assert.ok(DEFAULT_RATIOS.length >= 4);
    assert.ok(DEFAULT_RATIOS[0] < 0.2);
    assert.ok(DEFAULT_RATIOS[DEFAULT_RATIOS.length - 1] > 0.7);
  });
});
