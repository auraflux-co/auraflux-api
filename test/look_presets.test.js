'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveLookPreset,
  buildImpactTintFilter,
  applyLookToEffectsSpec,
  resolveSpeedFeel,
} = require('../lib/look_presets');
const { buildClipCompEffectsSpec } = require('../lib/clip_comp_transform');
const { VIDEO_EFFECTS, buildVideoFilterChain } = require('../lib/assembly_effects');
const { suggestionsFromPeaks } = require('../lib/beat_detect');

describe('CPD-1283 look presets (Gemini tint gap)', () => {
  it('resolves teal/punch looks with colorbalance', () => {
    const teal = resolveLookPreset('teal');
    assert.ok(teal.colorbalance && teal.colorbalance.bs > 0);
    const punch = resolveLookPreset('punch');
    assert.ok(punch.colorbalance && punch.colorbalance.rs > 0);
  });

  it('applyLookToEffectsSpec sets grade + colorBalance', () => {
    const spec = applyLookToEffectsSpec({ colorGrade: { preset: 'crisp' }, effects: { color: {} } }, 'warm');
    assert.equal(spec.colorGrade.preset, 'warm');
    assert.ok(spec.effects.color.colorBalance);
  });

  it('buildClipCompEffectsSpec honors Compose look.preset', () => {
    const spec = buildClipCompEffectsSpec('twitch-short', {
      compCreative: { look: { preset: 'teal' } },
    });
    assert.equal(spec.colorGrade.preset, 'crisp'); // teal bases on crisp
    assert.ok(spec.effects.color.colorBalance.bs > 0);
  });

  it('impact_tint builds enabled colorbalance chain', () => {
    const frag = buildImpactTintFilter([{ atSec: 1.2, duration: 0.3, strength: 0.25 }]);
    assert.match(frag, /eq=brightness=/);
    assert.match(frag, /colorbalance=rs=/);
    assert.match(frag, /enable='between\(t/);
  });

  it('Beats→FX suggestions include impactTint (Core_fx red tint)', () => {
    const sug = suggestionsFromPeaks([{ atSec: 2, score: 2.1 }]);
    assert.ok(sug.impactTint?.flashes?.length === 1);
    const fx = VIDEO_EFFECTS.impact_tint({
      effects: { video: { impact_tint: sug.impactTint } },
    });
    assert.ok(fx && fx.includes('eq=brightness=') && fx.includes('colorbalance='));
  });

  it('color_balance effect returns filter for look tint', () => {
    const frag = VIDEO_EFFECTS.color_balance({
      effects: { color: { colorBalance: { rs: 0.1, bs: -0.05 } } },
    });
    assert.equal(frag, 'colorbalance=rs=0.100:bs=-0.050');
  });

  it('speed feel resolves ramps into trim window', () => {
    const ramps = resolveSpeedFeel('slowmo_hit', { trimStart: 0, trimEnd: 20 });
    assert.ok(ramps && ramps.length === 1);
    assert.ok(ramps[0].factor < 1);
  });
});
