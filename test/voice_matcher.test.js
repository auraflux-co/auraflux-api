'use strict';
/**
 * Unit tests for lib/voice/voice_matcher.js — CPD-77
 */

jest.mock('../lib/error_logger', () => ({ logError: jest.fn() }));
jest.mock('../lib/services/feature_gate', () => ({
  isFeatureEnabled: jest.fn(() => true),
}));

const { execFileSync } = require('child_process');
jest.mock('child_process', () => ({ execFileSync: jest.fn() }));

const {
  analyzeVoiceSample,
  recommendHeygenVoices,
  getVoiceRecommendations,
  HEYGEN_VOICE_CATALOG,
} = require('../lib/voice/voice_matcher');

const { logError } = require('../lib/error_logger');
const { isFeatureEnabled } = require('../lib/services/feature_gate');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFfprobeOutput({ duration = '45.5', bit_rate = '128000', sample_rate = '44100' } = {}) {
  return JSON.stringify({
    streams: [{ codec_type: 'audio', bit_rate, sample_rate }],
    format: { duration },
  });
}

// ── analyzeVoiceSample ────────────────────────────────────────────────────────

describe('analyzeVoiceSample', () => {
  beforeEach(() => execFileSync.mockReset());

  it('throws when audioPath is empty', () => {
    expect(() => analyzeVoiceSample('')).toThrow('[voice_matcher] audioPath is required');
  });

  it('throws when ffprobe fails', () => {
    execFileSync.mockImplementation(() => { throw new Error('ffprobe not found'); });
    expect(() => analyzeVoiceSample('/tmp/sample.wav')).toThrow('[voice_matcher] ffprobe failed');
  });

  it('throws when ffprobe output is not valid JSON', () => {
    execFileSync.mockReturnValue('not-json');
    expect(() => analyzeVoiceSample('/tmp/sample.wav')).toThrow('[voice_matcher] Failed to parse');
  });

  it('returns characteristics for a medium-length medium-bitrate file', () => {
    execFileSync.mockReturnValue(makeFfprobeOutput({ duration: '45', bit_rate: '96000' }));
    const c = analyzeVoiceSample('/tmp/sample.wav');
    expect(c.pace).toBe('medium');
    expect(c.energy).toBe('medium');
    expect(c.pitch).toBe('medium');
    expect(c.tone).toBe('conversational');
    expect(c.gender).toBe('unknown');
    expect(c.durationSec).toBeCloseTo(45);
  });

  it('returns fast pace for short clips (< 30s)', () => {
    execFileSync.mockReturnValue(makeFfprobeOutput({ duration: '20' }));
    const c = analyzeVoiceSample('/tmp/sample.wav');
    expect(c.pace).toBe('fast');
  });

  it('returns slow pace for long clips (>= 60s)', () => {
    execFileSync.mockReturnValue(makeFfprobeOutput({ duration: '90' }));
    const c = analyzeVoiceSample('/tmp/sample.wav');
    expect(c.pace).toBe('slow');
  });

  it('returns high energy for high-bitrate files (> 128kbps)', () => {
    execFileSync.mockReturnValue(makeFfprobeOutput({ bit_rate: '192000' }));
    const c = analyzeVoiceSample('/tmp/sample.wav');
    expect(c.energy).toBe('high');
  });

  it('returns low energy for low-bitrate files (<= 64kbps)', () => {
    execFileSync.mockReturnValue(makeFfprobeOutput({ bit_rate: '48000' }));
    const c = analyzeVoiceSample('/tmp/sample.wav');
    expect(c.energy).toBe('low');
  });

  it('reads duration from format when streams have no duration', () => {
    const probe = JSON.stringify({
      streams: [{ codec_type: 'audio', bit_rate: '128000' }],
      format: { duration: '35', bit_rate: '100000' },
    });
    execFileSync.mockReturnValue(probe);
    const c = analyzeVoiceSample('/tmp/sample.wav');
    expect(c.durationSec).toBeCloseTo(35);
  });
});

// ── recommendHeygenVoices ─────────────────────────────────────────────────────

describe('recommendHeygenVoices', () => {
  it('throws when characteristics is not an object', () => {
    expect(() => recommendHeygenVoices(null)).toThrow('[voice_matcher] characteristics must be an object');
    expect(() => recommendHeygenVoices('fast')).toThrow('[voice_matcher] characteristics must be an object');
  });

  it('returns exactly 3 recommendations', () => {
    const recs = recommendHeygenVoices({ tone: 'energetic', pace: 'fast', energy: 'high' });
    expect(recs).toHaveLength(3);
  });

  it('returns recommendations with required fields', () => {
    const recs = recommendHeygenVoices({ tone: 'analytical' });
    for (const r of recs) {
      expect(r).toHaveProperty('voiceId');
      expect(r).toHaveProperty('matchScore');
      expect(r).toHaveProperty('description');
      expect(typeof r.matchScore).toBe('number');
      expect(r.matchScore).toBeGreaterThanOrEqual(0);
      expect(r.matchScore).toBeLessThanOrEqual(100);
    }
  });

  it('returns recommendations sorted by matchScore descending', () => {
    const recs = recommendHeygenVoices({ tone: 'conversational', pace: 'medium', energy: 'medium' });
    expect(recs[0].matchScore).toBeGreaterThanOrEqual(recs[1].matchScore);
    expect(recs[1].matchScore).toBeGreaterThanOrEqual(recs[2].matchScore);
  });

  it('prefers analytical voices when tone is analytical', () => {
    const recs = recommendHeygenVoices({ tone: 'analytical', pace: 'slow', energy: 'low' });
    const top = HEYGEN_VOICE_CATALOG.find((v) => v.voiceId === recs[0].voiceId);
    expect(['analytical', 'conversational']).toContain(top.tone);
  });

  it('prefers energetic voices when tone is energetic with fast pace', () => {
    const recs = recommendHeygenVoices({ tone: 'energetic', pace: 'fast', energy: 'high', gender: 'male' });
    const top = HEYGEN_VOICE_CATALOG.find((v) => v.voiceId === recs[0].voiceId);
    expect(['energetic', 'conversational']).toContain(top.tone);
  });

  it('gives gender bonus when gender matches candidate', () => {
    const femaleRecs = recommendHeygenVoices({ tone: 'conversational', gender: 'female' });
    const maleRecs = recommendHeygenVoices({ tone: 'conversational', gender: 'male' });
    const femaleTop = HEYGEN_VOICE_CATALOG.find((v) => v.voiceId === femaleRecs[0].voiceId);
    const maleTop = HEYGEN_VOICE_CATALOG.find((v) => v.voiceId === maleRecs[0].voiceId);
    expect(femaleTop.gender).toBe('female');
    expect(maleTop.gender).toBe('male');
  });

  it('handles unknown gender without error', () => {
    const recs = recommendHeygenVoices({ tone: 'conversational', gender: 'unknown' });
    expect(recs).toHaveLength(3);
  });

  it('handles partial characteristics (only tone set)', () => {
    const recs = recommendHeygenVoices({ tone: 'energetic' });
    expect(recs).toHaveLength(3);
    expect(recs[0].matchScore).toBeGreaterThan(0);
  });

  it('handles empty characteristics object without throwing', () => {
    const recs = recommendHeygenVoices({});
    expect(recs).toHaveLength(3);
  });
});

// ── getVoiceRecommendations ───────────────────────────────────────────────────

describe('getVoiceRecommendations', () => {
  beforeEach(() => {
    execFileSync.mockReset();
    logError.mockReset();
    isFeatureEnabled.mockReset();
    isFeatureEnabled.mockReturnValue(true);
  });

  it('returns null and logs when audioPath is null and no overrides', async () => {
    const result = await getVoiceRecommendations({ audioPath: null, planTier: 'dwy' });
    expect(result).toBeNull();
    expect(logError).toHaveBeenCalledWith('VOICE_MATCHER_NO_AUDIO', expect.any(Error), {});
  });

  it('returns null when analyze fails (ffprobe error)', async () => {
    execFileSync.mockImplementation(() => { throw new Error('ffprobe not found'); });
    const result = await getVoiceRecommendations({ audioPath: '/tmp/sample.wav', planTier: 'dwy' });
    expect(result).toBeNull();
    expect(logError).toHaveBeenCalledWith('VOICE_MATCHER_ANALYZE_FAIL', expect.any(Error), { audioPath: '/tmp/sample.wav' });
  });

  it('returns characteristics + top 3 recommendations on success', async () => {
    execFileSync.mockReturnValue(makeFfprobeOutput({ duration: '45', bit_rate: '128000' }));
    const result = await getVoiceRecommendations({ audioPath: '/tmp/sample.wav', planTier: 'dwy' });
    expect(result).not.toBeNull();
    expect(result).toHaveProperty('characteristics');
    expect(result).toHaveProperty('recommendations');
    expect(result.recommendations).toHaveLength(3);
  });

  it('overrides inferred characteristics with explicit overrides', async () => {
    execFileSync.mockReturnValue(makeFfprobeOutput({ duration: '20', bit_rate: '48000' }));
    const result = await getVoiceRecommendations({
      audioPath: '/tmp/sample.wav',
      overrides: { pace: 'slow', energy: 'high' },
      planTier: 'dwy',
    });
    expect(result.characteristics.pace).toBe('slow');
    expect(result.characteristics.energy).toBe('high');
  });
});

// ── HEYGEN_VOICE_CATALOG ──────────────────────────────────────────────────────

describe('HEYGEN_VOICE_CATALOG', () => {
  it('has at least 5 voices', () => {
    expect(HEYGEN_VOICE_CATALOG.length).toBeGreaterThanOrEqual(5);
  });

  it('all entries have required fields', () => {
    for (const voice of HEYGEN_VOICE_CATALOG) {
      expect(voice).toHaveProperty('voiceId');
      expect(voice).toHaveProperty('gender');
      expect(voice).toHaveProperty('pitch');
      expect(voice).toHaveProperty('pace');
      expect(voice).toHaveProperty('tone');
      expect(voice).toHaveProperty('energy');
      expect(voice).toHaveProperty('description');
    }
  });

  it('has both male and female voices', () => {
    const genders = new Set(HEYGEN_VOICE_CATALOG.map((v) => v.gender));
    expect(genders.has('male')).toBe(true);
    expect(genders.has('female')).toBe(true);
  });

  it('covers all three tone profiles', () => {
    const tones = new Set(HEYGEN_VOICE_CATALOG.map((v) => v.tone));
    expect(tones.has('analytical')).toBe(true);
    expect(tones.has('conversational')).toBe(true);
    expect(tones.has('energetic')).toBe(true);
  });
});
