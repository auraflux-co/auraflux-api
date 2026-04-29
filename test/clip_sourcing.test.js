'use strict';
/**
 * test/clip_sourcing.test.js — CPD-73: Show clip sourcing module unit tests
 */

const {
  suggestClips,
  approveClipCandidates,
  buildClipManifest,
  rankCandidates,
  extractKeywordsFromScript,
  CANDIDATE_STATUS,
  MIN_RELEVANCE_SCORE,
  MAX_CANDIDATES,
} = require('../lib/clip_sourcing');

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../lib/services/feature_gate', () => ({
  isFeatureEnabled: jest.fn((feature, plan) => {
    if (feature === 'clip.sourcing') return plan === 'dwy' || plan === 'dfy' || plan === 'custom';
    return true;
  }),
}));

// Build a mock Gemini client that returns predictable moments
function makeMockGeminiClient(moments) {
  return {
    analyzeVideo: jest.fn(async () => JSON.stringify(moments)),
  };
}

const SAMPLE_MOMENTS = [
  { startTime: 10, duration: 30, description: 'Cowboys argue about oil', topics: ['oil', 'argument'], relevanceScore: 85 },
  { startTime: 60, duration: 20, description: 'Landman drives pickup', topics: ['drive', 'pickup'], relevanceScore: 45 },
  { startTime: 120, duration: 40, description: 'Deal signing scene', topics: ['deal', 'contract'], relevanceScore: 92 },
];

// ─── extractKeywordsFromScript ────────────────────────────────────────────────

describe('extractKeywordsFromScript', () => {
  it('returns empty array for empty script', () => {
    expect(extractKeywordsFromScript('')).toEqual([]);
    expect(extractKeywordsFromScript()).toEqual([]);
  });

  it('extracts most frequent words', () => {
    const script = 'oil oil oil contract contract deal cowboys landman drive drive drive drive';
    const kws = extractKeywordsFromScript(script);
    expect(kws[0]).toBe('drive'); // most frequent
    expect(kws).toContain('contract');
    expect(kws).toContain('cowboys');
  });

  it('filters stop words', () => {
    const script = 'the quick brown fox jumps over the lazy dog and the fox';
    const kws = extractKeywordsFromScript(script);
    expect(kws).not.toContain('the');
    expect(kws).not.toContain('and');
    expect(kws).not.toContain('over');
  });

  it('filters short words (length <= 3)', () => {
    const script = 'big oil and gas contracts';
    const kws = extractKeywordsFromScript(script);
    expect(kws).not.toContain('big');
    expect(kws).not.toContain('oil'); // 3 chars — filtered
    expect(kws).not.toContain('gas'); // 3 chars — filtered
  });

  it('returns at most 20 keywords', () => {
    const longScript = Array.from({ length: 100 }, (_, i) => `keyword${i}`).join(' ');
    const kws = extractKeywordsFromScript(longScript);
    expect(kws.length).toBeLessThanOrEqual(20);
  });
});

// ─── rankCandidates ───────────────────────────────────────────────────────────

describe('rankCandidates', () => {
  const candidates = [
    { id: 'a', relevanceScore: 45, status: 'pending' },
    { id: 'b', relevanceScore: 85, status: 'pending' },
    { id: 'c', relevanceScore: 10, status: 'pending' }, // below MIN threshold
    { id: 'd', relevanceScore: 92, status: 'pending' },
  ];

  it('sorts by relevanceScore descending', () => {
    const ranked = rankCandidates(candidates);
    expect(ranked[0].id).toBe('d');
    expect(ranked[1].id).toBe('b');
    expect(ranked[2].id).toBe('a');
  });

  it('filters out candidates below MIN_RELEVANCE_SCORE', () => {
    const ranked = rankCandidates(candidates);
    expect(ranked.every((c) => c.relevanceScore >= MIN_RELEVANCE_SCORE)).toBe(true);
    expect(ranked.find((c) => c.id === 'c')).toBeUndefined();
  });

  it('returns empty array for no candidates', () => {
    expect(rankCandidates([])).toEqual([]);
  });
});

// ─── approveClipCandidates ────────────────────────────────────────────────────

describe('approveClipCandidates', () => {
  const candidates = [
    { id: 'c1', relevanceScore: 90, status: 'pending' },
    { id: 'c2', relevanceScore: 60, status: 'pending' },
    { id: 'c3', relevanceScore: 75, status: 'pending' },
  ];

  it('returns correct approved and rejected splits', () => {
    const { approved, rejected } = approveClipCandidates(candidates, ['c1', 'c3']);
    expect(approved.map((c) => c.id)).toEqual(['c1', 'c3']);
    expect(rejected.map((c) => c.id)).toEqual(['c2']);
  });

  it('approved candidates have status APPROVED', () => {
    const { approved } = approveClipCandidates(candidates, ['c1']);
    expect(approved[0].status).toBe(CANDIDATE_STATUS.APPROVED);
  });

  it('rejected candidates have status REJECTED', () => {
    const { rejected } = approveClipCandidates(candidates, ['c1']);
    expect(rejected.every((c) => c.status === CANDIDATE_STATUS.REJECTED)).toBe(true);
  });

  it('empty approvedIds returns all rejected', () => {
    const { approved, rejected } = approveClipCandidates(candidates, []);
    expect(approved.length).toBe(0);
    expect(rejected.length).toBe(3);
  });

  it('throws for non-array candidates', () => {
    expect(() => approveClipCandidates(null, [])).toThrow('must be an array');
  });

  it('throws for non-array approvedIds', () => {
    expect(() => approveClipCandidates(candidates, 'c1')).toThrow('must be an array');
  });

  it('does not mutate the original candidates', () => {
    const origStatus = candidates[0].status;
    approveClipCandidates(candidates, ['c1']);
    expect(candidates[0].status).toBe(origStatus);
  });
});

// ─── buildClipManifest ────────────────────────────────────────────────────────

describe('buildClipManifest', () => {
  const approved = [
    { id: 'c1', footagePath: '/footage/landman.mp4', startTime: 10, duration: 30, tags: ['oil'], relevanceScore: 90, suggestedForSegment: 2, status: 'approved' },
    { id: 'c2', footagePath: '/footage/landman.mp4', startTime: 60, duration: 20, tags: ['deal'], relevanceScore: 75, suggestedForSegment: null, status: 'approved' },
  ];

  it('returns one manifest entry per approved candidate', () => {
    const manifest = buildClipManifest(approved);
    expect(manifest.length).toBe(2);
  });

  it('manifest entry has required fields', () => {
    const [entry] = buildClipManifest(approved);
    expect(entry).toHaveProperty('clipId');
    expect(entry).toHaveProperty('localPath');
    expect(entry).toHaveProperty('startTime');
    expect(entry).toHaveProperty('duration');
    expect(entry).toHaveProperty('tags');
    expect(entry).toHaveProperty('confidence');
    expect(entry).toHaveProperty('scriptSegmentIndex');
    expect(entry).toHaveProperty('approvedAt');
  });

  it('confidence is relevanceScore / 100', () => {
    const [entry] = buildClipManifest(approved);
    expect(entry.confidence).toBe(0.9);
  });

  it('accepts footageStorageKey opt', () => {
    const [entry] = buildClipManifest(approved, { footageStorageKey: 'r2://bucket/landman.mp4' });
    expect(entry.storageKey).toBe('r2://bucket/landman.mp4');
  });

  it('throws for non-array input', () => {
    expect(() => buildClipManifest(null)).toThrow('must be an array');
  });
});

// ─── suggestClips ─────────────────────────────────────────────────────────────

describe('suggestClips', () => {
  it('throws without showTitle', async () => {
    await expect(suggestClips({ footagePath: '/f.mp4', planTier: 'dwy' }))
      .rejects.toThrow('showTitle is required');
  });

  it('throws without footagePath', async () => {
    await expect(suggestClips({ showTitle: 'Landman', planTier: 'dwy' }))
      .rejects.toThrow('footagePath is required');
  });

  it('throws on insufficient plan', async () => {
    const { isFeatureEnabled } = require('../lib/services/feature_gate');
    isFeatureEnabled.mockImplementation((f, p) => false);
    await expect(suggestClips({ showTitle: 'Landman', footagePath: '/f.mp4', planTier: 'diy' }))
      .rejects.toThrow('plan or higher');
    // restore
    isFeatureEnabled.mockImplementation((f, p) => {
      if (f === 'clip.sourcing') return p === 'dwy' || p === 'dfy' || p === 'custom';
      return true;
    });
  });

  it('returns candidates with requiresApproval: true', async () => {
    const mockClient = makeMockGeminiClient(SAMPLE_MOMENTS);
    const result = await suggestClips({
      showTitle: 'Landman',
      footagePath: '/footage/landman.mp4',
      planTier: 'dwy',
      _geminiClient: mockClient,
    });
    expect(result.requiresApproval).toBe(true);
    expect(result.showTitle).toBe('Landman');
    expect(Array.isArray(result.candidates)).toBe(true);
  });

  it('returns ranked candidates (highest score first)', async () => {
    const mockClient = makeMockGeminiClient(SAMPLE_MOMENTS);
    const { candidates } = await suggestClips({
      showTitle: 'Landman',
      footagePath: '/footage/landman.mp4',
      planTier: 'dwy',
      _geminiClient: mockClient,
    });
    // SAMPLE_MOMENTS has scores 85, 45, 92 → should rank as 92, 85, 45
    expect(candidates[0].relevanceScore).toBeGreaterThanOrEqual(candidates[1]?.relevanceScore ?? 0);
  });

  it('caps duration at 60 seconds per candidate', async () => {
    const moments = [{ startTime: 0, duration: 999, description: 'long', topics: [], relevanceScore: 80 }];
    const mockClient = makeMockGeminiClient(moments);
    const { candidates } = await suggestClips({
      showTitle: 'X', footagePath: '/f.mp4', planTier: 'dwy', _geminiClient: mockClient,
    });
    expect(candidates[0].duration).toBeLessThanOrEqual(60);
  });

  it('falls back to stub candidates when Gemini throws', async () => {
    const brokenClient = { analyzeVideo: jest.fn(async () => { throw new Error('network'); }) };
    const result = await suggestClips({
      showTitle:   'Landman',
      footagePath: '/f.mp4',
      script:      'oil deal contract cowboys drive pickup',
      planTier:    'dwy',
      _geminiClient: brokenClient,
    });
    expect(result._isStub).toBe(true);
    expect(Array.isArray(result.candidates)).toBe(true);
  });

  it('each candidate has required shape fields', async () => {
    const mockClient = makeMockGeminiClient(SAMPLE_MOMENTS);
    const { candidates } = await suggestClips({
      showTitle: 'Landman', footagePath: '/f.mp4', planTier: 'dwy', _geminiClient: mockClient,
    });
    for (const c of candidates) {
      expect(c).toHaveProperty('id');
      expect(c).toHaveProperty('footagePath');
      expect(c).toHaveProperty('startTime');
      expect(c).toHaveProperty('duration');
      expect(c).toHaveProperty('description');
      expect(c).toHaveProperty('tags');
      expect(c).toHaveProperty('relevanceScore');
      expect(c).toHaveProperty('status', CANDIDATE_STATUS.PENDING);
    }
  });

  it('respects maxCandidates option', async () => {
    // Build 10 moments
    const manyMoments = Array.from({ length: 10 }, (_, i) => ({
      startTime: i * 30, duration: 20, description: `moment ${i}`, topics: ['topic'], relevanceScore: 50 + i,
    }));
    const mockClient = makeMockGeminiClient(manyMoments);
    const { candidates } = await suggestClips({
      showTitle: 'X', footagePath: '/f.mp4', planTier: 'dwy', maxCandidates: 3,
      _geminiClient: mockClient,
    });
    expect(candidates.length).toBeLessThanOrEqual(3);
  });
});
