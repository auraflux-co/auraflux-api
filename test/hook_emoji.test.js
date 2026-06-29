'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('node:path');
const {
  HOOK_EMOJI_PICKLIST,
  emojiToAssetCode,
  resolveEmojiAssetPath,
  splitHookBurnTokens,
  sanitizeHookLineGlyphs,
  buildHookBurnFilterPlan,
} = require('../lib/hook_emoji');
const { _wrapHookLines, buildClipCompHookStyle } = require('../lib/assembly_postprocess');
const { buildClipCompDesignSpec } = require('../lib/clip_comp');
const { normalizeHookLine } = require('../lib/clip_comp_hooks');

test('HOOK_EMOJI_PICKLIST assets exist on disk', () => {
  for (const item of HOOK_EMOJI_PICKLIST) {
    const p = resolveEmojiAssetPath(item.char);
    assert.ok(fs.existsSync(p), `missing PNG for ${item.char} (${p})`);
  }
});

test('emojiToAssetCode maps common glyphs', () => {
  assert.equal(emojiToAssetCode('💀'), '1f480');
  assert.equal(emojiToAssetCode('😂'), '1f602');
});

test('splitHookBurnTokens preserves text and emoji order', () => {
  const tokens = splitHookBurnTokens('WHO LET HIM COOK 💀');
  assert.equal(tokens.length, 2);
  assert.equal(tokens[0].type, 'text');
  assert.equal(tokens[0].value.trim(), 'WHO LET HIM COOK');
  assert.equal(tokens[1].type, 'emoji');
  assert.equal(tokens[1].value, '💀');
});

test('_wrapHookLines keeps emoji in output', () => {
  const lines = _wrapHookLines('World Cup Game! 😂', 2, 36);
  const joined = lines.join(' ');
  assert.ok(joined.includes('😂'));
  assert.match(joined, /World Cup Game/);
});

test('normalizeHookLine preserves emoji', () => {
  assert.equal(
    normalizeHookLine('funnymike', 'Said rock. Threw paper. Why? 💀', '.'),
    'Said rock. Threw paper. Why? 💀',
  );
});

test('buildHookBurnFilterPlan includes overlay for emoji hooks', () => {
  const style = buildClipCompHookStyle(
    buildClipCompDesignSpec({ clipCount: 1, sourceContentType: 'twitch-short' }),
    'twitch-short',
  );
  const plan = buildHookBurnFilterPlan(['WHO LET HIM COOK 💀'], style, { sharpBottom: 1264 });
  assert.ok(plan);
  assert.ok(plan.extraInputs.length >= 1);
  assert.match(plan.filterComplex, /overlay=/);
  assert.match(plan.filterComplex, /drawtext=/);
});
