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

  it('calls onLateBrief with the real brief after timeout', async () => {
    let resolveReal;
    hooks.generateClipCompCreativeBrief = () => new Promise((resolve) => { resolveReal = resolve; });

    let salvaged = null;
    const brief = await hooks.generateClipCompCreativeBriefWithTimeout(
      [{ url: 'https://example.com/a.mp4', displayName: 'Mike', title: 'Big moment' }],
      [{ displayName: 'Mike', title: 'Big moment' }],
      { onLateBrief: (b) => { salvaged = b; } }
    );
    assert.equal(brief.fallbackBrief, true);
    assert.equal(salvaged, null);

    const realBrief = { clips: [{ hook: 'Grief Call to New Car?' }], clipCount: 1 };
    resolveReal(realBrief);
    await new Promise((r) => setImmediate(r));
    assert.equal(salvaged, realBrief);
  });

  it('does not call onLateBrief when the brief promise rejects', async () => {
    hooks.generateClipCompCreativeBrief = () => Promise.reject(new Error('gemini down'));
    let salvaged = null;
    const brief = await hooks.generateClipCompCreativeBriefWithTimeout(
      [{ displayName: 'Mike', title: 'Big moment' }],
      [{ displayName: 'Mike', title: 'Big moment' }],
      { onLateBrief: (b) => { salvaged = b; } }
    );
    assert.equal(brief.fallbackBrief, true);
    await new Promise((r) => setImmediate(r));
    assert.equal(salvaged, null);
  });
});

describe('clipCompBriefTimeoutMs', () => {
  let hooks;
  let origTimeout;

  before(() => {
    origTimeout = process.env.CLIP_COMP_BRIEF_TIMEOUT_MS;
    delete process.env.CLIP_COMP_BRIEF_TIMEOUT_MS;
    delete require.cache[require.resolve('../lib/clip_comp_hooks')];
    hooks = require('../lib/clip_comp_hooks');
  });

  after(() => {
    if (origTimeout == null) delete process.env.CLIP_COMP_BRIEF_TIMEOUT_MS;
    else process.env.CLIP_COMP_BRIEF_TIMEOUT_MS = origTimeout;
    delete require.cache[require.resolve('../lib/clip_comp_hooks')];
  });

  it('scales with clip count when env is unset', () => {
    assert.equal(hooks.clipCompBriefTimeoutMs(1), 300000);
    assert.equal(hooks.clipCompBriefTimeoutMs(3), 900000);
    assert.equal(hooks.clipCompBriefTimeoutMs(), 300000);
    assert.equal(hooks.clipCompBriefTimeoutMs(0), 300000);
  });

  it('env override is absolute and ignores clip count', () => {
    process.env.CLIP_COMP_BRIEF_TIMEOUT_MS = '120000';
    assert.equal(hooks.clipCompBriefTimeoutMs(4), 120000);
    delete process.env.CLIP_COMP_BRIEF_TIMEOUT_MS;
  });
});
