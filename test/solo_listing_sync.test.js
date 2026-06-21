'use strict';

const { resolveBroadcastIdForSeat } = require('../lib/live_grid/solo_listing_sync');

describe('solo_listing_sync', () => {
  test('resolveBroadcastIdForSeat prefers env pin over discover map', () => {
    const seat = { quadrant: 4, broadcastId: 'damkiUux4F0' };
    const idMap = { 4: 'OLD_BROADCAST_ID' };
    expect(resolveBroadcastIdForSeat(seat, idMap)).toBe('damkiUux4F0');
  });

  test('resolveBroadcastIdForSeat falls back to discover map', () => {
    const seat = { quadrant: 2, broadcastId: null };
    expect(resolveBroadcastIdForSeat(seat, { 2: '9_YqpIYrUTM' })).toBe('9_YqpIYrUTM');
  });
});
