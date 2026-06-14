'use strict';
/**
 * test/script_gen_service.test.js — CPD-126
 * Unit tests for lib/script_gen_service.js (C1 API script generation).
 */

// Mock Gemini functions before requiring the module under test
jest.mock('../lib/script_gen', () => ({
  geminiAnalyzeClip: jest.fn(),
  geminiScriptGeneration: jest.fn(),
}));

const { geminiAnalyzeClip, geminiScriptGeneration } = require('../lib/script_gen');
const { generateJobScript } = require('../lib/script_gen_service');

const MOCK_SCRIPT = `=== INTRO ===
Breaking news on a major development affecting millions worldwide.

=== STORY1_CLIP ===
Earlier today, experts gathered to address the growing concern about critical infrastructure.

=== OUTRO ===
Stay tuned for more updates as this story develops. Subscribe to keep informed.`;

const baseSpec = {
  contentType: 'news',
  order: {
    topic: 'Global Infrastructure Summit',
    tone: 'professional',
    formType: 'long',
  },
  sourceConfig: { urls: ['https://example.com/clip1.mp4'] },
};

beforeEach(() => {
  jest.clearAllMocks();
  geminiAnalyzeClip.mockResolvedValue('Clip shows conference delegates discussing infrastructure policy.');
  geminiScriptGeneration.mockResolvedValue({ script: MOCK_SCRIPT });
});

describe('generateJobScript — happy path', () => {
  test('returns filledScript and orderedClipUrls for a single-URL spec', async () => {
    const result = await generateJobScript(baseSpec);

    expect(result).toHaveProperty('filledScript');
    expect(result).toHaveProperty('orderedClipUrls');
    expect(result.filledScript).toBe(MOCK_SCRIPT);
    expect(result.orderedClipUrls).toHaveLength(1);
    expect(result.orderedClipUrls[0].url).toBe('https://example.com/clip1.mp4');
    expect(result.orderedClipUrls[0].storyIndex).toBe(0);
  });

  test('calls geminiAnalyzeClip once per source URL', async () => {
    const spec = {
      ...baseSpec,
      sourceConfig: { urls: ['https://example.com/a.mp4', 'https://example.com/b.mp4'] },
    };
    geminiScriptGeneration.mockResolvedValue({ script: MOCK_SCRIPT });

    await generateJobScript(spec);

    expect(geminiAnalyzeClip).toHaveBeenCalledTimes(2);
    expect(geminiAnalyzeClip).toHaveBeenCalledWith(
      'https://example.com/a.mp4', null, 'news', expect.objectContaining({ title: 'Global Infrastructure Summit', index: 0 })
    );
  });

  test('passes contentType and tone to geminiScriptGeneration', async () => {
    await generateJobScript(baseSpec);

    expect(geminiScriptGeneration).toHaveBeenCalledWith(
      expect.stringContaining('Global Infrastructure Summit'),
      expect.stringContaining('professional'),
      expect.objectContaining({ contentType: 'news' })
    );
  });
});

describe('_extractSourceUrls priority order', () => {
  test('priority 1: sourceConfig.urls wins over order.inputs.items', async () => {
    const spec = {
      ...baseSpec,
      sourceConfig: { urls: ['https://cfg.example.com/clip.mp4'] },
      order: {
        ...baseSpec.order,
        inputs: { items: [{ url: 'https://items.example.com/clip.mp4' }] },
      },
    };
    await generateJobScript(spec);
    expect(geminiAnalyzeClip).toHaveBeenCalledWith(
      'https://cfg.example.com/clip.mp4', null, expect.any(String), expect.any(Object)
    );
    expect(geminiAnalyzeClip).not.toHaveBeenCalledWith(
      'https://items.example.com/clip.mp4', expect.anything(), expect.anything(), expect.anything()
    );
  });

  test('priority 2: order.inputs.items when sourceConfig.urls is empty', async () => {
    const spec = {
      ...baseSpec,
      sourceConfig: { urls: [] },
      order: {
        ...baseSpec.order,
        inputs: { items: [{ url: 'https://items.example.com/clip.mp4' }] },
      },
    };
    await generateJobScript(spec);
    expect(geminiAnalyzeClip).toHaveBeenCalledWith(
      'https://items.example.com/clip.mp4', null, expect.any(String), expect.any(Object)
    );
  });

  test('priority 3: order.inputs.url single-URL fallback', async () => {
    const spec = {
      ...baseSpec,
      sourceConfig: { urls: [] },
      order: {
        ...baseSpec.order,
        inputs: { url: 'https://single.example.com/clip.mp4' },
      },
    };
    await generateJobScript(spec);
    expect(geminiAnalyzeClip).toHaveBeenCalledWith(
      'https://single.example.com/clip.mp4', null, expect.any(String), expect.any(Object)
    );
  });

  test('topic-only mode succeeds with no source URLs (WAN / scheduled jobs)', async () => {
    // script_gen_service supports topic-only generation when no clip URLs are
    // provided — used by WAN video gen and scheduled jobs without pre-fetched clips.
    const spec = {
      ...baseSpec,
      sourceConfig: {},
      order: { ...baseSpec.order, inputs: {} },
    };
    const result = await generateJobScript(spec);
    expect(result).toHaveProperty('filledScript');
    expect(typeof result.filledScript).toBe('string');
    expect(result.filledScript.length).toBeGreaterThan(0);
    expect(result.orderedClipUrls).toEqual([]);
  });
});

describe('generateJobScript — Gemini analysis failure fallback', () => {
  test('falls back to placeholder description if geminiAnalyzeClip throws for one clip', async () => {
    const spec = {
      ...baseSpec,
      sourceConfig: { urls: ['https://ok.example.com/ok.mp4', 'https://bad.example.com/bad.mp4'] },
    };
    geminiAnalyzeClip
      .mockResolvedValueOnce('Analysis of first clip.')
      .mockRejectedValueOnce(new Error('Gemini timeout'));

    await generateJobScript(spec);

    // Should still call geminiScriptGeneration despite one clip failing
    expect(geminiScriptGeneration).toHaveBeenCalledTimes(1);
    const userPrompt = geminiScriptGeneration.mock.calls[0][0];
    expect(userPrompt).toContain('CLIP 1');
    expect(userPrompt).toContain('CLIP 2');
  });
});

describe('generateJobScript — Gemini script generation failure', () => {
  test('throws if geminiScriptGeneration returns empty script', async () => {
    geminiScriptGeneration.mockResolvedValue({ script: '' });
    await expect(generateJobScript(baseSpec)).rejects.toThrow('empty or unusable script');
  });

  test('throws if geminiScriptGeneration returns script shorter than 50 chars', async () => {
    geminiScriptGeneration.mockResolvedValue({ script: 'Too short.' });
    await expect(generateJobScript(baseSpec)).rejects.toThrow('empty or unusable script');
  });

  test('throws if geminiScriptGeneration itself throws', async () => {
    geminiScriptGeneration.mockRejectedValue(new Error('Gemini API error'));
    await expect(generateJobScript(baseSpec)).rejects.toThrow('Gemini API error');
  });
});
