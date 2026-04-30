'use strict';
/**
 * test/portal1_clip_diagnostic.test.js
 * Unit tests for Gate 1 clip diagnostic enrichment.
 *
 * Tests the buildClipDiagnostic helper directly (exported via __test_ hook) and
 * verifies the Gate 1 QA prompt schema includes the clipMismatches field.
 */

jest.mock('../lib/db', () => ({
  saveGateFix: jest.fn().mockResolvedValue(undefined),
  resolveCanonicalJobIdSync: jest.fn((id) => id),
  getPool: jest.fn(() => ({ query: jest.fn().mockResolvedValue({ rows: [] }) })),
}));

jest.mock('../lib/clients/gemini_client', () => ({
  generateContent: jest.fn(),
  uploadFileBuffer: jest.fn().mockResolvedValue({ fileUri: 'gs://mock-uri', mimeType: 'video/mp4' }),
  waitForFileActive: jest.fn().mockResolvedValue(undefined),
  deleteFile: jest.fn().mockResolvedValue(undefined),
}));

const { __test_buildClipDiagnostic: buildClipDiagnostic, buildGate1StyleQaPrompt } =
  require('../lib/portals/portal1');

// ─── buildClipDiagnostic unit tests ──────────────────────────────────────────

describe('buildClipDiagnostic', () => {
  const clipAnalyses = [
    { analysis: 'Governor at press conference discussing wildfire evacuations', url: 'https://example.com/1.mp4' },
    { analysis: 'Aerial footage of hillside fire consuming structures', url: 'https://example.com/2.mp4' },
  ];

  test('returns empty array when no deductions have clipMismatch', () => {
    const deductions = [
      { points: -10, reason: 'Hype word found: "incredible"' },
    ];
    expect(buildClipDiagnostic(deductions, clipAnalyses)).toEqual([]);
  });

  test('returns empty array when deductions is empty', () => {
    expect(buildClipDiagnostic([], clipAnalyses)).toEqual([]);
  });

  test('enriches mismatch with gate0 clip analysis text', () => {
    const mismatch = {
      clipIndex: 1,
      sceneHeader: 'STORY1_CLIP',
      scriptClaim: 'Mayor gives a speech at city hall',
      clipActual: 'Governor at press conference',
      severity: 'soft',
    };
    const deductions = [{ points: -10, reason: 'clip mismatch', clipMismatch: mismatch }];
    const result = buildClipDiagnostic(deductions, clipAnalyses);

    expect(result).toHaveLength(1);
    expect(result[0].clipIndex).toBe(1);
    expect(result[0].sceneHeader).toBe('STORY1_CLIP');
    expect(result[0].scriptClaim).toBe('Mayor gives a speech at city hall');
    expect(result[0].clipActual).toBeTruthy();
    expect(result[0].severity).toBe('soft');
    expect(result[0].fix).toMatch(/Rewrite/);
  });

  test('falls back to gate0 analysis text when mismatch.clipActual is empty', () => {
    const mismatch = {
      clipIndex: 2,
      sceneHeader: 'STORY2_CLIP',
      scriptClaim: 'Politicians debating indoors',
      clipActual: '',
      severity: 'hard',
    };
    const deductions = [{ points: -15, reason: 'hard clip mismatch', clipMismatch: mismatch }];
    const result = buildClipDiagnostic(deductions, clipAnalyses);

    expect(result).toHaveLength(1);
    // Should use clip 2 analysis (0-based index 1)
    expect(result[0].clipActual).toContain('Aerial footage');
    expect(result[0].fix).toContain('Aerial footage');
  });

  test('caps at first 3 mismatches', () => {
    const deductions = [1, 2, 3, 4].map((i) => ({
      points: -10,
      reason: `mismatch ${i}`,
      clipMismatch: { clipIndex: i, sceneHeader: `SCENE${i}`, scriptClaim: `claim ${i}`, clipActual: `actual ${i}`, severity: 'soft' },
    }));
    // buildClipDiagnostic itself doesn't cap — the caller caps deductions to 3.
    // Verify it processes all provided mismatches (no internal cap).
    const result = buildClipDiagnostic(deductions, clipAnalyses);
    expect(result).toHaveLength(4);
  });

  test('handles missing clipAnalyses gracefully', () => {
    const mismatch = {
      clipIndex: 1,
      sceneHeader: 'CLIP',
      scriptClaim: 'something',
      clipActual: 'Gemini saw this',
      severity: 'soft',
    };
    const deductions = [{ points: -10, reason: 'mismatch', clipMismatch: mismatch }];
    const result = buildClipDiagnostic(deductions, []);

    expect(result).toHaveLength(1);
    expect(result[0].clipActual).toBe('Gemini saw this');
  });

  test('uses null clipActual when both mismatch.clipActual and gate0 analysis are empty', () => {
    const mismatch = {
      clipIndex: 1,
      sceneHeader: 'CLIP',
      scriptClaim: 'something',
      clipActual: '',
      severity: 'soft',
    };
    const deductions = [{ points: -10, reason: 'mismatch', clipMismatch: mismatch }];
    const result = buildClipDiagnostic(deductions, [{ analysis: '' }]);

    expect(result[0].clipActual).toBeNull();
  });
});

// ─── QA prompt schema includes clipMismatches ────────────────────────────────

describe('Gate 1 QA prompt schema', () => {
  function makeJobSpec() {
    return {
      jobId: 'test-schema',
      customerId: 'cust-test',
      contentType: 'news',
      planTier: 'dfy',
      designSpec: {
        voice: { lockedIntro: 'Welcome', lockedOutro: 'Goodbye', prohibitedWords: [], showName: 'Test Show' },
        sceneStructure: { sceneHeaders: ['INTRO', 'OUTRO'], expectedClipCount: 1 },
      },
      order: { inputs: { items: [{ title: 'Test story' }] } },
    };
  }

  test('prompt schema string contains clipMismatches field', () => {
    const { qaPrompt } = buildGate1StyleQaPrompt(makeJobSpec(), 'some script', {}, {});
    expect(qaPrompt).toContain('"clipMismatches"');
    expect(qaPrompt).toContain('"clipIndex"');
    expect(qaPrompt).toContain('"scriptClaim"');
    expect(qaPrompt).toContain('"clipActual"');
    expect(qaPrompt).toContain('"severity"');
  });

  test('prompt schema includes rules for clipMismatches', () => {
    const { qaPrompt } = buildGate1StyleQaPrompt(makeJobSpec(), 'some script', {}, {});
    expect(qaPrompt).toContain('Rules for clipMismatches');
    expect(qaPrompt).toContain('1-based');
  });
});
