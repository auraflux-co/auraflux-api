const { pickBestForStream, discoverBroadcastIds } = require('../lib/live_grid/broadcast_discover');

describe('broadcast_discover', () => {
  const broadcasts = [
    { broadcastId: 'MAIN_LIVE', boundStreamId: 'stream-main', lifeCycleStatus: 'live', privacyStatus: 'public', title: 'main' },
    { broadcastId: 'MAIN_ORPHAN', boundStreamId: 'stream-main', lifeCycleStatus: 'ready', privacyStatus: 'private', title: 'orphan' },
    { broadcastId: 'S1_LIVE', boundStreamId: 'stream-s1', lifeCycleStatus: 'live', privacyStatus: 'public', title: 'q1' },
    { broadcastId: 'S2_TEST', boundStreamId: 'stream-s2', lifeCycleStatus: 'testing', privacyStatus: 'private', title: 'q2' },
  ];

  test('pickBestForStream prefers live public over ready private on same ingest key', () => {
    expect(pickBestForStream(broadcasts, 'stream-main')).toBe('MAIN_LIVE');
  });

  test('discoverBroadcastIds maps seats by stream id', () => {
    const r = discoverBroadcastIds({
      broadcasts,
      mainStreamId: 'stream-main',
      soloStreamIds: { 1: 'stream-s1', 2: 'stream-s2', 3: 'missing' },
    });
    expect(r.mainBroadcastId).toBe('MAIN_LIVE');
    expect(r.soloBroadcastIds).toEqual({ 1: 'S1_LIVE', 2: 'S2_TEST' });
  });
});
