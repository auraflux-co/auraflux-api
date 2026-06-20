/**
 * CPD-982: metadata sanitization for direct YouTube publish.
 * The 400 on clips-only comps had no diagnosable body; these helpers remove the
 * known 400 triggers (angle brackets, hashtag-prefixed tags, >500-char tag sets).
 */
const { _ytTags, _ytText, isBlockedTag } = require('../lib/services/youtube_direct');

describe('_ytText', () => {
  test('strips angle brackets and enforces max length', () => {
    expect(_ytText('Cool <b>clip</b> > all', 100)).toBe('Cool bclip/b  all');
    expect(_ytText('x'.repeat(200), 100)).toHaveLength(100);
  });
  test('handles null/undefined', () => {
    expect(_ytText(null, 100)).toBe('');
    expect(_ytText(undefined, 100)).toBe('');
  });
});

describe('_ytTags', () => {
  test('strips # prefixes and dedupes', () => {
    expect(_ytTags(['#twitch', 'twitch', '#gaming'])).toEqual(['twitch', 'gaming']);
  });
  test('accepts a comma/space separated string', () => {
    expect(_ytTags('#one, #two three')).toEqual(['one', 'two', 'three']);
  });
  test('drops empties and non-arrays', () => {
    expect(_ytTags(['', '#', null])).toEqual([]);
    expect(_ytTags(undefined)).toEqual([]);
    expect(_ytTags({ not: 'array' })).toEqual([]);
  });
  test('enforces the cumulative 500-char API limit with headroom', () => {
    const tags = Array.from({ length: 60 }, (_, i) => `averylongtagname${i}padpadpad`);
    const out = _ytTags(tags);
    const total = out.reduce((s, t) => s + t.length + (t.includes(' ') ? 2 : 0) + 1, 0);
    expect(total).toBeLessThanOrEqual(495);
    expect(out.length).toBeLessThan(60);
  });
  test('caps at 50 tags', () => {
    const tags = Array.from({ length: 80 }, (_, i) => `t${i}`);
    expect(_ytTags(tags).length).toBeLessThanOrEqual(50);
  });
  test('drops blocked email and businessrocket tags', () => {
    expect(_ytTags(['twitch', 'robert@businessrocket.ai', 'clipzworld'])).toEqual(['twitch', 'clipzworld']);
    expect(isBlockedTag('robert@businessrocket.ai')).toBe(true);
  });
});
