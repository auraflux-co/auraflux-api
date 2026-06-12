const { computeAssignments, GRID_SIZE } = require('../lib/live_grid/poller');

const empty = () => [null, null, null, null];

describe('live_grid computeAssignments', () => {
  test('fills empty grid with top 4 by viewers', () => {
    const live = { a: 100, b: 500, c: 50, d: 300, e: 200 };
    const { assignments, swaps } = computeAssignments(empty(), live, {});
    expect(assignments).toEqual(['b', 'd', 'e', 'a']);
    expect(swaps).toHaveLength(GRID_SIZE);
    expect(swaps.every(s => s.reason === 'fill')).toBe(true);
  });

  test('fewer than 4 live leaves null quadrants (slates)', () => {
    const live = { a: 100, b: 50 };
    const { assignments } = computeAssignments(empty(), live, {});
    expect(assignments.filter(Boolean)).toHaveLength(2);
    expect(assignments.filter(x => x === null)).toHaveLength(2);
  });

  test('offline incumbent replaced immediately by next-ranked', () => {
    const current = ['a', 'b', 'c', 'd'];
    const live = { a: 100, b: 100, c: 100, e: 40 }; // d went offline
    const { assignments, swaps } = computeAssignments(current, live, {});
    expect(assignments).toEqual(['a', 'b', 'c', 'e']);
    expect(swaps).toEqual([{ quadrant: 3, out: 'd', in: 'e', reason: 'offline' }]);
  });

  test('viewer jiggle below ratio does not reshuffle', () => {
    const current = ['a', 'b', 'c', 'd'];
    const live = { a: 100, b: 90, c: 80, d: 70, e: 80 }; // e ties c, beats d but < 1.2x
    const { assignments, swaps, streaks } = computeAssignments(current, live, {});
    expect(assignments).toEqual(current);
    expect(swaps).toEqual([]);
    expect(streaks).toEqual({});
  });

  test('challenger needs sustained streak before swapping weakest incumbent', () => {
    const current = ['a', 'b', 'c', 'd'];
    const live = { a: 100, b: 90, c: 80, d: 70, e: 95 }; // e >= 1.2x of d (84)
    let streaks = {};

    let r = computeAssignments(current, live, streaks);
    expect(r.assignments).toEqual(current);
    expect(r.streaks.e).toBe(1);

    r = computeAssignments(r.assignments, live, r.streaks);
    expect(r.assignments).toEqual(current);
    expect(r.streaks.e).toBe(2);

    r = computeAssignments(r.assignments, live, r.streaks);
    expect(r.assignments).toEqual(['a', 'b', 'c', 'e']);
    expect(r.swaps).toEqual([{ quadrant: 3, out: 'd', in: 'e', reason: 'outviewed' }]);
    expect(r.streaks.e).toBeUndefined();
  });

  test('streak resets when challenger dips below the ratio', () => {
    const current = ['a', 'b', 'c', 'd'];
    const hot = { a: 100, b: 90, c: 80, d: 70, e: 95 };
    const cool = { a: 100, b: 90, c: 80, d: 70, e: 75 };

    let r = computeAssignments(current, hot, {});
    expect(r.streaks.e).toBe(1);
    r = computeAssignments(r.assignments, cool, r.streaks);
    expect(r.streaks).toEqual({});
    r = computeAssignments(r.assignments, hot, r.streaks);
    expect(r.streaks.e).toBe(1); // started over
  });

  test('excluded streamer is never assigned and is evicted if present', () => {
    const current = ['a', 'b', 'c', 'd'];
    const live = { a: 100, b: 90, c: 80, d: 70, e: 1000 };
    const opts = { exclude: new Set(['e', 'd']) };
    const { assignments, swaps } = computeAssignments(current, live, {}, opts);
    expect(assignments).toEqual(['a', 'b', 'c', null]); // d evicted, e barred, nobody else live
    expect(swaps).toEqual([{ quadrant: 3, out: 'd', in: null, reason: 'excluded' }]);
  });

  test('offline swap and challenger streak can happen across polls without dupes', () => {
    // a..d on grid; d offline; e and f live — e takes d's slot, f starts challenging c
    const current = ['a', 'b', 'c', 'd'];
    const live = { a: 100, b: 90, c: 20, e: 50, f: 60 };
    const r = computeAssignments(current, live, {});
    expect(r.assignments).toEqual(['a', 'b', 'c', 'f']); // f outranks e for the empty slot
    // c (20) is now weakest; e (50) >= 1.2x → streak starts
    expect(r.streaks.e).toBe(1);
  });
});
