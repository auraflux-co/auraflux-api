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

  it('validates comp clip count — classic allows 2+ clips', () => {
    const two = buildCompositionSpec({
      deliveryFormat: 'comp',
      compCreativePreset: 'classic_blur_pad',
      clips: [{ url: 'https://a', duration: 30 }, { url: 'https://b', duration: 30 }],
    });
    assert.equal(two.validation.ok, true);

    const one = buildCompositionSpec({
      deliveryFormat: 'comp',
      compCreativePreset: 'classic_blur_pad',
      clips: [{ url: 'https://a', duration: 30 }],
    });
    assert.equal(one.validation.ok, false);
    assert.ok(one.validation.errors.some((e) => e.includes('at least')));
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

  it('maps sports wire to sports-short', () => {
    const { spec } = buildCompositionSpec({
      deliveryFormat: 'short',
      compCreativePreset: 'full_bleed',
      contentSource: 'sports',
      clips: [{ url: 'https://x.mp4', pageUrl: 'https://x', title: 'X', duration: 60 }],
    });
    assert.equal(spec.contentType, 'sports-short');
  });

  it('builds vod segment spec from vodSegment body', () => {
    const { spec, validation } = buildCompositionSpec({
      deliveryFormat: 'vod_segment',
      compCreativePreset: 'classic_blur_pad',
      vodSegment: {
        vodUrl: 'https://www.twitch.tv/videos/123',
        streamer: 'hasanabi',
        title: 'Highlight',
        duration_sec: 7200,
        start_sec: 1200,
        end_sec: 1620,
      },
    });
    assert.equal(spec.clips.length, 1);
    assert.equal(spec.clips[0].trimStart, 1200);
    assert.equal(spec.clips[0].trimEnd, 1620);
    assert.equal(validation.ok, true);
    const body = toGenerateClipCompBody(spec);
    assert.equal(body.clips[0].url, 'https://www.twitch.tv/videos/123');
  });
});
