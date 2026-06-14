'use strict';

/**
 * Unit tests for lib/portals/portal_tts_ext.js (CPD-80)
 */

const path = require('path');

jest.mock('@elevenlabs/elevenlabs-js', () => ({
  ElevenLabsClient: jest.fn().mockImplementation(() => ({
    textToSpeech: {
      convert: jest.fn().mockReturnValue({
        withRawResponse: jest.fn().mockResolvedValue({
          data: Buffer.from('fake-audio-data'),
          rawResponse: {
            headers: { get: (h) => (h === 'x-character-count' ? '1234' : null) },
          },
        }),
      }),
    },
  })),
}));

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    existsSync: jest.fn().mockReturnValue(true),
    mkdirSync: jest.fn(),
    writeFileSync: jest.fn(),
  };
});

describe('portal_tts_ext', () => {
  let runWorker, isPass;

  beforeEach(() => {
    jest.resetModules();
    process.env.ELEVENLABS_API_KEY = 'test-key';
    process.env.ELEVENLABS_DEFAULT_VOICE_ID = 'test-default-voice';
    ({ runWorker, isPass } = require('../lib/portals/portal_tts_ext'));
  });

  afterEach(() => {
    delete process.env.ELEVENLABS_API_KEY;
  });

  const baseJobSpec = {
    jobId:     'job-tts-001',
    planTier:  'diy',   // CPD-109: tts.elevenlabs available on all paid tiers
    addOns:    { tts: { active: true, voiceId: 'voice-abc' } },
    filledScript: 'Welcome to the show. Today we discuss AI news.',
    state: {},
  };

  // CPD-109: all paid tiers have tts access — credential missing still causes skip
  test('returns skip when ELEVENLABS_API_KEY is missing', async () => {
    delete process.env.ELEVENLABS_API_KEY;
    jest.resetModules();
    const { runWorker: runWorkerNoKey } = require('../lib/portals/portal_tts_ext');
    const result = await runWorkerNoKey({
      jobSpec: { jobId: 'job-cred', planTier: 'diy', addOns: { tts: { active: true } }, filledScript: 'text', state: {} },
    });
    expect(result.outcome).toBe('skip');
    expect(result.passed).toBe(false);
  });

  test('returns skip when tts not ordered', async () => {
    const result = await runWorker({
      jobSpec: { jobId: 'job-001', planTier: 'dwy', addOns: {}, filledScript: 'text', state: {} },
    });
    expect(result.outcome).toBe('skip');
    expect(result.passed).toBe(false);
  });

  test('returns hard_fail when script is missing', async () => {
    const result = await runWorker({
      jobSpec: { jobId: 'job-002', planTier: 'dwy', addOns: { tts: { active: true } }, state: {} },
    });
    expect(result.outcome).toBe('hard_fail');
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/script not available/i);
  });

  test('returns skip when ELEVENLABS_API_KEY missing (feature gate blocks)', async () => {
    delete process.env.ELEVENLABS_API_KEY;
    jest.resetModules();
    const { runWorker: rw } = require('../lib/portals/portal_tts_ext');
    const result = await rw({ jobSpec: baseJobSpec });
    // Feature gate returns skip when required env var is absent
    expect(result.outcome).toBe('skip');
    expect(result.passed).toBe(false);
  });

  test('successful generation returns passed=true', async () => {
    const result = await runWorker({ jobSpec: { ...baseJobSpec } });
    expect(result.passed).toBe(true);
    expect(result.outcome).toBe('generated');
    expect(result.charCount).toBe(1234);
    expect(result.voiceId).toBe('voice-abc');
    expect(result.provider).toBe('elevenlabs');
    expect(result.audioPath).toMatch(/job-tts-001\.mp3$/);
  });

  test('writes charCount to jobSpec.state.tts on success', async () => {
    const spec = { ...baseJobSpec, state: {} };
    await runWorker({ jobSpec: spec });
    expect(spec.state.tts).toBeDefined();
    expect(spec.state.tts.charCount).toBe(1234);
    expect(spec.state.tts.provider).toBe('elevenlabs');
  });

  test('resolves voiceId fallback chain: addOns → designSpec → default', async () => {
    const spec = {
      ...baseJobSpec,
      addOns: { tts: { active: true } }, // no voiceId
      designSpec: { voice: { elevenLabsVoiceId: 'design-voice' } },
    };
    const result = await runWorker({ jobSpec: spec });
    expect(result.voiceId).toBe('design-voice');
  });

  test('uses default voice when no voiceId in spec', async () => {
    const spec = {
      ...baseJobSpec,
      addOns: { tts: { active: true } },
    };
    const result = await runWorker({ jobSpec: spec });
    expect(result.voiceId).toBe('test-default-voice');
  });

  test('isPass returns true for generated result', () => {
    expect(isPass({ passed: true, outcome: 'generated' })).toBe(true);
  });

  test('isPass returns false for skip result', () => {
    expect(isPass({ passed: false, outcome: 'skip' })).toBe(false);
  });

  test('isPass returns false for hard_fail', () => {
    expect(isPass({ passed: false, outcome: 'hard_fail' })).toBe(false);
  });

  test('ElevenLabs API error results in hard_fail', async () => {
    jest.resetModules();
    process.env.ELEVENLABS_API_KEY = 'test-key';
    jest.mock('@elevenlabs/elevenlabs-js', () => ({
      ElevenLabsClient: jest.fn().mockImplementation(() => ({
        textToSpeech: {
          convert: jest.fn().mockReturnValue({
            withRawResponse: jest.fn().mockRejectedValue(new Error('401 Unauthorized')),
          }),
        },
      })),
    }));
    const { runWorker: rw } = require('../lib/portals/portal_tts_ext');
    const result = await rw({ jobSpec: baseJobSpec });
    expect(result.passed).toBe(false);
    expect(result.outcome).toBe('hard_fail');
    expect(result.reason).toMatch(/401 Unauthorized/);
  });
});
