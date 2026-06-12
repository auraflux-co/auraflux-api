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

describe('live_grid bench tier (CPD-951)', () => {
  const bench = new Set(['x', 'y', 'z']);

  test('bench fills quadrants the roster cannot', () => {
    const live = { a: 100, b: 50, x: 5000, y: 10 }; // only 2 roster live
    const { assignments } = computeAssignments(empty(), live, {}, { bench });
    // Roster a+b seated first despite x's 5000 viewers; bench fills the rest
    expect(assignments).toEqual(['a', 'b', 'x', 'y']);
  });

  test('roster-only when 4+ roster streamers are live', () => {
    const live = { a: 100, b: 90, c: 80, d: 70, x: 9999 };
    const { assignments } = computeAssignments(empty(), live, {}, { bench });
    expect(assignments).toEqual(['a', 'b', 'c', 'd']);
  });

  test('roster streamer going live preempts weakest bench incumbent immediately', () => {
    const current = ['a', 'b', 'x', 'y'];
    const live = { a: 100, b: 90, x: 500, y: 30, c: 10 }; // c (roster) just went live
    const { assignments, swaps } = computeAssignments(current, live, {}, { bench });
    expect(assignments).toEqual(['a', 'b', 'x', 'c']); // y (weakest bench) out, no streak needed
    expect(swaps).toEqual([{ quadrant: 3, out: 'y', in: 'c', reason: 'roster_priority' }]);
  });

  test('bench challenger cannot unseat roster incumbents, only bench (with hysteresis)', () => {
    const current = ['a', 'b', 'c', 'x'];
    const live = { a: 100, b: 90, c: 20, x: 30, y: 5000 }; // y is bench
    let r = computeAssignments(current, live, {}, { bench });
    expect(r.assignments).toEqual(current); // no instant swap
    expect(r.streaks.y).toBe(1);            // streak vs x (weakest bench), NOT c
    r = computeAssignments(r.assignments, live, r.streaks, { bench });
    r = computeAssignments(r.assignments, live, r.streaks, { bench });
    expect(r.assignments).toEqual(['a', 'b', 'c', 'y']); // x displaced after streak
    expect(r.swaps).toEqual([{ quadrant: 3, out: 'x', in: 'y', reason: 'outviewed' }]);
  });

  test('all-bench grid drains as roster streamers come online', () => {
    const current = ['x', 'y', 'z', null];
    const live = { x: 100, y: 90, z: 80, a: 5, b: 3 };
    const { assignments, swaps } = computeAssignments(current, live, {}, { bench });
    // a fills the empty slot, b preempts weakest bench (z)
    expect(assignments).toEqual(['x', 'y', 'b', 'a']);
    expect(swaps).toContainEqual({ quadrant: 3, out: null, in: 'a', reason: 'fill' });
    expect(swaps).toContainEqual({ quadrant: 2, out: 'z', in: 'b', reason: 'roster_priority' });
  });
});
