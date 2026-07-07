'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildCompositionSpec,
  toGenerateClipCompBody,
} = require('../lib/composition_spec');
const {
  finalizeCompCreativeForAssembly,
  mergeCompCreative,
} = require('../lib/clip_comp_creative');

describe('compose → assembly creative lock', () => {
  it('dahbluh single view finalizes without split crops', () => {
    const { spec, validation } = buildCompositionSpec({
      deliveryFormat: 'short',
      compCreativePreset: 'dahbluh_clean',
      compCreative: {
        layout: { landscapeSplit: false, mode: 'full_bleed_crop' },
      },
      clips: [{
        url: 'https://clips.twitch.tv/Test',
        orientation: 'landscape',
        duration: 60,
      }],
    });
    assert.equal(validation.ok, true);
    assert.equal(spec.compCreative.layout.landscapeSplit, false);
    assert.equal(spec.compCreative.layout.mode, 'full_bleed_crop');
    assert.equal(spec.compCreative.layout.facecamRect, undefined);
    assert.equal(spec.compCreative.layout.bottomPaneRect, undefined);

    const body = toGenerateClipCompBody(spec);
    assert.equal(body.editorSignedOff, true);
    assert.ok(body.compositionSpec);
    assert.equal(body.compCreative.layout.landscapeSplit, false);
    assert.equal(body.compCreative.layout.facecamRect, undefined);
  });

  it('strips leaked split rects when single view is finalized', () => {
    const finalized = finalizeCompCreativeForAssembly(
      mergeCompCreative({
        preset: 'dahbluh_clean',
        overrides: {
          layout: {
            landscapeSplit: false,
            mode: 'split_screen',
            facecamRect: { x: 0.32, y: 0.04, w: 0.36, h: 0.38 },
            bottomPaneRect: { x: 0.28, y: 0.02, w: 0.43, h: 0.8 },
          },
        },
      }),
      { clipOrientations: ['landscape'], operatorLocked: true },
    );
    assert.equal(finalized.layout.landscapeSplit, false);
    assert.equal(finalized.layout.mode, 'full_bleed_crop');
    assert.equal(finalized.layout.facecamRect, undefined);
    assert.equal(finalized.operatorLocked, true);
  });

  it('single view preserves operator cropCx/cropCy through finalize', () => {
    const finalized = finalizeCompCreativeForAssembly(
      mergeCompCreative({
        preset: 'dahbluh_clean',
        overrides: {
          layout: {
            landscapeSplit: false,
            mode: 'full_bleed_crop',
            cropCx: 0.72,
            cropCy: 0.38,
          },
        },
      }),
      { clipOrientations: ['landscape'], operatorLocked: true },
    );
    assert.equal(finalized.layout.landscapeSplit, false);
    assert.equal(finalized.layout.cropCx, 0.72);
    assert.equal(finalized.layout.cropCy, 0.38);
    assert.equal(finalized.layout.facecamRect, undefined);
  });

  it('split view keeps operator crop rects', () => {
    const finalized = finalizeCompCreativeForAssembly(
      mergeCompCreative({
        preset: 'dahbluh_clean',
        overrides: {
          layout: {
            landscapeSplit: true,
            mode: 'split_screen',
            facecamRect: { x: 0.32, y: 0.04, w: 0.36, h: 0.38 },
            bottomPaneRect: { x: 0.28, y: 0.02, w: 0.43, h: 0.8 },
          },
        },
      }),
      { clipOrientations: ['landscape'] },
    );
    assert.equal(finalized.layout.landscapeSplit, true);
    assert.equal(finalized.layout.mode, 'split_screen');
    assert.deepEqual(finalized.layout.facecamRect, { x: 0.32, y: 0.04, w: 0.36, h: 0.38 });
  });
});
