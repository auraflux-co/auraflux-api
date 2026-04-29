'use strict';

/**
 * Unit tests for lib/services/commentary_assembly.js (CPD-74)
 * and portal3a.js commentary routing.
 */

const {
  commentaryAssemble,
  parseScriptSegments,
  matchClipToSegment,
  computeTrim,
  validateCommentaryJobSpec,
  stubClipManifest,
  TIMING_TOLERANCE_S,
} = require('../lib/services/commentary_assembly');

// ──────────────────────────────────────────────────────────────────────────────
// parseScriptSegments
// ──────────────────────────────────────────────────────────────────────────────
describe('parseScriptSegments', () => {
  test('splits on double newlines', () => {
    const script = 'Paragraph one.\n\nParagraph two.\n\nParagraph three.';
    const segs = parseScriptSegments(script);
    expect(segs).toHaveLength(3);
    expect(segs[0].index).toBe(0);
    expect(segs[0].text).toBe('Paragraph one.');
  });

  test('splits on [SCENE] markers', () => {
    const script = 'Intro text.[SCENE 1]Main body.[SCENE 2]Outro.';
    const segs = parseScriptSegments(script);
    expect(segs.length).toBeGreaterThanOrEqual(3);
  });

  test('filters empty blocks', () => {
    const script = 'Block one.\n\n\n\nBlock two.';
    const segs = parseScriptSegments(script);
    expect(segs).toHaveLength(2);
  });

  test('returns empty array for empty script', () => {
    expect(parseScriptSegments('')).toHaveLength(0);
    expect(parseScriptSegments(null)).toHaveLength(0);
  });

  test('estimatedDuration is positive', () => {
    const segs = parseScriptSegments('Hello world this is a test sentence with enough words.');
    expect(segs[0].estimatedDuration).toBeGreaterThan(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// computeTrim
// ──────────────────────────────────────────────────────────────────────────────
describe('computeTrim', () => {
  test('no trim when clip shorter than target', () => {
    const { trimStart, trimEnd, actualDuration } = computeTrim(5, 8);
    expect(trimStart).toBe(0);
    expect(trimEnd).toBe(0);
    expect(actualDuration).toBe(5);
  });

  test('trims from both ends when clip longer than target', () => {
    const { trimStart, trimEnd, actualDuration } = computeTrim(12, 8);
    expect(trimStart).toBeGreaterThan(0);
    expect(trimEnd).toBeGreaterThan(0);
    expect(actualDuration).toBeCloseTo(8, 1);
  });

  test('actualDuration within ±0.5s of target when clip is longer', () => {
    const target = 7;
    const { actualDuration } = computeTrim(15, target);
    expect(Math.abs(actualDuration - target)).toBeLessThanOrEqual(TIMING_TOLERANCE_S);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// matchClipToSegment
// ──────────────────────────────────────────────────────────────────────────────
describe('matchClipToSegment', () => {
  const clips = [
    { id: 'c1', path: '/clips/c1.mp4', scriptSegmentIndex: 0, duration: 8, confidence: 0.9 },
    { id: 'c2', path: '/clips/c2.mp4', scriptSegmentIndex: 1, duration: 6, confidence: 0.8 },
    { id: 'c3', path: '/clips/c3.mp4', scriptSegmentIndex: 0, duration: 5, confidence: 0.7 },
  ];

  test('returns best match for segment index', () => {
    const match = matchClipToSegment(0, clips, new Set());
    expect(match.id).toBe('c1'); // highest confidence for seg 0
  });

  test('skips already-used clips', () => {
    const match = matchClipToSegment(0, clips, new Set(['c1']));
    expect(match.id).toBe('c3'); // c1 used, falls back to c3
  });

  test('returns null when all clips used', () => {
    const match = matchClipToSegment(0, clips, new Set(['c1', 'c2', 'c3']));
    expect(match).toBeNull();
  });

  test('falls back to any unused clip when no exact segment match', () => {
    const match = matchClipToSegment(99, clips, new Set());
    expect(match).not.toBeNull(); // any clip is better than nothing
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// commentaryAssemble
// ──────────────────────────────────────────────────────────────────────────────
describe('commentaryAssemble', () => {
  const script = 'Topic one content.\n\nTopic two content.\n\nTopic three content.';
  const clips = [
    { id: 'c0', path: '/c0.mp4', scriptSegmentIndex: 0, duration: 10, confidence: 0.9 },
    { id: 'c1', path: '/c1.mp4', scriptSegmentIndex: 1, duration: 7, confidence: 0.85 },
    { id: 'c2', path: '/c2.mp4', scriptSegmentIndex: 2, duration: 6, confidence: 0.8 },
  ];
  const clipManifest = { clips };
  const config = { overlayMode: 'broll_full', transitions: 'cut' };

  test('returns correct segment count', () => {
    const result = commentaryAssemble(script, clipManifest, config);
    expect(result.segments).toHaveLength(3);
    expect(result.scriptSegmentCount).toBe(3);
  });

  test('all segments have required fields', () => {
    const result = commentaryAssemble(script, clipManifest, config);
    for (const seg of result.segments) {
      expect(seg).toHaveProperty('url');
      expect(seg).toHaveProperty('type', 'source_clip');
      expect(seg).toHaveProperty('overlayMode', 'broll_full');
      expect(seg).toHaveProperty('transitionIn', 'cut');
      expect(seg).toHaveProperty('targetDuration');
    }
  });

  test('matched segments have clipId set', () => {
    const result = commentaryAssemble(script, clipManifest, config);
    const matched = result.segments.filter((s) => !s.unmatched);
    expect(matched.length).toBeGreaterThan(0);
    matched.forEach((s) => expect(s.clipId).toBeDefined());
  });

  test('matchedCount equals segments with clips', () => {
    const result = commentaryAssemble(script, clipManifest, config);
    expect(result.matchedCount).toBe(3);
    expect(result.unmatched).toHaveLength(0);
  });

  test('unmatched segments when clip manifest is empty', () => {
    const result = commentaryAssemble(script, { clips: [] }, config);
    expect(result.unmatched).toHaveLength(3);
    expect(result.matchedCount).toBe(0);
  });

  test('unmatched segments still appear in output with unmatched:true', () => {
    const result = commentaryAssemble(script, { clips: [] }, config);
    result.segments.forEach((s) => {
      expect(s.unmatched).toBe(true);
      expect(s.url).toBeNull();
    });
  });

  test('totalDuration is positive', () => {
    const result = commentaryAssemble(script, clipManifest, config);
    expect(result.totalDuration).toBeGreaterThan(0);
  });

  test('returns empty result for empty script', () => {
    const result = commentaryAssemble('', clipManifest, config);
    expect(result.segments).toHaveLength(0);
    expect(result.totalDuration).toBe(0);
  });

  test('timing alignment within ±0.5s for matching clips', () => {
    const result = commentaryAssemble(script, clipManifest, config);
    const matched = result.segments.filter((s) => !s.unmatched && s.actualDuration !== undefined);
    matched.forEach((s) => {
      const drift = Math.abs(s.actualDuration - s.targetDuration);
      expect(drift).toBeLessThanOrEqual(TIMING_TOLERANCE_S + 0.01); // float tolerance
    });
  });

  test('split_screen overlayMode is propagated', () => {
    const result = commentaryAssemble(script, clipManifest, { overlayMode: 'split_screen', transitions: 'crossfade' });
    result.segments.forEach((s) => {
      expect(s.overlayMode).toBe('split_screen');
      expect(s.transitionIn).toBe('crossfade');
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// validateCommentaryJobSpec
// ──────────────────────────────────────────────────────────────────────────────
describe('validateCommentaryJobSpec', () => {
  test('valid when assembly.mode=commentary and script present', () => {
    const spec = { assembly: { mode: 'commentary' }, filledScript: 'Some text here.' };
    expect(validateCommentaryJobSpec(spec).valid).toBe(true);
  });

  test('invalid when assembly.mode is not commentary', () => {
    const spec = { assembly: { mode: 'standard' }, filledScript: 'text' };
    expect(validateCommentaryJobSpec(spec).valid).toBe(false);
  });

  test('invalid when no script in spec', () => {
    const spec = { assembly: { mode: 'commentary' } };
    const result = validateCommentaryJobSpec(spec);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/script/i);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// stubClipManifest
// ──────────────────────────────────────────────────────────────────────────────
describe('stubClipManifest', () => {
  test('generates correct number of stub clips', () => {
    const manifest = stubClipManifest(4);
    expect(manifest.clips).toHaveLength(4);
  });

  test('each stub clip has required fields', () => {
    const manifest = stubClipManifest(3);
    manifest.clips.forEach((c, i) => {
      expect(c.id).toBe(`stub_clip_${i}`);
      expect(c.scriptSegmentIndex).toBe(i);
      expect(c.stub).toBe(true);
      expect(c.confidence).toBeGreaterThan(0);
    });
  });

  test('source is stub', () => {
    expect(stubClipManifest(2).source).toBe('stub');
  });
});
