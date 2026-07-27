'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

test('clip comp template mode is off unless CLIP_COMP_EXPERIMENT=1 or look ordered', () => {
  delete process.env.CLIP_COMP_EXPERIMENT;
  delete process.env.CLIP_COMP_TRANSFORM;
  const mod = require('../lib/clip_comp_template');
  assert.equal(mod.clipCompExperimentEnabled(), false);
  assert.equal(mod.shouldApplyClipCompTransform(true), false);
  assert.equal(mod.shouldApplyClipCompTransform(false), false);
  assert.ok(mod.clipCompWhisperCaptionStyleSuffix().includes('MarginV'));
});

test('CPD-1293: Punch/look ordered enables transform without CLIP_COMP_EXPERIMENT', () => {
  delete process.env.CLIP_COMP_EXPERIMENT;
  delete process.env.CLIP_COMP_TRANSFORM;
  const mod = require('../lib/clip_comp_template');
  assert.equal(mod.shouldApplyClipCompTransform(true, { compCreative: { look: { preset: 'punch' } } }), true);
  assert.equal(mod.shouldApplyClipCompTransform(true, { lookPreset: 'teal' }), true);
  assert.equal(mod.shouldApplyClipCompTransform(true, { compCreative: { effects: { transform: true } } }), true);
  assert.equal(mod.shouldApplyClipCompTransform(true, { compCreative: { look: { preset: 'auto' } } }), false);
});

test('CPD-1293: look on standalone compCreative enables transform', () => {
  delete process.env.CLIP_COMP_EXPERIMENT;
  delete process.env.CLIP_COMP_TRANSFORM;
  const mod = require('../lib/clip_comp_template');
  assert.equal(mod.shouldApplyClipCompTransform(true, null, { look: { preset: 'punch' } }), true);
  assert.equal(mod.shouldApplyClipCompTransform(true, null, { effects: { transform: true } }), true);
});

test('CLIP_COMP_EXPERIMENT enables transform and clears template caption suffix', () => {
  process.env.CLIP_COMP_EXPERIMENT = '1';
  const mod = require('../lib/clip_comp_template');
  assert.equal(mod.clipCompExperimentEnabled(), true);
  assert.equal(mod.shouldApplyClipCompTransform(true), true);
  assert.equal(mod.clipCompWhisperCaptionStyleSuffix(), '');
  delete process.env.CLIP_COMP_EXPERIMENT;
});

test('golden reference documents Jun 17 job id', () => {
  const { GOLDEN_REFERENCE } = require('../lib/clip_comp_template');
  assert.match(GOLDEN_REFERENCE.jobId, /1781715314184/);
});
