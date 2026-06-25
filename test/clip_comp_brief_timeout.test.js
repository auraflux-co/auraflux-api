'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

describe('generateClipCompCreativeBriefWithTimeout', () => {
  let hooks;
  let origBrief;
  let origTimeout;

  before(() => {
    origTimeout = process.env.CLIP_COMP_BRIEF_TIMEOUT_MS;
    process.env.CLIP_COMP_BRIEF_TIMEOUT_MS = '50';
    delete require.cache[require.resolve('../lib/clip_comp_hooks')];
    hooks = require('../lib/clip_comp_hooks');
    origBrief = hooks.generateClipCompCreativeBrief;
  });

  after(() => {
    hooks.generateClipCompCreativeBrief = origBrief;
    if (origTimeout == null) delete process.env.CLIP_COMP_BRIEF_TIMEOUT_MS;
    else process.env.CLIP_COMP_BRIEF_TIMEOUT_MS = origTimeout;
    delete require.cache[require.resolve('../lib/clip_comp_hooks')];
  });

  it('returns fallback brief when Gemini brief stalls', async () => {
    hooks.generateClipCompCreativeBrief = () => new Promise(() => {});
    const brief = await hooks.generateClipCompCreativeBriefWithTimeout(
      [{ url: 'https://example.com/a.mp4', displayName: 'Mike', title: 'Big moment' }],
      [{ displayName: 'Mike', title: 'Big moment' }],
      {}
    );
    assert.equal(brief.fallbackBrief, true);
    assert.equal(brief.clips.length, 1);
    assert.ok(brief.clips[0].hook);
  });

  it('buildFallbackClipCompBrief produces hooks without Gemini', async () => {
    const brief = await hooks.buildFallbackClipCompBrief(
      [{ displayName: 'Maya', title: 'Clip title' }],
      [{ displayName: 'Maya', title: 'Clip title' }],
      {}
    );
    assert.equal(brief.fallbackBrief, true);
    assert.equal(brief.clips[0].streamer, 'Maya');
    assert.ok(brief.clips[0].hook.length > 0);
  });
});
