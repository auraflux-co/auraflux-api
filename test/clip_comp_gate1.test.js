'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { runClipCompGate1 } = require('../lib/gates/clip_comp_gate1');

describe('clip_comp_gate1 (CPD-1051)', () => {
  test('passes valid clip comp input', () => {
    const r = runClipCompGate1(
      {
        contentType: 'twitch-short',
        designSpec: { expectedClipCount: 2, chrome: { layout: 'clip-comp' } },
      },
      {
        title: 'Jason Rage Quits — Twitch Clips',
        clips: [
          { title: 'Jason Rage Quits Minecraft', displayName: 'Jason' },
          { title: 'Jason Wins Round', displayName: 'Jason' },
        ],
      }
    );
    assert.equal(r.passed, true);
    assert.equal(r.outcome, 'pass');
    assert.equal(r.clipCompVariant, true);
  });

  test('hard fails when clip title missing', () => {
    const r = runClipCompGate1(
      { designSpec: { expectedClipCount: 1, chrome: { layout: 'clip-comp' } } },
      { title: 'Clips Comp', clips: [{ title: '', displayName: 'X' }] }
    );
    assert.equal(r.passed, false);
    assert.equal(r.outcome, 'hard_fail');
    assert.ok(r.violations.some((v) => v.includes('missing title')));
  });

  test('does not require platform captions at intake (Gate 5 owns SEO)', () => {
    const r = runClipCompGate1(
      { contentType: 'twitch-short', designSpec: { expectedClipCount: 1, chrome: { layout: 'clip-comp' } } },
      {
        title: 'Clip Short — Marlon',
        clips: [{ title: 'Marlon rage moment', displayName: 'Marlon' }],
      }
    );
    assert.equal(r.passed, true);
    assert.equal(r.violations.some((v) => v.includes('TikTok caption')), false);
  });

  test('blocks AI marketing title', () => {
    const r = runClipCompGate1(
      { contentType: 'twitch-short', designSpec: { chrome: { layout: 'clip-comp' } } },
      {
        title: 'Streamers Go Wild With AI',
        clips: [{ title: 'Big play', displayName: 'Ninja' }],
      }
    );
    assert.equal(r.passed, false);
    assert.equal(r.outcome, 'hard_fail');
    assert.ok(r.violations.some((v) => v.includes('AI')));
  });
});
