'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { needsHookBeforeAssembly, clipCompClipCount } = require('../lib/clip_comp_dispatch_assembly');

test('needsHookBeforeAssembly — hook_review stage', () => {
  assert.equal(needsHookBeforeAssembly({ clipsOnly: true, stage: 'hook_review' }), true);
});

test('needsHookBeforeAssembly — false after driveUrl', () => {
  assert.equal(needsHookBeforeAssembly({ clipsOnly: true, stage: 'awaiting_review', driveUrl: 'https://x' }), false);
});

test('clipCompClipCount from ordered clips', () => {
  assert.equal(clipCompClipCount({ orderedClipUrls: [{}, {}] }), 2);
});
