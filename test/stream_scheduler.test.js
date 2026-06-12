const { parseWindow, inWindow, windowKey, decide, nextBoundary } = require('../lib/services/stream_scheduler');

const TV = { start: 12 * 60, end: 18 * 60 };     // 12pm–6pm same-day
const GRID = { start: 18 * 60, end: 3 * 60 };    // 6pm–3am overnight

const freshState = () => ({ lastStartKey: null, startAttempts: {}, wasInWindow: false });
const at = (minutes, dateKey = '2026-06-12') => ({ minutes, dateKey });

describe('parseWindow', () => {
  test('parses HH:MM-HH:MM', () => {
    expect(parseWindow('12:00-18:00')).toEqual(TV);
    expect(parseWindow('18:00-03:00')).toEqual(GRID);
  });
  test('falls back on garbage', () => {
    expect(parseWindow('nope', TV)).toEqual(TV);
    expect(parseWindow(undefined, GRID)).toEqual(GRID);
  });
  test('"off" disables the stream (CPD-994) — null even with a fallback', () => {
    expect(parseWindow('off', TV)).toBeNull();
    expect(parseWindow(' OFF ', TV)).toBeNull();
  });
});

describe('inWindow', () => {
  test('same-day window', () => {
    expect(inWindow(11 * 60 + 59, TV)).toBe(false);
    expect(inWindow(12 * 60, TV)).toBe(true);
    expect(inWindow(17 * 60 + 59, TV)).toBe(true);
    expect(inWindow(18 * 60, TV)).toBe(false);
  });
  test('overnight window spans midnight', () => {
    expect(inWindow(17 * 60 + 59, GRID)).toBe(false);
    expect(inWindow(18 * 60, GRID)).toBe(true);
    expect(inWindow(23 * 60 + 59, GRID)).toBe(true);
    expect(inWindow(0, GRID)).toBe(true);
    expect(inWindow(2 * 60 + 59, GRID)).toBe(true);
    expect(inWindow(3 * 60, GRID)).toBe(false);
  });
});

describe('windowKey', () => {
  test('same-day window keys to today', () => {
    expect(windowKey(13 * 60, TV, '2026-06-12')).toBe('2026-06-12');
  });
  test('overnight window after midnight keys to yesterday', () => {
    expect(windowKey(1 * 60, GRID, '2026-06-13')).toBe('2026-06-12');
    expect(windowKey(20 * 60, GRID, '2026-06-12')).toBe('2026-06-12');
  });
});

describe('decide', () => {
  test('starts once when window opens', () => {
    const st = freshState();
    expect(decide(at(12 * 60), TV, false, st)).toBe('start');
  });

  test('does not restart after operator stop mid-window', () => {
    const st = freshState();
    st.lastStartKey = '2026-06-12';
    st.wasInWindow = true;
    expect(decide(at(14 * 60), TV, false, st)).toBe(null);
  });

  test('starts again the NEXT day', () => {
    const st = freshState();
    st.lastStartKey = '2026-06-12';
    expect(decide(at(12 * 60 + 5, '2026-06-13'), TV, false, st)).toBe('start');
  });

  test('stops on boundary crossing when running', () => {
    const st = freshState();
    st.wasInWindow = true;
    expect(decide(at(18 * 60), TV, true, st)).toBe('stop');
  });

  test('never stops a stream running entirely outside its window', () => {
    const st = freshState();
    st.wasInWindow = false;
    expect(decide(at(4 * 60), GRID, true, st)).toBe(null);
  });

  test('overnight stop fires at 3am', () => {
    const st = freshState();
    st.wasInWindow = true;
    st.lastStartKey = '2026-06-12';
    expect(decide(at(3 * 60, '2026-06-13'), GRID, true, st)).toBe('stop');
  });

  test('start retries capped at MAX_START_ATTEMPTS', () => {
    const st = freshState();
    st.startAttempts['2026-06-12'] = 5;
    expect(decide(at(13 * 60), TV, false, st)).toBe(null);
  });

  test('no start when already running', () => {
    const st = freshState();
    expect(decide(at(13 * 60), TV, true, st)).toBe(null);
  });
});

describe('nextBoundary', () => {
  test('inside window → next is stop', () => {
    expect(nextBoundary(at(13 * 60), TV)).toEqual({ action: 'stop', inMinutes: 5 * 60 });
  });
  test('outside window → next is start', () => {
    expect(nextBoundary(at(10 * 60), TV)).toEqual({ action: 'start', inMinutes: 2 * 60 });
  });
  test('overnight wrap', () => {
    expect(nextBoundary(at(4 * 60), GRID)).toEqual({ action: 'start', inMinutes: 14 * 60 });
  });
});
