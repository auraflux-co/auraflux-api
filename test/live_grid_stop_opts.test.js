const { resolveLiveGridStopOpts } = require('../lib/broadcast/live_routes');

describe('live grid stop opts', () => {
  test('default stop keeps YouTube listing open', () => {
    const o = resolveLiveGridStopOpts({});
    expect(o.endBroadcast).toBe(false);
    expect(o.skipEndBroadcast).toBe(true);
  });

  test('endBroadcast true ends YouTube listing', () => {
    const o = resolveLiveGridStopOpts({ endBroadcast: true });
    expect(o.endBroadcast).toBe(true);
    expect(o.skipEndBroadcast).toBe(false);
  });

  test('shutdown reason preserves listing', () => {
    const o = resolveLiveGridStopOpts({ reason: 'shutdown' });
    expect(o.skipEndBroadcast).toBe(true);
    expect(o.endBroadcast).toBe(false);
  });
});
