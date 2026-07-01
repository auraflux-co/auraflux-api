'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { swapStreamerClipPairInLineup, swapScriptClipScenes } = require('../lib/twitch_clip_script_align');

describe('twitch clip script align', () => {
  it('swaps two clips for one streamer in lineup', () => {
    const urls = [
      { streamer: 'YonnaJay', title: 'A' },
      { streamer: 'YonnaJay', title: 'B' },
    ];
    const r = swapStreamerClipPairInLineup(urls, 'yonnajay', 2);
    assert.equal(r.swapped, true);
    assert.deepEqual(r.orderedClipUrls.map((c) => c.title), ['B', 'A']);
  });

  it('swaps clip1 and clip2 script blocks', () => {
    const script = `=== YONNAJAY_CLIP1_SETUP ===
setup one

=== YONNAJAY_CLIP1_REACTION ===
rx one

=== YONNAJAY_CLIP2_SETUP ===
setup two

=== YONNAJAY_CLIP2_REACTION ===
rx two

=== OUTRO ===
bye
`;
    const out = swapScriptClipScenes(script, 'YONNAJAY');
    assert.match(out, /CLIP1_SETUP ===\nsetup two/);
    assert.match(out, /CLIP2_SETUP ===\nsetup one/);
  });
});
