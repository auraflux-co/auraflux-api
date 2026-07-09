'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveSourceCleanupRegions,
  regionsToDelogoFilter,
  sourceCleanupSummary,
} = require('../lib/source_cleanup');

describe('source_cleanup', () => {
  it('resolves twitch chat rail preset', () => {
    const regions = resolveSourceCleanupRegions({ hideChatRail: true });
    assert.equal(regions.length, 1);
    assert.equal(regions[0].id, 'chat_rail');
  });

  it('combines presets and custom regions', () => {
    const regions = resolveSourceCleanupRegions({
      hideChatRail: true,
      hideBottomBar: true,
      regions: [{ id: 'badge', x: 0.02, y: 0.02, w: 0.15, h: 0.08 }],
    });
    assert.equal(regions.length, 3);
  });

  it('returns empty when disabled', () => {
    assert.equal(resolveSourceCleanupRegions({ enabled: false, hideChatRail: true }).length, 0);
  });

  it('builds chained delogo filter', () => {
    const vf = regionsToDelogoFilter(resolveSourceCleanupRegions({ hideChatRail: true }));
    assert.match(vf, /delogo=x=iw\*0\.7800/);
  });

  it('formats summary label', () => {
    const s = sourceCleanupSummary({ hideChatRail: true, hideBottomBar: true });
    assert.match(s, /chat rail/);
    assert.match(s, /bottom bar/);
  });
});
