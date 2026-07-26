'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildLayoutTimePlan,
  normalizeLayoutBreakpoints,
  formatLayoutPlanSummary,
} = require('../lib/composition_layout_segments');

describe('composition layout segments (Phase B)', () => {
  it('builds split then full bleed plan from breakpoints', () => {
    const plan = buildLayoutTimePlan({
      trimStart: 11,
      trimEnd: 40,
      openingLayout: { mode: 'split_screen' },
      layoutSegments: [{ atSec: 20, mode: 'full_bleed_crop', cropCx: 0.45 }],
    });
    assert.equal(plan.length, 2);
    assert.equal(plan[0].mode, 'split_screen');
    assert.equal(plan[0].startSec, 11);
    assert.equal(plan[0].endSec, 20);
    assert.equal(plan[1].mode, 'full_bleed_crop');
    assert.equal(plan[1].startSec, 20);
    assert.equal(plan[1].endSec, 40);
  });

  it('drops breakpoints outside trim window', () => {
    const bps = normalizeLayoutBreakpoints(
      [{ atSec: 5, mode: 'full_bleed_crop' }, { atSec: 25, mode: 'split_screen' }],
      { trimStart: 11, trimEnd: 40 },
    );
    assert.equal(bps.length, 1);
    assert.equal(bps[0].atSec, 25);
  });

  it('formats plan summary for order panel', () => {
    const plan = buildLayoutTimePlan({
      trimStart: 11,
      trimEnd: 40,
      openingLayout: { mode: 'split_screen' },
      layoutSegments: [{ atSec: 20, mode: 'full_bleed_crop' }],
    });
    const summary = formatLayoutPlanSummary(plan, 11);
    assert.match(summary, /split/);
    assert.match(summary, /full bleed/);
  });

  it('openingLayout-only (no breakpoints) is one full-window range', () => {
    const plan = buildLayoutTimePlan({
      trimStart: 12,
      trimEnd: 60,
      openingLayout: { mode: 'full_bleed_crop', cropCx: 0.36, cropCy: 0.5, cropZoom: 1 },
      layoutSegments: [],
    });
    assert.equal(plan.length, 1);
    assert.equal(plan[0].mode, 'full_bleed_crop');
    assert.equal(plan[0].startSec, 12);
    assert.equal(plan[0].endSec, 60);
    assert.equal(plan[0].layout.cropCx, 0.36);
  });

  it('CPD-1293: openingLayout-only with trimStart>0 returns single range starting at trimStart (verifies trim window is honoured)', () => {
    // Validates the data the fixed applyPortraitLayoutTimed uses: when layoutSegments=[]
    // and openingLayout exists, buildLayoutTimePlan still returns start=trimStart so
    // the pre-trim in the fixed code slices exactly the right window.
    const plan = buildLayoutTimePlan({
      trimStart: 45,
      trimEnd: 75,
      openingLayout: { mode: 'split_screen', facecamRect: { x: 0.68, y: 0.03, w: 0.28, h: 0.30 }, topHeight: 960 },
      layoutSegments: [],
    });
    assert.equal(plan.length, 1, 'single range for no breakpoints');
    assert.equal(plan[0].mode, 'split_screen');
    assert.equal(plan[0].startSec, 45, 'range must start at trimStart, not 0');
    assert.equal(plan[0].endSec, 75);
    assert.ok(plan[0].layout.facecamRect, 'openingLayout facecamRect carried through');
  });

  it('mergeCreativeForSegment sets landscapeSplit false for full bleed', () => {
    const { mergeCreativeForSegment } = require('../lib/composition_layout_segments');
    const merged = mergeCreativeForSegment(
      { layout: { mode: 'split_screen', landscapeSplit: true, facecamRect: { x: 0.3, y: 0, w: 0.4, h: 0.4 } } },
      { mode: 'full_bleed_crop', cropCx: 0.4, cropCy: 0.5, cropZoom: 1.1 },
    );
    assert.equal(merged.layout.mode, 'full_bleed_crop');
    assert.equal(merged.layout.landscapeSplit, false);
    assert.equal(merged.layout.cropCx, 0.4);
    assert.equal(merged.layout.logo, 'corner');
    assert.equal(merged.layout.logoCorner, 'top_right');
  });
});
