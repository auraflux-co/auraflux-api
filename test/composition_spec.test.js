'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildCompositionSpec,
  clipDurationAfterTrim,
  toGenerateClipCompBody,
} = require('../lib/composition_spec');

describe('composition_spec', () => {
  it('builds spec with preview layers and features', () => {
    const { spec, validation } = buildCompositionSpec({
      deliveryFormat: 'short',
      compCreativePreset: 'classic_blur_pad',
      clips: [{
        url: 'https://clips.twitch.tv/TestClip',
        title: 'Test',
        duration: 45,
        trimStart: 2,
        trimEnd: 40,
      }],
    });
    assert.equal(spec.version, 1);
    assert.equal(spec.clips.length, 1);
    assert.equal(spec.preview.layoutMode, 'blur_pad');
    assert.ok(spec.features.chips.length);
    assert.equal(clipDurationAfterTrim(spec.clips[0]), 38);
    assert.equal(validation.ok, true);
  });

  it('validates comp clip count', () => {
    const { spec, validation } = buildCompositionSpec({
      deliveryFormat: 'comp',
      compCreativePreset: 'classic_blur_pad',
      clips: [{ url: 'https://a', duration: 30 }, { url: 'https://b', duration: 30 }],
    });
    assert.equal(validation.ok, false);
    assert.ok(validation.errors.some((e) => e.includes('at least')));
  });

  it('maps to generate-clip-comp body', () => {
    const { spec } = buildCompositionSpec({
      deliveryFormat: 'short',
      compCreativePreset: 'full_bleed',
      platforms: ['youtube'],
      clips: [{ url: 'https://x.mp4', pageUrl: 'https://clips.twitch.tv/x', title: 'X', duration: 60 }],
    });
    const body = toGenerateClipCompBody(spec);
    assert.equal(body.contentType, 'twitch-short');
    assert.equal(body.clips[0].trimEnd, 60);
    assert.equal(body.compositionSpec.version, 1);
  });
});
