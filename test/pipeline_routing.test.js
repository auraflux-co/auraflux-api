'use strict';

const {
  resolveProductionProfileAndContentType,
  resolveTemplateIdFromBody,
  KNOWN_CLEAN_PATHS,
  validateSubmissionAgainstPath,
} = require('../lib/pipeline_routing');

// ─── resolveProductionProfileAndContentType ─────────────────────────────────

describe('resolveProductionProfileAndContentType', () => {
  test('clips + portrait → vertical_reel', () => {
    const r = resolveProductionProfileAndContentType({ contentType: 'clips', format: 'portrait' });
    expect(r.productionProfile).toBe('vertical_reel');
    expect(r.contentType).toBe('clips');
  });

  test('clips + longform → broadcast_desk (CPD-475 regression guard)', () => {
    const r = resolveProductionProfileAndContentType({ contentType: 'clips', format: 'longform' });
    expect(r.productionProfile).toBe('broadcast_desk');
    expect(r.contentType).toBe('clips');
  });

  test('clips + format=long → broadcast_desk', () => {
    const r = resolveProductionProfileAndContentType({ contentType: 'clips', format: 'long' });
    expect(r.productionProfile).toBe('broadcast_desk');
  });

  test('clips (no format) → vertical_reel', () => {
    const r = resolveProductionProfileAndContentType({ contentType: 'clips' });
    expect(r.productionProfile).toBe('vertical_reel');
  });

  test('news → broadcast_desk', () => {
    const r = resolveProductionProfileAndContentType({ contentType: 'news' });
    expect(r.productionProfile).toBe('broadcast_desk');
    expect(r.contentType).toBe('news');
  });

  test('productionProfile:vertical_reel → contentType:clips', () => {
    const r = resolveProductionProfileAndContentType({ productionProfile: 'vertical_reel' });
    expect(r.productionProfile).toBe('vertical_reel');
    expect(r.contentType).toBe('clips');
  });

  test('empty body → broadcast_desk + news default', () => {
    const r = resolveProductionProfileAndContentType({});
    expect(r.productionProfile).toBe('broadcast_desk');
    expect(r.contentType).toBe('news');
  });
});

// ─── resolveTemplateIdFromBody ───────────────────────────────────────────────

describe('resolveTemplateIdFromBody', () => {
  test('format:portrait → short-form', () => {
    expect(resolveTemplateIdFromBody({ format: 'portrait' })).toBe('short-form');
  });

  test('format:longform → long-form', () => {
    expect(resolveTemplateIdFromBody({ format: 'longform' })).toBe('long-form');
  });

  test('format:long → long-form', () => {
    expect(resolveTemplateIdFromBody({ format: 'long' })).toBe('long-form');
  });

  test('clips (no format) → long-form (format field is the signal, not contentType)', () => {
    // No format set → falls through to long-form default.
    // Portrait/short-form requires explicit format:portrait in the submission.
    expect(resolveTemplateIdFromBody({ contentType: 'clips' })).toBe('long-form');
  });

  test('news (no format) → long-form', () => {
    expect(resolveTemplateIdFromBody({ contentType: 'news' })).toBe('long-form');
  });
});

// ─── KNOWN_CLEAN_PATHS completeness ─────────────────────────────────────────

describe('KNOWN_CLEAN_PATHS', () => {
  const expectedTemplates = [
    'tiktok_clutch',
    'youtube_deep_dive',
    'irl_story_time',
    'montage_hype_reel',
    'reaction_cut',
    'quick_guide',
  ];

  test.each(expectedTemplates)('%s has required fields', (id) => {
    const path = KNOWN_CLEAN_PATHS[id];
    expect(path).toBeDefined();
    expect(path.submission).toBeDefined();
    expect(path.expectedRouting.productionProfile).toBeDefined();
    expect(path.expectedRouting.templateId).toBeDefined();
    expect(path.outputShape.aspectRatio).toBeDefined();
  });

  test('longform templates use broadcast_desk', () => {
    expect(KNOWN_CLEAN_PATHS.youtube_deep_dive.expectedRouting.productionProfile).toBe('broadcast_desk');
    expect(KNOWN_CLEAN_PATHS.reaction_cut.expectedRouting.productionProfile).toBe('broadcast_desk');
  });

  test('portrait templates use vertical_reel', () => {
    const portraitTemplates = ['tiktok_clutch', 'irl_story_time', 'montage_hype_reel', 'quick_guide'];
    for (const id of portraitTemplates) {
      expect(KNOWN_CLEAN_PATHS[id].expectedRouting.productionProfile).toBe('vertical_reel');
    }
  });
});

// ─── validateSubmissionAgainstPath ──────────────────────────────────────────

describe('validateSubmissionAgainstPath', () => {
  test('valid tiktok_clutch submission passes', () => {
    const result = validateSubmissionAgainstPath('tiktok_clutch', {
      contentType: 'clips',
      format: 'portrait',
      platforms: ['tiktok', 'youtube', 'instagram'],
    });
    expect(result.valid).toBe(true);
  });

  test('valid youtube_deep_dive submission passes', () => {
    const result = validateSubmissionAgainstPath('youtube_deep_dive', {
      contentType: 'clips',
      format: 'longform',
      platforms: ['youtube'],
    });
    expect(result.valid).toBe(true);
  });

  test('wrong format on tiktok_clutch fails', () => {
    const result = validateSubmissionAgainstPath('tiktok_clutch', {
      contentType: 'clips',
      format: 'longform',
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test('unknown templateId passes with note (no registered path)', () => {
    const result = validateSubmissionAgainstPath('unknown_template', {
      contentType: 'clips',
      format: 'portrait',
    });
    expect(result.valid).toBe(true);
    expect(result.note).toContain('No registered clean path');
  });
});
