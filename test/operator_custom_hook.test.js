'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { applyOperatorCustomHook } = require('../lib/clip_comp_hooks');

test('applyOperatorCustomHook saves operator text and prepends custom candidate', () => {
  const card = {
    clipsOnly: true,
    orderedClipUrls: [{ streamer: 'PlaqueBoyMax', displayName: 'PlaqueBoyMax', title: 'declinced' }],
    clipHookTitles: ['That Escalated Fast'],
    clipHookCandidates: [[]],
    clipCompBrief: { clips: [{ hook: 'That Escalated Fast' }] },
  };
  const result = applyOperatorCustomHook(card, 0, 'Card declined at $43');
  assert.equal(result.ok, true);
  assert.equal(result.hook, 'Card declined at $43');
  assert.equal(card.clipHookTitles[0], 'Card declined at $43');
  assert.equal(card.clipHookCandidates[0][0].operatorCustom, true);
  assert.equal(card.clipHookCandidates[0][0].selected, true);
  assert.equal(card.clipCompBrief.clips[0].hookQa.operatorCustom, true);
});

test('applyOperatorCustomHook strips streamer prefix from operator input', () => {
  const card = {
    orderedClipUrls: [{ streamer: 'Lacy', displayName: 'Lacy', title: 'gabege' }],
    clipHookTitles: [],
    clipHookCandidates: [],
  };
  const result = applyOperatorCustomHook(card, 0, 'Lacy: bad song review');
  assert.equal(result.ok, true);
  assert.equal(result.hook, 'bad song review');
});
