'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  isJunkHook,
  normalizeHookLine,
  hooksAreUsable,
  buildHookScript,
} = require('../lib/clip_comp_hooks');

test('isJunkHook rejects twitch passthrough junk', () => {
  assert.equal(isJunkHook('dsda'), true);
  assert.equal(isJunkHook('wisdom'), true);
  assert.equal(isJunkHook('w tricksot'), true);
  assert.equal(isJunkHook('jasontheween: jasont'), true);
  assert.equal(isJunkHook('ExtraEmily: Wrong Shirt Gift'), false);
});

test('normalizeHookLine prefixes streamer when missing', () => {
  assert.equal(
    normalizeHookLine('ExtraEmily', 'Wrong Shirt Gift'),
    'ExtraEmily: Wrong Shirt Gift',
  );
});

test('hooksAreUsable requires full non-junk set', () => {
  assert.equal(hooksAreUsable(['ExtraEmily: Pad Box Open', 'Lacy: Food Meltdown'], 2), true);
  assert.equal(hooksAreUsable(['dsda', 'Lacy: Food Meltdown'], 2), false);
  assert.equal(hooksAreUsable(['ExtraEmily: Pad Box Open'], 2), false);
});

test('buildHookScript uses generated hooks not clip titles', () => {
  const script = buildHookScript(
    [{ displayName: 'ExtraEmily' }, { displayName: 'Lacy' }],
    ['ExtraEmily: Wrong Shirt Gift', 'Lacy: Miami Food Meltdown'],
  );
  assert.match(script, /ExtraEmily: Wrong Shirt Gift/);
  assert.match(script, /Lacy: Miami Food Meltdown/);
  assert.ok(!script.includes('Rave fit'));
});
