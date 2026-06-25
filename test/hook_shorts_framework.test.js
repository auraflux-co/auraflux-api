'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildChannelVoiceBlock, loadChannelVoice } = require('../lib/hook_training/channel_voice');
const { isOutcomeSpoilerHook, isFallbackHook } = require('../lib/hook_training/hook_validators');

test('loadChannelVoice includes ClipzWorld brand block fields', () => {
  const v = loadChannelVoice();
  assert.match(v.channel, /ClipzWorld/i);
  assert.ok(v.brandVoice.length >= 3);
  assert.ok(v.rejectedExamples.some((e) => /Escalated Fast/i.test(e.hook)));
});

test('buildChannelVoiceBlock injects approved and rejected examples', () => {
  const block = buildChannelVoiceBlock();
  assert.match(block, /CLIPZWORLD CHANNEL BLOCK/i);
  assert.match(block, /Wrong Shirt Gift/);
  assert.match(block, /Rejected patterns/i);
});

test('isOutcomeSpoilerHook catches two-beat outcome spoilers', () => {
  assert.equal(isOutcomeSpoilerHook("He said 'Don't go.' Then the goal."), true);
  assert.equal(isOutcomeSpoilerHook('Wrong Shirt Gift'), false);
});

test('isFallbackHook blocks generic filler hooks', () => {
  assert.equal(isFallbackHook('That Escalated Fast'), true);
  assert.equal(isFallbackHook('Camera flip meltdown'), false);
});
