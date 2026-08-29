'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  needsHookBeforeAssembly,
  clipCompClipCount,
  clipCompBurnedHooksEnabled,
} = require('../lib/clip_comp_dispatch_assembly');

test('needsHookBeforeAssembly — hook_review stage', () => {
  assert.equal(needsHookBeforeAssembly({ clipsOnly: true, stage: 'hook_review' }), true);
});

test('needsHookBeforeAssembly — false after driveUrl', () => {
  assert.equal(needsHookBeforeAssembly({ clipsOnly: true, stage: 'awaiting_review', driveUrl: 'https://x' }), false);
});

test('clipCompClipCount from ordered clips', () => {
  assert.equal(clipCompClipCount({ orderedClipUrls: [{}, {}] }), 2);
});

test('clipCompBurnedHooksEnabled — fableflow_speed is whisper_only', () => {
  assert.equal(clipCompBurnedHooksEnabled({
    compCreative: { preset: 'fableflow_speed' },
  }), false);
  assert.equal(clipCompBurnedHooksEnabled({
    compCreativePreset: 'fableflow_speed',
  }), false);
});

test('clipCompBurnedHooksEnabled — classic_blur_pad burns hooks', () => {
  assert.equal(clipCompBurnedHooksEnabled({
    compCreative: { preset: 'classic_blur_pad' },
  }), true);
});

test('needsHookBeforeAssembly — whisper_only still needs first assemble', () => {
  assert.equal(needsHookBeforeAssembly({
    clipsOnly: true,
    stage: 'hook_review',
    compCreative: { preset: 'fableflow_speed', hooks: { mode: 'whisper_only' } },
  }), true);
  assert.equal(needsHookBeforeAssembly({
    clipsOnly: true,
    stage: 'awaiting_review',
    assembledAt: '2026-01-01',
    driveUrl: 'https://x',
    compCreative: { preset: 'fableflow_speed' },
  }), false);
});
