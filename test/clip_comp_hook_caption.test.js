'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  _wrapHookLines,
  _buildHookDrawtextFilters,
  buildClipCompHookStyle,
} = require('../lib/assembly_postprocess');
const { buildClipCompDesignSpec } = require('../lib/clip_comp');

test('_wrapHookLines splits long titles without newline characters', () => {
  const title = 'Emily explains why her pad box was open';
  const lines = _wrapHookLines(title, 2, 30);
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes('Emily'));
  assert.ok(lines[1].includes('pad') || lines[1].includes('open'));
  assert.ok(!lines.join('').includes('\n'));
  assert.ok(!lines.join('').includes('hernpad'));
});

test('_wrapHookLines keeps short titles on one line', () => {
  const lines = _wrapHookLines('her pad box', 2, 36);
  assert.deepEqual(lines, ['her pad box']);
});

test('_buildHookDrawtextFilters uses two drawtext filters for two lines', () => {
  const style = buildClipCompHookStyle(
    buildClipCompDesignSpec({ clipCount: 2, sourceContentType: 'twitch-short' }),
    'twitch-short',
  );
  const vf = _buildHookDrawtextFilters(['Line one here', 'Line two here'], style, 1264);
  assert.match(vf, /drawtext=.*text='Line one here'/);
  assert.match(vf, /drawtext=.*text='Line two here'/);
  assert.ok(!vf.includes('\\n'));
  assert.ok(!vf.includes('applynfor'));
});

test('_wrapHookLines strips emoji that FFmpeg cannot render', () => {
  const lines = _wrapHookLines('World Cup Game! 😂', 2, 36);
  const joined = lines.join(' ');
  assert.ok(!joined.includes('😂'));
  assert.match(joined, /World Cup Game/);
});

test('resolveClipHookTitle rejects single-letter junk titles', () => {
  const { resolveClipHookTitle } = require('../lib/clip_comp_cards');
  const title = resolveClipHookTitle(
    { title: 'd' },
    { displayName: 'ExtraEmily', streamer: 'extraemily' },
  );
  assert.ok(title.length >= 10);
  assert.match(title, /ExtraEmily/i);
});

test('stripDrawtextUnsafe removes emoji', () => {
  const { stripDrawtextUnsafe } = require('../lib/clip_comp_cards');
  assert.equal(stripDrawtextUnsafe('Hello! 😂'), 'Hello!');
});

test('twitch clip comp hook uses brand gold not twitch purple', () => {
  const spec = buildClipCompDesignSpec({ clipCount: 4, sourceContentType: 'twitch-short' });
  assert.equal(spec.chrome.caption.colors.clips, '#c7af4f');
});
