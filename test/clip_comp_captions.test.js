'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _normalizeClipCompSrt, _chunkCaptionText } = require('../lib/assembly_postprocess');

test('_chunkCaptionText wraps to two short lines per chunk', () => {
  const chunks = _chunkCaptionText(
    'Oh my god Jason oh my god Jay I am so sorry this is the finisher Jay I am so sorry',
    32,
    2,
  );
  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 70);
    assert.ok(chunk.split('\n').length <= 2);
  }
});

test('_normalizeClipCompSrt splits paragraph whisper cues', () => {
  const raw = `1
00:00:00,000 --> 00:00:12,000
Oh my god, Jason. Oh my god, Jay, I'm so sorry. Oh my god, Jay. This is the finisher. I'm so sorry.

`;
  const out = _normalizeClipCompSrt(raw);
  const blocks = out.trim().split(/\n\n/);
  assert.ok(blocks.length >= 2);
  for (const block of blocks) {
    const textLines = block.split('\n').slice(2);
    assert.ok(textLines.length <= 2);
    assert.ok(textLines.join(' ').length <= 72);
  }
});
