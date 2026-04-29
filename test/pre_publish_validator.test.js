'use strict';
/**
 * test/pre_publish_validator.test.js — CPD-31
 */

const {
  LIMITS,
  validatePublishCopy,
  sanitizePublishCopy,
  countRunes,
  byteLength,
  countHashtags,
} = require('../lib/services/pre_publish_validator');

// ─── Helpers ──────────────────────────────────────────────────────────────────

describe('countRunes', () => {
  it('counts ASCII chars as 1 rune each', () => {
    expect(countRunes('hello')).toBe(5);
  });
  it('counts emoji as 2 runes (surrogate pairs)', () => {
    expect(countRunes('😂')).toBe(2);
    expect(countRunes('a😂b')).toBe(4);
  });
  it('returns 0 for empty/null', () => {
    expect(countRunes('')).toBe(0);
    expect(countRunes(null)).toBe(0);
    expect(countRunes(undefined)).toBe(0);
  });
});

describe('byteLength', () => {
  it('counts ASCII as 1 byte', () => {
    expect(byteLength('hello')).toBe(5);
  });
  it('counts emoji as 4 bytes (UTF-8)', () => {
    expect(byteLength('😂')).toBe(4);
  });
  it('returns 0 for empty', () => {
    expect(byteLength('')).toBe(0);
    expect(byteLength(null)).toBe(0);
  });
});

describe('countHashtags', () => {
  it('counts #-prefixed words', () => {
    expect(countHashtags('Hello #World #Test')).toBe(2);
  });
  it('returns 0 for no hashtags', () => {
    expect(countHashtags('no tags here')).toBe(0);
    expect(countHashtags(null)).toBe(0);
  });
});

// ─── validatePublishCopy ──────────────────────────────────────────────────────

describe('validatePublishCopy — passing', () => {
  it('returns valid:true for empty payload', () => {
    expect(validatePublishCopy({})).toEqual({ valid: true, violations: [] });
  });

  it('passes a valid YouTube payload', () => {
    const result = validatePublishCopy({
      youtube: {
        title:       'Short Title',
        description: 'A short description.',
        tags:        ['tag1', 'tag2'],
      },
    });
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('passes a valid TikTok payload', () => {
    expect(validatePublishCopy({ tiktok: { caption: 'Hello world #clip' } })).toMatchObject({ valid: true });
  });

  it('passes a valid Instagram payload', () => {
    expect(validatePublishCopy({ instagram: { caption: 'Hello #world' } })).toMatchObject({ valid: true });
  });
});

describe('validatePublishCopy — YouTube violations', () => {
  it('fails when title > 100 chars', () => {
    const title = 'A'.repeat(101);
    const result = validatePublishCopy({ youtube: { title } });
    expect(result.valid).toBe(false);
    expect(result.violations[0].field).toBe('title');
    expect(result.violations[0].current).toBe(101);
    expect(result.violations[0].limit).toBe(LIMITS.youtube.title.max);
  });

  it('passes when title is exactly 100 chars', () => {
    const title = 'A'.repeat(100);
    expect(validatePublishCopy({ youtube: { title } }).valid).toBe(true);
  });

  it('fails when description > 5000 bytes', () => {
    const description = 'A'.repeat(5001);
    const result = validatePublishCopy({ youtube: { description } });
    expect(result.valid).toBe(false);
    expect(result.violations[0].field).toBe('description');
  });

  it('fails when tags combined length > 500 chars', () => {
    const tags = Array(50).fill('a'.repeat(11));
    const result = validatePublishCopy({ youtube: { tags } });
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.field === 'tags')).toBe(true);
  });

  it('reports multiple violations when multiple fields fail', () => {
    const result = validatePublishCopy({
      youtube: {
        title:       'A'.repeat(101),
        description: 'B'.repeat(5001),
      },
    });
    expect(result.violations.length).toBeGreaterThanOrEqual(2);
  });
});

describe('validatePublishCopy — TikTok violations', () => {
  it('fails when caption > 2200 runes', () => {
    const caption = 'a'.repeat(2201);
    const result = validatePublishCopy({ tiktok: { caption } });
    expect(result.valid).toBe(false);
    expect(result.violations[0].field).toBe('caption');
    expect(result.violations[0].platform).toBe('tiktok');
  });

  it('passes when caption is exactly 2200 chars (ASCII runes = chars)', () => {
    const caption = 'a'.repeat(2200);
    expect(validatePublishCopy({ tiktok: { caption } }).valid).toBe(true);
  });

  it('counts emoji runes correctly for TikTok limit', () => {
    // 1100 emoji = 2200 runes (each emoji = 2 UTF-16 code units)
    const caption = '😂'.repeat(1100);
    expect(validatePublishCopy({ tiktok: { caption } }).valid).toBe(true);
    // 1101 emoji = 2202 runes — over limit
    const over = '😂'.repeat(1101);
    expect(validatePublishCopy({ tiktok: { caption: over } }).valid).toBe(false);
  });
});

describe('validatePublishCopy — Instagram violations', () => {
  it('fails when caption > 2200 chars', () => {
    const caption = 'a'.repeat(2201);
    const result = validatePublishCopy({ instagram: { caption } });
    expect(result.valid).toBe(false);
    expect(result.violations[0].field).toBe('caption');
    expect(result.violations[0].platform).toBe('instagram');
  });

  it('fails when hashtag count > 30', () => {
    const caption = Array(31).fill('#tag').join(' ');
    const result = validatePublishCopy({ instagram: { caption } });
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.field === 'hashtags')).toBe(true);
  });

  it('passes with exactly 30 hashtags', () => {
    const caption = Array(30).fill('#tag').join(' ');
    expect(validatePublishCopy({ instagram: { caption } }).valid).toBe(true);
  });

  it('fails when Reels file > 300 MB', () => {
    const result = validatePublishCopy({ instagram: { fileSizeMB: 301 } });
    expect(result.valid).toBe(false);
    expect(result.violations[0].field).toBe('fileSizeMB');
  });

  it('fails when Reels duration > 900 seconds', () => {
    const result = validatePublishCopy({ instagram: { durationSecs: 901 } });
    expect(result.valid).toBe(false);
    expect(result.violations[0].field).toBe('durationSecs');
  });
});

// ─── sanitizePublishCopy ──────────────────────────────────────────────────────

describe('sanitizePublishCopy', () => {
  it('truncates YouTube title to 97+... chars when over 100', () => {
    const payload = { youtube: { title: 'A'.repeat(105), titles: ['A'.repeat(105)] } };
    const sanitized = sanitizePublishCopy(payload);
    expect(sanitized.youtube.title.length).toBeLessThanOrEqual(100);
    expect(sanitized.youtube.title.endsWith('...')).toBe(true);
    expect(sanitized.youtube.titles[0]).toBe(sanitized.youtube.title);
  });

  it('trims description under 5000 bytes when over', () => {
    const payload = { youtube: { description: 'A'.repeat(5100) } };
    const sanitized = sanitizePublishCopy(payload);
    expect(byteLength(sanitized.youtube.description)).toBeLessThanOrEqual(5000);
  });

  it('trims TikTok caption under 2200 runes when over', () => {
    const payload = { tiktok: { caption: 'a'.repeat(2500) } };
    const sanitized = sanitizePublishCopy(payload);
    expect(sanitized.tiktok.caption.length).toBeLessThanOrEqual(2200);
  });

  it('sanitized payload passes validation', () => {
    const payload = {
      youtube:   { title: 'A'.repeat(105), description: 'B'.repeat(5100) },
      tiktok:    { caption: 'c'.repeat(2500) },
      instagram: { caption: 'd'.repeat(2500) },
    };
    const sanitized = sanitizePublishCopy(payload);
    const result = validatePublishCopy(sanitized);
    expect(result.valid).toBe(true);
  });

  it('does not mutate the original payload', () => {
    const payload = { youtube: { title: 'A'.repeat(105) } };
    const original = JSON.parse(JSON.stringify(payload));
    sanitizePublishCopy(payload);
    expect(payload.youtube.title).toBe(original.youtube.title);
  });
});
