'use strict';

const { LiveGridManager } = require('../lib/live_grid/manager');

describe('LiveGridManager feeder/poller reconcile', () => {
  test('_feederLayoutMismatch detects channel not on-air', () => {
    const mgr = Object.create(LiveGridManager.prototype);
    mgr.feeders = {
      status: () => ([
        { kind: 'slate', login: 'ludwig' },
        { kind: 'slate', login: null },
        { kind: 'channel', login: 'yugi2x' },
        { kind: 'channel', login: 'yourragegaming' },
      ]),
    };
    const sources = ['ludwig', 'hasanabi', 'yugi2x', 'yourragegaming'];
    expect(mgr._feederLayoutMismatch(sources)).toBe(true);
  });

  test('_feederLayoutMismatch false when channels match layout', () => {
    const mgr = Object.create(LiveGridManager.prototype);
    mgr.feeders = {
      status: () => ([
        { kind: 'channel', login: 'ludwig' },
        { kind: 'channel', login: 'hasanabi' },
        { kind: 'channel', login: 'yugi2x' },
        { kind: 'channel', login: 'yourragegaming' },
      ]),
    };
    const sources = ['ludwig', 'hasanabi', 'yugi2x', 'yourragegaming'];
    expect(mgr._feederLayoutMismatch(sources)).toBe(false);
  });

  test('_feederLayoutMismatch ignores pending login on slate', () => {
    const mgr = Object.create(LiveGridManager.prototype);
    mgr.feeders = {
      status: () => ([
        { kind: 'slate', login: 'ludwig' },
        { kind: 'slate', login: null },
        { kind: 'slate', login: null },
        { kind: 'slate', login: null },
      ]),
    };
    const sources = [null, null, null, null];
    expect(mgr._feederLayoutMismatch(sources)).toBe(false);
  });
});
