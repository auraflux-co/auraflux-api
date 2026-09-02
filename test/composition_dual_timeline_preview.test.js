'use strict';

/**
 * C11 Review — timeline-preview must route dual_source_stack to stacked assemble, not clips[0].
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

describe('composition dual timeline-preview routing', () => {
  it('exports renderDualSourceTimelinePreview', () => {
    const preview = require('../lib/composition_preview');
    assert.strictEqual(typeof preview.renderDualSourceTimelinePreview, 'function');
  });

  it('isDualSourceStackMode detects preset + layout', () => {
    const { isDualSourceStackMode } = require('../lib/clip_comp_dual_source');
    assert.ok(isDualSourceStackMode({ preset: 'dual_source_stack' }));
    assert.ok(isDualSourceStackMode({ layout: { mode: 'dual_source_vstack' } }));
    assert.ok(!isDualSourceStackMode({ preset: 'classic_blur_pad' }));
  });

  it('route prefers dual renderer when creative is C11 and 2 clips', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../lib/routes/composition.js'),
      'utf8',
    );
    assert.ok(src.includes('renderDualSourceTimelinePreview'));
    assert.ok(src.includes('isDualSourceStackMode'));
    assert.ok(/dual_source_stack Review needs 2 clips/.test(src));
    const dualIdx = src.indexOf('renderDualSourceTimelinePreview');
    const singleIdx = src.indexOf('renderCompositionTimelinePreview({');
    assert.ok(dualIdx > 0 && singleIdx > dualIdx, 'dual Review path must run before single-clip path');
  });
});
