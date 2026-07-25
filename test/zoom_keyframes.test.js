'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  expandZoomRamps,
  normalizeZoomPunches,
  buildZoomPunchFilter,
  punchesFromLayoutPlan,
} = require('../lib/zoom_keyframes');
const { VIDEO_EFFECTS, buildVideoFilterChain } = require('../lib/assembly_effects');
const { buildLayoutTimePlan } = require('../lib/composition_layout_segments');

describe('CPD-1279 zoom keyframes', () => {
  it('expands full-bleed zoom change into ramp micro-segments', () => {
    const plan = buildLayoutTimePlan({
      trimStart: 0,
      trimEnd: 20,
      openingLayout: { mode: 'full_bleed_crop', cropCx: 0.5, cropCy: 0.5, cropZoom: 1 },
      layoutSegments: [{ atSec: 8, mode: 'full_bleed_crop', cropCx: 0.4, cropCy: 0.45, cropZoom: 1.4 }],
    });
    assert.equal(plan.length, 2);
    const expanded = expandZoomRamps(plan, { rampSec: 0.4, stepSec: 0.08 });
    assert.ok(expanded.length > plan.length, `expected ramp expand, got ${expanded.length}`);
    const last = expanded[expanded.length - 1];
    assert.equal(last.mode, 'full_bleed_crop');
    assert.ok(Number(last.layout.cropZoom) >= 1.35);
    // First ramp step should be between 1 and 1.4
    const rampStep = expanded.find((r) => r.startSec >= 8 && r.endSec <= 8.5);
    assert.ok(rampStep);
    assert.ok(rampStep.layout.cropZoom > 1 && rampStep.layout.cropZoom < 1.4);
  });

  it('does not expand mode switches (split → full bleed)', () => {
    const plan = buildLayoutTimePlan({
      trimStart: 0,
      trimEnd: 20,
      openingLayout: { mode: 'split_screen' },
      layoutSegments: [{ atSec: 10, mode: 'full_bleed_crop', cropZoom: 1.3 }],
    });
    const expanded = expandZoomRamps(plan);
    assert.equal(expanded.length, plan.length);
  });

  it('normalizes single and multi punch configs', () => {
    const one = normalizeZoomPunches({ enabled: true, atSec: 2, zoom: 1.3, duration: 0.5 });
    assert.equal(one.length, 1);
    assert.equal(one[0].atSec, 2);
    assert.equal(one[0].zoom, 1.3);

    const many = normalizeZoomPunches({
      enabled: true,
      punches: [{ atSec: 1, zoom: 1.2 }, { t: 4, scale: 1.5, duration: 0.3 }],
    });
    assert.equal(many.length, 2);
    assert.equal(many[1].zoom, 1.5);
  });

  it('builds a zoompan filter fragment for punches', () => {
    const frag = buildZoomPunchFilter([
      { atSec: 2, zoom: 1.3, duration: 0.4, cx: 0.5, cy: 0.4 },
    ], { width: 1080, height: 1920, fps: 30 });
    assert.match(frag, /^zoompan=z=/);
    assert.match(frag, /s=1080x1920/);
    assert.match(frag, /fps=30/);
  });

  it('zoom_punch effect returns filter when enabled with punches', () => {
    const frag = VIDEO_EFFECTS.zoom_punch({
      effects: { video: { zoom_punch: { enabled: true, atSec: 1.5, zoom: 1.25, duration: 0.35 } } },
    });
    assert.ok(frag);
    assert.match(frag, /zoompan=/);

    const chain = buildVideoFilterChain({
      effects: { video: { zoom_punch: { enabled: true, punches: [{ atSec: 3, zoom: 1.4 }] } } },
    });
    assert.ok(chain && chain.includes('zoompan='));
  });

  it('zoom_punch stays null when disabled or empty', () => {
    assert.equal(VIDEO_EFFECTS.zoom_punch({ effects: { video: { zoom_punch: { enabled: true } } } }), null);
    assert.equal(VIDEO_EFFECTS.zoom_punch({ effects: { video: { zoom_punch: { enabled: false, atSec: 1 } } } }), null);
  });

  it('punchesFromLayoutPlan derives punch-ins from zoom-up looks', () => {
    const plan = buildLayoutTimePlan({
      trimStart: 0,
      trimEnd: 30,
      openingLayout: { mode: 'full_bleed_crop', cropZoom: 1 },
      layoutSegments: [{ atSec: 12, mode: 'full_bleed_crop', cropZoom: 1.35, cropCx: 0.42 }],
    });
    const punches = punchesFromLayoutPlan(plan);
    assert.equal(punches.length, 1);
    assert.equal(punches[0].atSec, 12);
    assert.ok(punches[0].zoom >= 1.3);
  });
});
