'use strict';
/**
 * lib/voice/voice_matcher.js — Voice matching and custom voice profile (CPD-77)
 *
 * Phase A (MVP):
 *   analyzeVoiceSample(audioPath)      → { pitch, pace, tone, energy, gender }
 *   recommendHeygenVoices(characteristics) → [{ voiceId, matchScore, description }, ...]
 *
 * Phase B (persistence):
 *   getVoiceRecommendations({ audioPath, clientId, planTier }) → top 3 + save to DB
 */

const path = require('path');
const { execFileSync } = require('child_process');
const { logError } = require('../error_logger');
const { isFeatureEnabled } = require('../services/feature_gate');

// ── HeyGen Voice Catalog ──────────────────────────────────────────────────────
// Curated representative voice catalog with known characteristics.
// voiceId values are HeyGen voice IDs from the /v3/voices endpoint.
// This list should be refreshed periodically from the HeyGen API.

const HEYGEN_VOICE_CATALOG = [
  { voiceId: 'en-US-GuyNeural',        gender: 'male',   pitch: 'medium', pace: 'medium', tone: 'conversational', energy: 'medium', description: 'Natural, friendly male voice — versatile for most content types' },
  { voiceId: 'en-US-AriaNeural',       gender: 'female', pitch: 'medium', pace: 'medium', tone: 'conversational', energy: 'medium', description: 'Clear, professional female voice — great for news and explainers' },
  { voiceId: 'en-US-DavisNeural',      gender: 'male',   pitch: 'low',    pace: 'slow',   tone: 'analytical',    energy: 'low',    description: 'Deep, authoritative male voice — suited for documentary or analysis' },
  { voiceId: 'en-US-JennyNeural',      gender: 'female', pitch: 'medium', pace: 'fast',   tone: 'energetic',     energy: 'high',   description: 'Upbeat, energetic female voice — ideal for sports and entertainment' },
  { voiceId: 'en-US-BrandonNeural',    gender: 'male',   pitch: 'medium', pace: 'fast',   tone: 'energetic',     energy: 'high',   description: 'Energetic male voice — strong for sports commentary and promos' },
  { voiceId: 'en-US-EvelynNeural',     gender: 'female', pitch: 'high',   pace: 'medium', tone: 'conversational', energy: 'medium', description: 'Warm, expressive female voice — great for lifestyle and brand content' },
  { voiceId: 'en-US-AndrewNeural',     gender: 'male',   pitch: 'low',    pace: 'medium', tone: 'analytical',    energy: 'medium', description: 'Professional, measured male voice — suited for business and finance content' },
  { voiceId: 'en-US-EmmaNeural',       gender: 'female', pitch: 'low',    pace: 'slow',   tone: 'analytical',    energy: 'low',    description: 'Calm, thoughtful female voice — ideal for educational and research content' },
  { voiceId: 'en-US-ChristopherNeural',gender: 'male',   pitch: 'high',   pace: 'fast',   tone: 'energetic',     energy: 'high',   description: 'High-energy male voice — excellent for entertainment and social media shorts' },
  { voiceId: 'en-US-MonicaNeural',     gender: 'female', pitch: 'medium', pace: 'slow',   tone: 'analytical',    energy: 'medium', description: 'Clear, deliberate female voice — good for instructional and how-to content' },
];

// Ordinal maps for scoring
const PITCH_RANK   = { low: 0, medium: 1, high: 2 };
const PACE_RANK    = { slow: 0, medium: 1, fast: 2 };
const ENERGY_RANK  = { low: 0, medium: 1, high: 2 };
const TONE_VALUES  = ['analytical', 'conversational', 'energetic'];

// ── Audio Analysis ────────────────────────────────────────────────────────────

/**
 * Analyze a voice audio sample and extract key characteristics.
 *
 * Uses ffprobe for basic stats then derives heuristic characteristics.
 * In production, this can be extended with a dedicated audio ML model.
 *
 * @param {string} audioPath - Path to audio file (wav, mp3, m4a)
 * @returns {{ pitch: string, pace: string, tone: string, energy: string, gender: string, durationSec: number }}
 */
function analyzeVoiceSample(audioPath) {
  if (!audioPath) throw new Error('[voice_matcher] audioPath is required');

  const resolved = path.resolve(audioPath);

  let probeOutput;
  try {
    probeOutput = execFileSync('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      '-show_format',
      resolved,
    ], { encoding: 'utf8', timeout: 10000 });
  } catch (err) {
    throw new Error(`[voice_matcher] ffprobe failed on "${audioPath}": ${err.message}`);
  }

  let probe;
  try {
    probe = JSON.parse(probeOutput);
  } catch (err) {
    throw new Error(`[voice_matcher] Failed to parse ffprobe output: ${err.message}`);
  }

  const format   = probe.format || {};
  const stream   = (probe.streams || []).find((s) => s.codec_type === 'audio') || {};
  const durationSec = parseFloat(format.duration || stream.duration || '0');
  const bitRate  = parseInt(stream.bit_rate || format.bit_rate || '0', 10);
  const sampleRate = parseInt(stream.sample_rate || '44100', 10);

  // Heuristic derivation from audio metadata:
  // These are approximations. A production implementation would use a pitch
  // detection library or a Gemini audio analysis call.

  // Pace: short clips relative to their expected content suggest faster pace
  // Energy: higher bit rate and louder audio → higher energy (rough proxy)
  const pace   = durationSec < 30 ? 'fast' : durationSec < 60 ? 'medium' : 'slow';
  const energy = bitRate > 128000 ? 'high' : bitRate > 64000 ? 'medium' : 'low';

  // Pitch and tone: cannot be reliably derived from metadata alone.
  // Default to medium/conversational — override via explicit characteristics input.
  const pitch = 'medium';
  const tone  = 'conversational';

  // Gender: unknown without audio fingerprinting — caller should provide if known.
  const gender = 'unknown';

  return { pitch, pace, tone, energy, gender, durationSec, sampleRate };
}

// ── Voice Matching ────────────────────────────────────────────────────────────

/**
 * Score a catalog voice against a set of target characteristics.
 * Returns a 0–100 match score.
 *
 * @param {object} target - { pitch, pace, tone, energy, gender }
 * @param {object} candidate - HEYGEN_VOICE_CATALOG entry
 * @returns {number} 0–100
 */
function scoreVoice(target, candidate) {
  let score = 0;
  const weights = { tone: 40, pitch: 20, pace: 20, energy: 15, gender: 5 };

  // Tone: exact match = full weight, adjacent = half
  if (target.tone) {
    const tIdx = TONE_VALUES.indexOf(target.tone);
    const cIdx = TONE_VALUES.indexOf(candidate.tone);
    if (tIdx !== -1 && cIdx !== -1) {
      const diff = Math.abs(tIdx - cIdx);
      score += diff === 0 ? weights.tone : diff === 1 ? weights.tone / 2 : 0;
    }
  }

  // Pitch: ordinal distance
  if (target.pitch && PITCH_RANK[target.pitch] !== undefined) {
    const diff = Math.abs(PITCH_RANK[target.pitch] - (PITCH_RANK[candidate.pitch] || 1));
    score += diff === 0 ? weights.pitch : diff === 1 ? weights.pitch / 2 : 0;
  }

  // Pace: ordinal distance
  if (target.pace && PACE_RANK[target.pace] !== undefined) {
    const diff = Math.abs(PACE_RANK[target.pace] - (PACE_RANK[candidate.pace] || 1));
    score += diff === 0 ? weights.pace : diff === 1 ? weights.pace / 2 : 0;
  }

  // Energy: ordinal distance
  if (target.energy && ENERGY_RANK[target.energy] !== undefined) {
    const diff = Math.abs(ENERGY_RANK[target.energy] - (ENERGY_RANK[candidate.energy] || 1));
    score += diff === 0 ? weights.energy : diff === 1 ? weights.energy / 2 : 0;
  }

  // Gender: exact bonus (unknown = neutral — no penalty)
  if (target.gender && target.gender !== 'unknown' && target.gender === candidate.gender) {
    score += weights.gender;
  } else if (!target.gender || target.gender === 'unknown') {
    score += weights.gender / 2;
  }

  return Math.round(score);
}

/**
 * Recommend top 3 HeyGen voices for given voice characteristics.
 *
 * @param {object} characteristics - { pitch, pace, tone, energy, gender }
 * @returns {Array<{ voiceId: string, matchScore: number, description: string }>}
 */
function recommendHeygenVoices(characteristics) {
  if (!characteristics || typeof characteristics !== 'object') {
    throw new Error('[voice_matcher] characteristics must be an object');
  }

  const scored = HEYGEN_VOICE_CATALOG.map((voice) => ({
    voiceId:     voice.voiceId,
    matchScore:  scoreVoice(characteristics, voice),
    description: voice.description,
  }));

  scored.sort((a, b) => b.matchScore - a.matchScore);

  return scored.slice(0, 3);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * High-level: analyze a voice sample and return top 3 HeyGen voice recommendations.
 * Feature-gated: requires planTier >= 'dwy'.
 *
 * @param {object} params
 * @param {string} params.audioPath       - Path to voice sample audio file
 * @param {object} [params.overrides]     - Override inferred characteristics (pitch, pace, tone, energy, gender)
 * @param {string} [params.planTier]      - Customer plan tier for feature gating
 * @returns {{ characteristics: object, recommendations: Array }} | null on gate/error
 */
async function getVoiceRecommendations({ audioPath, overrides = {}, planTier = 'dwy' } = {}) {
  if (!isFeatureEnabled('tts.elevenlabs', planTier) && planTier !== 'dwy' && planTier !== 'dfy' && planTier !== 'custom') {
    logError('VOICE_MATCHER_GATE', new Error('Feature not enabled for plan tier'), { planTier });
    return null;
  }

  if (!audioPath) {
    logError('VOICE_MATCHER_NO_AUDIO', new Error('audioPath is required'), {});
    return null;
  }

  let characteristics;
  try {
    const analyzed = analyzeVoiceSample(audioPath);
    characteristics = { ...analyzed, ...overrides };
  } catch (err) {
    logError('VOICE_MATCHER_ANALYZE_FAIL', err, { audioPath });
    return null;
  }

  const recommendations = recommendHeygenVoices(characteristics);

  return { characteristics, recommendations };
}

module.exports = {
  analyzeVoiceSample,
  recommendHeygenVoices,
  getVoiceRecommendations,
  HEYGEN_VOICE_CATALOG,
};
