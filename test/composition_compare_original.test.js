'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildComparePrompt,
  DEFAULT_RATIOS,
} = require('../lib/composition_compare_original');

describe('composition_compare_original', () => {
  it('buildComparePrompt includes disclaimer and axes', () => {
    const p = buildComparePrompt({ sourceDuration: 60, shortDuration: 58, mode: 'video' });
    assert.match(p, /NOT legal advice/i);
    assert.match(p, /look_grade/);
    assert.match(p, /crop_layout/);
    assert.match(p, /captions_hooks/);
    assert.match(p, /music_beats/);
    assert.match(p, /difference_from_source/);
    assert.match(p, /60/);
    assert.match(p, /58/);
    assert.match(p, /TWO full videos/i);
    assert.match(p, /do NOT say uncertain from stills/i);
    const stills = buildComparePrompt({ sourceDuration: 60, shortDuration: 58, mode: 'stills' });
    assert.match(stills, /still frames/i);
  });

  it('DEFAULT_RATIOS covers early mid late', () => {
    assert.ok(DEFAULT_RATIOS.length >= 4);
    assert.ok(DEFAULT_RATIOS[0] < 0.2);
    assert.ok(DEFAULT_RATIOS[DEFAULT_RATIOS.length - 1] > 0.7);
  });

  it('isCompleteCompareReport rejects partial axes', () => {
    const { isCompleteCompareReport, incompleteAxes } = require('../lib/composition_compare_original');
    assert.equal(isCompleteCompareReport({
      transform_strength: 2,
      axes: { look_grade: { score: 4, notes: 'ok' } },
    }), false);
    assert.deepEqual(
      incompleteAxes({ axes: { look_grade: { score: 4 } } }),
      ['crop_layout', 'captions_hooks', 'music_beats', 'difference_from_source'],
    );
    assert.equal(isCompleteCompareReport({
      transform_strength: 4,
      axes: {
        look_grade: { score: 4 },
        crop_layout: { score: 5 },
        captions_hooks: { score: 3 },
        music_beats: { score: 2 },
        difference_from_source: { score: 4 },
      },
    }), true);
  });
});
