'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  compareComposerIntentVsBurned,
  intentFromComposeState,
} = require('../lib/composer_intent_vs_burned');
const { densifyAnimatedText, strengthenCompCreativeForExecute } = require('../lib/clip_comp_execute_fx');

describe('composer_intent_vs_burned', () => {
  it('flags anim_text OVERBURN when intent off but applied', () => {
    const intent = intentFromComposeState({ animTextOn: false, look: 'retro' });
    const report = compareComposerIntentVsBurned(intent, {
      applied: ['look_transform', 'anim_text', 'beats_fx'],
      missing: ['whisper_captions'],
    });
    assert.equal(report.ok, false);
    const anim = report.rows.find((r) => r.key === 'anim_text');
    assert.equal(anim.verdict, 'OVERBURN');
  });

  it('MATCH when intent and burns align; whisper is EXPECTED_MISSING', () => {
    const intent = intentFromComposeState({
      animTextOn: true,
      look: 'retro',
      beatsOn: true,
      musicBed: 'low_trap',
      speedFeel: 'punch_pause',
      whisperOn: true,
    });
    const report = compareComposerIntentVsBurned(intent, {
      applied: ['look_transform', 'anim_text', 'beats_fx', 'speed_ramps', 'music_bed_sfx'],
      missing: ['whisper_captions'],
    });
    assert.equal(report.ok, true);
    const cap = report.rows.find((r) => r.key === 'captions');
    assert.equal(cap.verdict, 'EXPECTED_MISSING');
  });

  it('hooks OFF is SKIP (exec path), not a near-final gap', () => {
    const intent = intentFromComposeState({ hookMode: 'whisper_only' });
    const report = compareComposerIntentVsBurned(intent, { applied: ['look_transform'], missing: [] });
    const hooks = report.rows.find((r) => r.key === 'hooks');
    assert.equal(hooks.verdict, 'SKIP');
    assert.match(hooks.hint, /no hook card/);
  });
});

describe('compose-shipped EXECUTE honors OFF', () => {
  it('densifyAnimatedText returns enabled:false when Compose turned anim off', () => {
    const out = densifyAnimatedText({ enabled: false }, 45);
    assert.equal(out.enabled, false);
    assert.equal(out.items, undefined);
  });

  it('strengthen does not invent anim/hooks FX when composeShipped', () => {
    const c = strengthenCompCreativeForExecute({
      preset: 'reaction_short',
      composeShipped: true,
      operatorLocked: true,
      look: { preset: 'auto' },
      speedFeel: 'normal',
      animatedText: { enabled: false },
      hooks: { mode: 'whisper_only' },
      beatSync: { autoExecute: false },
    }, { durationSec: 45 });
    assert.equal(c.animatedText.enabled, false);
    assert.equal(c.speedFeel, 'normal');
    assert.equal(c.look.preset, 'auto');
    assert.equal(c.hooks.mode, 'whisper_only');
  });
});
