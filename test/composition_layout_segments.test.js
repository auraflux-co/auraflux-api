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
});
