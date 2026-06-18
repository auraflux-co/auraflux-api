'use strict';

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
    expect(r.passed).toBe(true);
    expect(r.outcome).toBe('pass');
    expect(r.clipCompVariant).toBe(true);
  });

  test('hard fails when clip title missing', () => {
    const r = runClipCompGate1(
      { designSpec: { expectedClipCount: 1, chrome: { layout: 'clip-comp' } } },
      { title: 'Clips Comp', clips: [{ title: '', displayName: 'X' }] }
    );
    expect(r.passed).toBe(false);
    expect(r.outcome).toBe('hard_fail');
    expect(r.violations.some((v) => v.includes('missing title'))).toBe(true);
  });

  test('does not require platform captions at intake (Gate 5 owns SEO)', () => {
    const r = runClipCompGate1(
      { contentType: 'twitch-short', designSpec: { expectedClipCount: 1, chrome: { layout: 'clip-comp' } } },
      {
        title: 'Clip Short — Marlon',
        clips: [{ title: 'Marlon rage moment', displayName: 'Marlon' }],
      }
    );
    expect(r.passed).toBe(true);
    expect(r.violations.some((v) => v.includes('TikTok caption'))).toBe(false);
  });

  test('blocks AI marketing title', () => {
    const r = runClipCompGate1(
      { contentType: 'twitch-short', designSpec: { chrome: { layout: 'clip-comp' } } },
      {
        title: 'Streamers Go Wild With AI',
        clips: [{ title: 'Big play', displayName: 'Ninja' }],
      }
    );
    expect(r.passed).toBe(false);
    expect(r.outcome).toBe('hard_fail');
    expect(r.violations.some((v) => v.includes('AI'))).toBe(true);
  });
});
