'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  expandAnimRatios,
  densifyAnimatedText,
  strengthenCompCreativeForExecute,
  wantsAutoBeats,
} = require('../lib/clip_comp_execute_fx');

describe('clip_comp_execute_fx', () => {
  it('expands anim ratios to startSec', () => {
    const items = expandAnimRatios([
      { text: 'A', ratio: 0.5, duration: 2 },
    ], 40);
    assert.equal(items[0].startSec, 20);
    assert.equal(items[0].ratio, undefined);
  });

  it('densifies sparse anim packs and preserves WAIT FOR IT clock', () => {
    const out = densifyAnimatedText({
      enabled: true,
      items: [
        { text: 'WATCH THIS', startSec: 0.4, duration: 4 },
        { text: 'WAIT FOR IT', startSec: 18, duration: 2 },
      ],
    }, 60);
    assert.ok(out.items.length >= 6);
    const wait = out.items.find((i) => /WAIT FOR IT/i.test(i.text));
    assert.equal(wait.startSec, 18);
    assert.equal(wait.duration, 2);
  });

  it('strengthens reaction_short grain; keeps Compose look preset', () => {
    const c = strengthenCompCreativeForExecute({
      preset: 'reaction_short',
      look: { preset: 'vivid' },
      speedFeel: 'punch_pause',
      animatedText: { enabled: true, items: [{ text: 'X', startSec: 1, duration: 2 }] },
    }, { durationSec: 60 });
    assert.equal(c.look.preset, 'vivid');
    assert.ok(c.look.filmGrainStrength >= 7 && c.look.filmGrainStrength <= 9);
    assert.equal(c.beatSync.autoExecute, true);
    assert.ok(c.animatedText.items.length >= 6);
  });

  it('does not invent anim text when Compose shipped enabled:false', () => {
    const c = strengthenCompCreativeForExecute({
      preset: 'reaction_short',
      animatedText: { enabled: false },
    }, { durationSec: 45 });
    assert.equal(c.animatedText.enabled, false);
  });

  it('wantsAutoBeats for reaction_short by default', () => {
    assert.equal(wantsAutoBeats({ preset: 'reaction_short' }), true);
    assert.equal(wantsAutoBeats({ preset: 'reaction_short', beatSync: { autoExecute: false } }), false);
    assert.equal(wantsAutoBeats({ preset: 'classic_blur_pad' }), false);
  });
});
