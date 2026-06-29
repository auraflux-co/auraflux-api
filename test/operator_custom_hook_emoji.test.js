'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { applyOperatorCustomHook } = require('../lib/clip_comp_hooks');

test('applyOperatorCustomHook saves emoji in hook title', () => {
  const card = {
    clipsOnly: true,
    orderedClipUrls: [{ streamer: 'funnymike', displayName: 'funnymike', title: '.' }],
    clipHookTitles: [],
    clipHookCandidates: [[]],
    clipCompBrief: { clips: [{ hook: '' }] },
  };
  const result = applyOperatorCustomHook(card, 0, 'WHO LET HIM COOK 💀');
  assert.equal(result.ok, true);
  assert.equal(result.hook, 'WHO LET HIM COOK 💀');
  assert.equal(card.clipHookTitles[0], 'WHO LET HIM COOK 💀');
});
