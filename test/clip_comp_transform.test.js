'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildClipCompEffectsSpec } = require('../lib/clip_comp_transform');
const { buildVideoFilterChain, buildAudioFilterChain } = require('../lib/assembly_effects');

test('clip comp transform spec builds ffmpeg filter chains', () => {
  const spec = buildClipCompEffectsSpec('sports-short', {});
  const vf = buildVideoFilterChain(spec);
  const af = buildAudioFilterChain(spec);
  assert.ok(vf.includes('eq='), 'color grade');
  assert.ok(vf.includes('vignette='), 'vignette');
  assert.ok(vf.includes('noise='), 'film grain');
  assert.ok(vf.includes('drawtext='), 'social badge');
  assert.ok(af.includes('acompressor='), 'speech duck');
});

test('CPD-1293: audio chain strips SOUND_EFFECTS sentinel (highlight SFX already mixed in assembly)', () => {
  const spec = buildClipCompEffectsSpec('twitch-short', {
    compCreative: {
      look: { preset: 'punch' },
      effects: { transform: true },
      audio: {
        highlightSfx: {
          enabled: true,
          drops: [{ atSec: 4.6, kind: 'impact', volume: 0.5 }],
        },
      },
    },
  });
  const af = buildAudioFilterChain(spec);
  assert.ok(af && af.includes('acompressor='), 'duck still present');
  assert.ok(!af.includes('__SOUND_EFFECTS_AMIX__'), 'sentinel must not reach -af');
});
