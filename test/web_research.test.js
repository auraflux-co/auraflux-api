'use strict';
/**
 * test/web_research.test.js — Unit tests for lib/research/web_research.js
 *
 * All external calls (Gemini API, withRetry) are mocked.
 * Tests cover: feature gate, missing key, prompt shape, JSON parsing,
 * fallback on non-JSON, graceful failure, and source capping.
 */

jest.mock('../lib/error_logger', () => ({
  logError: jest.fn(),
  withRetry: jest.fn(async (fn) => fn()),
}));

jest.mock('../lib/services/feature_gate', () => ({
  isFeatureEnabled: jest.fn(() => true),
}));

jest.mock('axios');

const axios = require('axios');
const { isFeatureEnabled } = require('../lib/services/feature_gate');
const {
  runResearch,
  buildResearchPrompt,
  parseResearchBrief,
  callGeminiWithSearch,
} = require('../lib/research/web_research');

const MOCK_BRIEF_JSON = JSON.stringify({
  topic: 'Landman Season 1 Episode 8',
  summary: 'A gripping episode exploring oil field politics.',
  keyAngles: ['character development', 'plot twist', 'industry critique'],
  supportingFacts: ['Billy Bob Thornton stars', 'Set in West Texas', 'Paramount+ show'],
  competitorCoverage: ['Variety covered the premiere', 'Hollywood Reporter gave 4 stars'],
  suggestedScriptHooks: ['What happens when loyalty meets profit?', 'The cost of oil'],
  sources: [
    { title: 'Landman Review', url: 'https://example.com/review', snippet: 'Outstanding performance' },
  ],
});

describe('buildResearchPrompt', () => {
  test('includes query, depth instruction, and source count', () => {
    const prompt = buildResearchPrompt('test topic', 'standard', 5);
    expect(prompt).toContain('test topic');
    expect(prompt).toContain('5');
    expect(prompt).toContain('concise');
  });

  test('deep depth includes comprehensive instruction', () => {
    const prompt = buildResearchPrompt('test topic', 'deep', 8);
    expect(prompt).toContain('comprehensive');
    expect(prompt).toContain('8');
  });

  test('caps sources in prompt text', () => {
    const prompt = buildResearchPrompt('topic', 'standard', 3);
    expect(prompt).toContain('3');
  });
});

describe('parseResearchBrief', () => {
  test('parses valid JSON response', () => {
    const brief = parseResearchBrief(MOCK_BRIEF_JSON, 'original query');
    expect(brief.topic).toBe('Landman Season 1 Episode 8');
    expect(brief.keyAngles).toHaveLength(3);
    expect(brief.sources).toHaveLength(1);
    expect(brief.generatedAt).toBeTruthy();
  });

  test('strips markdown fencing before parsing', () => {
    const fenced = '```json\n' + MOCK_BRIEF_JSON + '\n```';
    const brief = parseResearchBrief(fenced, 'query');
    expect(brief.topic).toBe('Landman Season 1 Episode 8');
  });

  test('falls back gracefully on non-JSON response', () => {
    const brief = parseResearchBrief('This is plain text not JSON', 'fallback topic');
    expect(brief.topic).toBe('fallback topic');
    expect(brief.summary).toContain('plain text');
    expect(brief.keyAngles).toEqual([]);
    expect(brief.rawText).toBeDefined();
  });

  test('falls back to originalQuery when topic field missing', () => {
    const noTopic = JSON.stringify({ summary: 'test', keyAngles: [] });
    const brief = parseResearchBrief(noTopic, 'my query');
    expect(brief.topic).toBe('my query');
  });

  test('caps sources array at 10', () => {
    const manySources = JSON.stringify({
      topic: 't',
      summary: 's',
      keyAngles: [],
      supportingFacts: [],
      competitorCoverage: [],
      suggestedScriptHooks: [],
      sources: Array.from({ length: 15 }, (_, i) => ({ title: `s${i}`, url: `https://${i}`, snippet: '' })),
    });
    const brief = parseResearchBrief(manySources, 'q');
    expect(brief.sources).toHaveLength(10);
  });
});

describe('runResearch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    isFeatureEnabled.mockReturnValue(true);
    process.env.GEMINI_API_KEY = 'test-key';
    axios.post = jest.fn().mockResolvedValue({
      data: {
        candidates: [{ content: { parts: [{ text: MOCK_BRIEF_JSON }] } }],
      },
    });
  });

  afterEach(() => {
    delete process.env.GEMINI_API_KEY;
  });

  test('returns structured brief on success', async () => {
    const result = await runResearch({ query: 'Landman episode 8', planTier: 'dwy' });
    expect(result.skipped).toBe(false);
    expect(result.researchBrief).toBeTruthy();
    expect(result.researchBrief.topic).toBe('Landman Season 1 Episode 8');
    expect(result.researchBrief.keyAngles).toHaveLength(3);
  });

  test('skips when feature not enabled', async () => {
    isFeatureEnabled.mockReturnValue(false);
    const result = await runResearch({ query: 'topic', planTier: 'diy' });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('feature_not_enabled');
    expect(result.researchBrief).toBeNull();
  });

  test('skips when GEMINI_API_KEY not set', async () => {
    delete process.env.GEMINI_API_KEY;
    const result = await runResearch({ query: 'topic', planTier: 'dwy' });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('GEMINI_API_KEY_not_set');
  });

  test('throws on empty query', async () => {
    await expect(runResearch({ query: '', planTier: 'dwy' })).rejects.toThrow('query is required');
  });

  test('throws on missing query', async () => {
    await expect(runResearch({ planTier: 'dwy' })).rejects.toThrow('query is required');
  });

  test('fails gracefully when Gemini throws', async () => {
    axios.post = jest.fn().mockRejectedValue(new Error('network timeout'));
    const result = await runResearch({ query: 'topic', planTier: 'dwy' });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('search_failed');
    expect(result.error).toContain('network timeout');
    expect(result.researchBrief).toBeNull();
  });

  test('caps maxSources at 10', async () => {
    await runResearch({ query: 'topic', maxSources: 99, planTier: 'dwy' });
    const calledPrompt = axios.post.mock.calls[0][1].contents[0].parts[0].text;
    expect(calledPrompt).toContain('10');
  });

  test('includes google_search tool in Gemini request', async () => {
    await runResearch({ query: 'topic', planTier: 'dwy' });
    const requestBody = axios.post.mock.calls[0][1];
    expect(requestBody.tools).toEqual(expect.arrayContaining([{ google_search: {} }]));
  });

  test('attaches generatedAt timestamp to brief', async () => {
    const result = await runResearch({ query: 'topic', planTier: 'dwy' });
    expect(result.researchBrief.generatedAt).toMatch(/^\d{4}-/);
  });
});
