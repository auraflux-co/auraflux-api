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
