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
  const planTier = jobSpec?.planTier || 'diy';

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
      outcome: 'hard_fail',
      reason: 'ELEVENLABS_API_KEY not configured',
      audioPath: null,
      charCount: 0,
    };
  }

  const voiceId = resolveVoiceId(jobSpec);
  let ElevenLabsClient;
  try {
    ({ ElevenLabsClient } = require('@elevenlabs/elevenlabs-js'));
  } catch (e) {
    logError('TTS_EXT_SDK_UNAVAILABLE', e, { jobId });
    return {
      passed: false,
      outcome: 'hard_fail',
      reason: `ElevenLabs SDK unavailable: ${e.message}`,
      audioPath: null,
      charCount: 0,
    };
  }

  const client = new ElevenLabsClient({ apiKey });

  let audioData;
  let charCount = 0;
  try {
    const { data, rawResponse } = await client.textToSpeech
      .convert(voiceId, {
        text: script,
        modelId: 'eleven_v3',
      })
      .withRawResponse();

    audioData = data;
    charCount = parseInt(rawResponse.headers.get('x-character-count') || '0', 10);
  } catch (err) {
    logError('TTS_EXT_GENERATE_FAIL', err, { jobId, voiceId });
    return {
      passed: false,
      outcome: 'hard_fail',
      reason: `ElevenLabs generation failed: ${err.message}`,
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
    fs.writeFileSync(audioPath, Buffer.from(audioData));

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
      outcome: 'hard_fail',
      reason: `Failed to save TTS audio: ${err.message}`,
      audioPath: null,
      charCount,
    };
  }
}

function isPass(result) {
  return result?.passed === true && result?.outcome === 'generated';
}

module.exports = { runWorker, isPass };
