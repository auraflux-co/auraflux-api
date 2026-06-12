// CPD-980: claim fixer — range parsing + mute filter
const { parseTimestamp, parseTimeRanges, buildMuteFilter } = require('../lib/services/claim_fixer');

describe('parseTimestamp', () => {
  test('parses mm:ss, h:mm:ss, and raw seconds', () => {
    expect(parseTimestamp('12:34')).toBe(754);
    expect(parseTimestamp('1:02:03')).toBe(3723);
    expect(parseTimestamp('90')).toBe(90);
  });

  test('rejects garbage', () => {
    expect(parseTimestamp('abc')).toBeNaN();
    expect(parseTimestamp('12:')).toBeNaN();
    expect(parseTimestamp('')).toBeNaN();
  });
});

describe('parseTimeRanges', () => {
  test('parses multiple ranges sorted by start', () => {
    expect(parseTimeRanges('45:00-45:40, 12:34-13:10')).toEqual([
      { start: 754, end: 790 },
      { start: 2700, end: 2740 },
    ]);
  });

  test('accepts spaces around the dash and raw seconds', () => {
    expect(parseTimeRanges('10 - 20')).toEqual([{ start: 10, end: 20 }]);
  });

  test('throws on empty input', () => {
    expect(() => parseTimeRanges('')).toThrow(/no ranges/);
  });

  test('throws when a range ends before it starts', () => {
    expect(() => parseTimeRanges('2:00-1:00')).toThrow(/ends before/);
  });

  test('throws on malformed chunk', () => {
    expect(() => parseTimeRanges('12:34')).toThrow(/expected start-end/);
  });
});

describe('buildMuteFilter', () => {
  test('single range', () => {
    expect(buildMuteFilter([{ start: 10, end: 20 }]))
      .toBe("volume=enable='between(t,10,20)':volume=0");
  });

  test('multiple ranges OR-ed together', () => {
    expect(buildMuteFilter([{ start: 10, end: 20 }, { start: 30, end: 42 }]))
      .toBe("volume=enable='between(t,10,20)+between(t,30,42)':volume=0");
  });
});
