'use strict';

/**
 * ElevenLabs TTS extension worker — CPD-80
 * Fires after Portal 1 (script approved), before Portal 3b (assembly).
 * Generates standalone VO audio from the approved script.
 *
 * Contract:
 *   runWorker({ jobSpec }) → { passed, outcome, audioPath, charCount, voiceId, provider }
 *   isPass(result)         → result.passed === true && result.outcome === 'generated'
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { logError } = require('../error_logger');
const { isFeatureEnabled } = require('../services/feature_gate');

const DEFAULT_VOICE_ID = process.env.ELEVENLABS_DEFAULT_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb'; // George
const TMP_TTS_DIR = path.join(process.cwd(), 'tmp', 'tts');

function resolveVoiceId(jobSpec) {
  return (
    jobSpec?.addOns?.tts?.voiceId ||
    jobSpec?.extensions?.tts_ext?.voiceId ||
    jobSpec?.designSpec?.voice?.elevenLabsVoiceId ||
    DEFAULT_VOICE_ID
  );
}

function resolveScript(jobSpec) {
  return (
    jobSpec?.state?.savedOutputs?.filledScript ||
    jobSpec?.filledScript ||
    jobSpec?.scaffold ||
    jobSpec?.script?.raw ||
    jobSpec?.script ||
    null
  );
}

async function runWorker({ jobSpec } = {}) {
  const jobId    = jobSpec?.jobId || 'unknown';
  const planTier = jobSpec?.planTier || 'operate';

  // Plan check: tts.elevenlabs requires dwy+
  if (!isFeatureEnabled('tts.elevenlabs', planTier)) {
    return {
      passed:    false,
      outcome:   'skip',
      reason:    `tts.elevenlabs not available on plan tier: ${planTier}`,
      audioPath: null,
      charCount: 0,
    };
  }

  // Guard: extension must be ordered
  if (!jobSpec?.addOns?.tts?.active && !jobSpec?.extensions?.tts_ext?.ordered) {
    return {
      passed: false,
      outcome: 'skip',
      reason: 'TTS extension not ordered for this job — check addOns.tts.active',
      audioPath: null,
      charCount: 0,
    };
  }

  const script = resolveScript(jobSpec);
  if (!script || typeof script !== 'string' || script.trim().length === 0) {
    logError('TTS_EXT_NO_SCRIPT', new Error('script not available'), { jobId });
    return {
      passed: false,
      outcome: 'hard_fail',
      reason: 'Script not available — Portal 1 must mark compliant before TTS extension runs',
      audioPath: null,
      charCount: 0,
    };
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    logError('TTS_EXT_NO_API_KEY', new Error('ELEVENLABS_API_KEY not set'), { jobId });
    return {
      passed: false,
      outcome: 'skip',
      reason: 'ELEVENLABS_API_KEY not configured — TTS skipped, job continues without voiceover',
      audioPath: null,
      charCount: 0,
    };
  }

  const voiceId = resolveVoiceId(jobSpec);

  // Use direct HTTP (axios) rather than the SDK — the SDK's authentication path
  // differs from the REST API and returns 401 even with a valid key on some plan tiers.
  let audioBuffer;
  let charCount = 0;
  try {
    const response = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      { text: script, model_id: 'eleven_multilingual_v2' },
      {
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg',
        },
        responseType: 'arraybuffer',
        timeout: 60000,
      }
    );
    audioBuffer = Buffer.from(response.data);
    charCount = parseInt(response.headers['x-character-count'] || '0', 10);
  } catch (err) {
    const status = err?.response?.status;
    logError('TTS_EXT_GENERATE_FAIL', err, { jobId, voiceId, status });
    // 401/403 = bad key, 429 = rate limit, 5xx = ElevenLabs down — graceful skip.
    return {
      passed: false,
      outcome: 'skip',
      reason: `ElevenLabs API error (${status || err.code}) — TTS skipped`,
      audioPath: null,
      charCount: 0,
    };
  }

  // Save audio to tmp/tts/<jobId>.mp3
  try {
    if (!fs.existsSync(TMP_TTS_DIR)) {
      fs.mkdirSync(TMP_TTS_DIR, { recursive: true });
    }
    const audioPath = path.join(TMP_TTS_DIR, `${jobId}.mp3`);
    fs.writeFileSync(audioPath, audioBuffer);

    // Record cost tracking in jobSpec state (non-blocking write-back — caller persists)
    if (jobSpec.state) {
      jobSpec.state.tts = { provider: 'elevenlabs', voiceId, charCount, audioPath, generatedAt: new Date().toISOString() };
    }

    return {
      passed: true,
      outcome: 'generated',
      audioPath,
      charCount,
      voiceId,
      provider: 'elevenlabs',
    };
  } catch (err) {
    logError('TTS_EXT_SAVE_FAIL', err, { jobId });
    return {
      passed: false,
      outcome: 'skip',
      reason: `Failed to save TTS audio — TTS skipped: ${err.message}`,
      audioPath: null,
      charCount,
    };
  }
}

function isPass(result) {
  return result?.passed === true && result?.outcome === 'generated';
}

module.exports = { runWorker, isPass };
