'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { QuadrantFeeders } = require('../lib/live_grid/feeders');
const { resolveLiveGridStopOpts } = require('../lib/broadcast/live_routes');

test('feed failure threshold marks quadrant unhealthy and notifies manager', () => {
  const events = [];
  const feeders = new QuadrantFeeders({ log: () => {} });
  feeders.onFeedUnhealthy = (q, info) => events.push({ q, info });

  for (let i = 0; i < 5; i++) {
    feeders._noteFeedFailure(0, 'streamlink exited');
  }

  assert.equal(feeders.quads[0].feedUnhealthy, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].q, 0);
});

test('resolveLiveGridStopOpts ends YouTube when endBroadcast true on RTMP bypass', () => {
  const prevRtmp = process.env.LIVE_GRID_RTMP_URL;
  const prevBid = process.env.LIVE_GRID_BROADCAST_ID;
  process.env.LIVE_GRID_RTMP_URL = 'rtmp://a.rtmp.youtube.com/live2/test';
  process.env.LIVE_GRID_BROADCAST_ID = 'abc123';

  assert.deepEqual(resolveLiveGridStopOpts({}), { skipEndBroadcast: true, endBroadcast: false });
  assert.deepEqual(resolveLiveGridStopOpts({ endBroadcast: true }), { skipEndBroadcast: false, endBroadcast: true });

  if (prevRtmp === undefined) delete process.env.LIVE_GRID_RTMP_URL;
  else process.env.LIVE_GRID_RTMP_URL = prevRtmp;
  if (prevBid === undefined) delete process.env.LIVE_GRID_BROADCAST_ID;
  else process.env.LIVE_GRID_BROADCAST_ID = prevBid;
});
